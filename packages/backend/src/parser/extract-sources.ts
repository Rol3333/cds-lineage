import { parse, isAssociation, walkFields, walkViewElements } from "@abapify/acds";
import type {
  AssociationDeclaration,
  Cardinality,
  DataSource,
  Expression,
  FieldDefinition,
  JoinClause,
  JoinGroup,
  JoinSource,
  JoinType,
  SelectStatement,
  SetOperation,
  TypeRef,
  ViewElement,
  ViewMember,
  WordCardinality,
} from "@abapify/acds";
import type {
  EdgeRelationship,
  JoinPredicate,
  ObjectAssociation,
  ObjectColumn,
  SourceKind,
  SourceRef,
  SourceRole,
} from "@cds-visualiser/shared";

/**
 * Structural extraction of dependency sources, columns and associations from a
 * parsed CDS file, built on `@abapify/acds`. No regular expressions are used for
 * nested source structure; we walk the typed AST (primary `FROM` source, the
 * ordered join chain including parenthesized join groups, set-operation operands
 * and association declarations).
 *
 * `@abapify/acds` uses Chevrotain error recovery: invalid input yields a
 * *partial* AST plus structured errors. This matters in practice because some
 * projection-list constructs are not yet parsed, while the `FROM`/`JOIN`
 * structure and most view elements are still populated correctly. Extraction
 * therefore returns whatever structure is available together with any parse
 * errors, and leaves it to the caller to decide how to surface them.
 */

export interface ExtractedSource {
  name: string;
  role: SourceRole;
  joinType?: string;
  alias?: string;
  relationship?: EdgeRelationship;
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export interface ExtractionResult {
  objectName?: string;
  definitionKinds: string[];
  sources: ExtractedSource[];
  columns: ObjectColumn[];
  associations: ObjectAssociation[];
  /** Parser errors from `@abapify/acds` (may be non-empty on a usable AST). */
  parseErrors: ParseError[];
}

interface ViewDefinitionLike {
  name?: string;
  source?: DataSource;
  joins?: JoinClause[];
  setOperations?: SetOperation[];
  fromAssociations?: AssociationDeclaration[];
  members?: ViewMember[];
  where?: Expression;
  groupBy?: string[];
  having?: Expression;
}

const MAX_COLUMNS = 1_000;

export function extractSources(source: string): ExtractionResult {
  let parsed;
  try {
    parsed = parse(source);
  } catch (err) {
    return {
      definitionKinds: [],
      sources: [],
      columns: [],
      associations: [],
      parseErrors: [{ message: err instanceof Error ? err.message : String(err), line: 0, column: 0 }],
    };
  }

  const parseErrors: ParseError[] = parsed.errors.map((e) => ({
    message: e.message,
    line: e.line,
    column: e.column,
  }));

  const sources: ExtractedSource[] = [];
  const definitionKinds: string[] = [];
  const associations: ObjectAssociation[] = [];
  const associationKeys = new Set<string>();
  let objectName: string | undefined;

  for (const def of parsed.ast.definitions) {
    definitionKinds.push(def.kind);
    const name = (def as { name?: unknown }).name;
    if (typeof name === "string" && !objectName) objectName = name;
  }

  const usedAliases = collectUsedAliases(parsed.ast);
  const firstObject = objectName;

  for (const def of parsed.ast.definitions) {
    const view = def as unknown as ViewDefinitionLike;

    if (def.kind === "viewEntity" && view.source) {
      const scope = new Map<string, string>();
      collectSelect(view as ViewDefinitionLike & { source: DataSource; joins: JoinClause[] }, sources, "primary", scope, usedAliases);
    }

    for (const association of collectAssociations(view)) {
      const associationName = association.alias ?? association.target;
      const key = `${association.target}|${associationName}|${association.on?.source ?? ""}`;
      if (associationKeys.has(key)) continue;
      associationKeys.add(key);

      const info = associationInfo(association, usedAliases);
      associations.push(info);

      sources.push({
        name: association.target,
        role: "association",
        alias: association.alias,
        relationship: {
          kind: "association",
          alias: association.alias,
          cardinality: info.cardinality,
          associationKind: info.associationKind,
          condition: info.condition,
          left: firstObject ? [{ alias: "$projection", name: firstObject }] : [],
          right: { alias: association.alias, name: association.target },
          usedInProjection: info.usedInProjection,
          toParent: info.toParent,
          redirected: info.redirected,
          self: firstObject?.toUpperCase() === association.target.toUpperCase() || undefined,
        },
      });
    }
  }

  const columns = collectColumns(parsed.ast);

  return { objectName, definitionKinds, sources, columns, associations, parseErrors };
}

/** Determine the graph kind and expandability from parsed definition kinds. */
export function classifyDefinitionKinds(
  kinds: readonly string[],
): { kind: SourceKind; expandable: boolean } {
  if (kinds.includes("viewEntity")) return { kind: "cds", expandable: true };
  if (kinds.includes("table")) return { kind: "table", expandable: false };
  // Other CDS objects (structure, table function, …) have no FROM traversal.
  return { kind: "cds", expandable: false };
}

interface SelectLike {
  source: DataSource;
  joins: JoinClause[];
  setOperations?: SetOperation[];
}

function collectSelect(
  select: SelectLike,
  out: ExtractedSource[],
  primaryRole: SourceRole,
  scope: Map<string, string>,
  usedAliases: ReadonlySet<string>,
): void {
  if (select.source && select.source.name) {
    const ref = sourceRef(select.source);
    addScope(scope, ref);
    out.push({
      name: select.source.name,
      role: primaryRole,
      alias: select.source.alias,
      relationship: {
        kind: primaryRole === "set-operation" ? "set-operation" : "primary",
        alias: select.source.alias,
        right: ref,
        usedInProjection: true,
      },
    });
  }

  for (const join of select.joins) collectJoin(join, out, scope, usedAliases);
  for (const op of select.setOperations ?? []) {
    collectSelect(op.statement, out, "set-operation", new Map(), usedAliases);
  }
}

function collectJoin(
  join: JoinClause,
  out: ExtractedSource[],
  scope: Map<string, string>,
  usedAliases: ReadonlySet<string>,
): void {
  collectJoinSource(join.source, join.joinType, join, out, scope, usedAliases);
}

function collectJoinSource(
  src: JoinSource,
  joinType: JoinType,
  join: JoinClause | undefined,
  out: ExtractedSource[],
  scope: Map<string, string>,
  usedAliases: ReadonlySet<string>,
): void {
  if (isJoinGroup(src)) {
    collectJoinSource(src.source, joinType, join, out, scope, usedAliases);
    for (const inner of src.joins) collectJoin(inner, out, scope, usedAliases);
    return;
  }

  if (!src.name) return;

  const ref = sourceRef(src);
  const alias = ref.alias;
  const left = join ? referencedSources(join.on, scope, alias) : [];
  const predicates = join ? parsePredicates(join.on?.tokens ?? []) : [];
  const used = usedAliases.has(alias ?? src.name) || usedAliases.has(src.name);

  out.push({
    name: src.name,
    role: "join",
    joinType,
    alias,
    relationship: {
      kind: "join",
      joinType,
      alias,
      condition: join?.on?.source,
      predicates,
      left,
      right: ref,
      usedInProjection: used,
      cardinality: join?.cardinality ? formatWordCardinality(join.cardinality) : undefined,
    },
  });

  addScope(scope, ref);
}

function collectAssociations(view: ViewDefinitionLike): AssociationDeclaration[] {
  const from = view.fromAssociations ?? [];
  const members = (view.members ?? []).filter(isAssociation);
  return [...from, ...members];
}

function associationInfo(
  association: AssociationDeclaration,
  usedAliases: ReadonlySet<string>,
): ObjectAssociation {
  const name = association.alias ?? association.target;
  return {
    name,
    target: association.target,
    associationKind: association.associationKind,
    cardinality: formatAssociationCardinality(association),
    condition: association.on?.source,
    usedInProjection: usedAliases.has(name),
    toParent: association.toParent || undefined,
    redirected: association.redirected || undefined,
    defaultFilter: association.withDefaultFilter?.source,
  };
}

function collectUsedAliases(ast: ReturnType<typeof parse>["ast"]): Set<string> {
  const used = new Set<string>();
  const add = (text: string | undefined): void => {
    if (!text) return;
    for (const token of expressionTokens(text)) used.add(token);
  };

  // "Used" means contributing to the output projection. A table referenced only
  // in a join/filter condition but not selected into the view is still marked
  // unused in the UI, matching the "provides columns to the output view" rule.
  for (const { element } of walkViewElements(ast)) add(element.expression);
  return used;
}

function collectColumns(ast: ReturnType<typeof parse>["ast"]): ObjectColumn[] {
  const columns: ObjectColumn[] = [];
  const seen = new Set<string>();

  const add = (column: ObjectColumn): void => {
    if (columns.length >= MAX_COLUMNS) return;
    const key = `${column.kind}|${column.name}|${column.expression ?? ""}|${column.type ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    columns.push(column);
  };

  for (const { element } of walkViewElements(ast)) {
    add(projectionColumn(element));
  }
  for (const { field } of walkFields(ast)) {
    if (!isRealField(field)) continue;
    add(fieldColumn(field));
  }

  return columns;
}

/**
 * DDIC table DDL contains `with foreign key ...` clauses that the installed
 * parser can expose as pseudo-fields (for example `with`, `key`, `t000`).
 * Keep only fields that have a real type and are not parser keywords.
 */
function isRealField(field: FieldDefinition): boolean {
  if (!field.type) return false;
  const name = field.name.toLowerCase();
  if (name === "with" || name === "key" || name === "where" || name === "foreign") return false;
  if (field.type.kind === "named") {
    const typeName = field.type.name.toLowerCase();
    if (typeName === "foreign" || typeName === "where") return false;
  }
  return true;
}

function projectionColumn(element: ViewElement): ObjectColumn {
  const expression = element.expression;
  return {
    name: element.alias ?? lastPathSegment(expression) ?? expression,
    expression,
    type: element.type ? formatTypeRef(element.type) : undefined,
    isKey: element.isKey,
    kind: "projection",
    localized: element.localized || undefined,
    isVirtual: element.isVirtual || undefined,
    redirectedTo: element.redirectedTo?.target,
  };
}

function fieldColumn(field: FieldDefinition): ObjectColumn {
  return {
    name: field.name,
    type: formatTypeRef(field.type),
    isKey: field.isKey,
    kind: "field",
    notNull: field.notNull || undefined,
  };
}

function sourceRef(source: DataSource): SourceRef {
  return { alias: source.alias, name: source.name };
}

function addScope(scope: Map<string, string>, ref: SourceRef): void {
  if (ref.alias) scope.set(ref.alias, ref.name);
  scope.set(ref.name, ref.name);
}

function referencedSources(
  expression: Expression | undefined,
  scope: ReadonlyMap<string, string>,
  rightAlias: string | undefined,
): SourceRef[] {
  if (!expression) return [];
  const refs: SourceRef[] = [];
  const seen = new Set<string>();

  for (const token of expressionTokens(expression.source)) {
    if (token === rightAlias) continue;
    if (token === "$projection") continue;
    const name = scope.get(token);
    if (!name || seen.has(token)) continue;
    seen.add(token);
    refs.push({ alias: token, name });
  }
  return refs;
}

function parsePredicates(tokens: readonly string[]): JoinPredicate[] {
  if (tokens.length === 0) return [];

  const parts: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  let between = 0;

  for (const token of tokens) {
    if (token === "(") depth += 1;
    if (token === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && (token.toLowerCase() === "and" || token.toLowerCase() === "or")) {
      if (token.toLowerCase() === "and" && between > 0) {
        between -= 1;
        current.push(token);
        continue;
      }
      if (current.length > 0) parts.push(current);
      current = [];
      continue;
    }

    if (depth === 0 && token.toLowerCase() === "between") between += 1;
    current.push(token);
  }
  if (current.length > 0) parts.push(current);

  return parts.map(predicateFromTokens);
}

function predicateFromTokens(tokens: string[]): JoinPredicate {
  const text = formatTokens(tokens);
  const operators = ["=", "<>", "<=", ">=", "<", ">", "between", "like"];
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!.toLowerCase();
    if (token === "(") depth += 1;
    if (token === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    if (!operators.includes(token)) continue;

    const left = formatTokens(tokens.slice(0, i)).trim();
    const right = formatTokens(tokens.slice(i + 1)).trim();
    return {
      text,
      left: left || undefined,
      operator: tokens[i],
      right: right || undefined,
    };
  }

  return { text };
}

/** Join parser tokens without inserting spaces around path/function punctuation. */
function formatTokens(tokens: readonly string[]): string {
  return tokens
    .join(" ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")");
}

function expressionTokens(text: string): string[] {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

function lastPathSegment(expression: string): string | undefined {
  const clean = expression.trim();
  if (!clean) return undefined;
  const segment = clean.split(".").pop()?.trim();
  return segment && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? segment : undefined;
}

function formatTypeRef(type: TypeRef | undefined): string | undefined {
  if (!type) return undefined;
  if (type.kind === "named") return type.name;
  const args: string[] = [];
  if (type.length !== undefined) args.push(String(type.length));
  if (type.decimals !== undefined) args.push(String(type.decimals));
  return args.length > 0 ? `${type.name}(${args.join(",")})` : type.name;
}

function formatAssociationCardinality(association: AssociationDeclaration): string | undefined {
  return formatCardinality(association.cardinality) ?? formatWordCardinality(association.wordCardinality);
}

function formatCardinality(cardinality: Cardinality | undefined): string | undefined {
  if (!cardinality) return undefined;
  if (cardinality.min === undefined && cardinality.max === undefined) return "[*]";
  const min = cardinality.min ?? 0;
  const max = cardinality.max === undefined ? "*" : cardinality.max;
  return `[${min}..${max}]`;
}

function formatWordCardinality(cardinality: WordCardinality | undefined): string | undefined {
  if (!cardinality) return undefined;
  const target = cardinalityWord(cardinality.target);
  if (cardinality.source) return `${cardinalityWord(cardinality.source)} to ${target}`;
  return target;
}

function cardinalityWord(word: WordCardinality["target"]): string {
  switch (word) {
    case "exactOne":
      return "exact one";
    case "many":
      return "many";
    case "one":
      return "one";
  }
}

function isJoinGroup(src: JoinSource): src is JoinGroup {
  return (src as JoinGroup).kind === "joinGroup";
}

export type { SelectStatement };
