import { parse } from "@abapify/acds";
import type {
  DataSource,
  JoinClause,
  JoinGroup,
  JoinSource,
  SelectStatement,
  SetOperation,
} from "@abapify/acds";
import type { SourceKind, SourceRole } from "@cds-visualiser/shared";

/**
 * Structural extraction of dependency sources from a parsed CDS view entity,
 * built on `@abapify/acds`. No regular expressions are used for nested source
 * structure; we walk the typed AST (primary `FROM` source, the ordered join
 * chain including parenthesized join groups, and set-operation operands).
 *
 * `@abapify/acds` uses Chevrotain error recovery: invalid input yields a
 * *partial* AST plus structured errors. This matters in practice because some
 * projection-list constructs (notably the named-argument syntax of built-ins
 * such as `currency_conversion(amount => …)`) are not yet parsed, while the
 * `FROM`/`JOIN` structure is still populated correctly. Extraction therefore
 * returns whatever dependency structure is available together with any parse
 * errors, and leaves it to the caller to decide how to surface them — it does
 * not silently discard either the structure or the errors.
 */

export interface ExtractedSource {
  name: string;
  role: SourceRole;
  joinType?: string;
  alias?: string;
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
  /** Parser errors from `@abapify/acds` (may be non-empty on a usable AST). */
  parseErrors: ParseError[];
}

export function extractSources(source: string): ExtractionResult {
  let parsed;
  try {
    parsed = parse(source);
  } catch (err) {
    return {
      definitionKinds: [],
      sources: [],
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
  let objectName: string | undefined;

  for (const def of parsed.ast.definitions) {
    definitionKinds.push(def.kind);
    const name = (def as { name?: unknown }).name;
    if (typeof name === "string" && !objectName) objectName = name;

    if (def.kind === "viewEntity" && def.source) {
      collectSelect(def, sources, "primary");
    }
  }

  return { objectName, definitionKinds, sources, parseErrors };
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

function collectSelect(select: SelectLike, out: ExtractedSource[], primaryRole: SourceRole): void {
  if (select.source && select.source.name) {
    out.push({ name: select.source.name, role: primaryRole, alias: select.source.alias });
  }
  for (const join of select.joins) collectJoin(join, out);
  for (const op of select.setOperations ?? []) collectSetOperation(op, out);
}

function collectSetOperation(op: SetOperation, out: ExtractedSource[]): void {
  collectSelect(op.statement, out, "set-operation");
}

function collectJoin(join: JoinClause, out: ExtractedSource[]): void {
  collectJoinSource(join.source, join.joinType, out);
}

function collectJoinSource(src: JoinSource, joinType: string, out: ExtractedSource[]): void {
  if (isJoinGroup(src)) {
    collectJoinSource(src.source, joinType, out);
    for (const join of src.joins) collectJoin(join, out);
  } else if (src.name) {
    out.push({ name: src.name, role: "join", joinType, alias: src.alias });
  }
}

function isJoinGroup(src: JoinSource): src is JoinGroup {
  return (src as JoinGroup).kind === "joinGroup";
}

export type { SelectStatement };
