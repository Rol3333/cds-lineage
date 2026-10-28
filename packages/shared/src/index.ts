/**
 * Application-owned dependency graph model.
 *
 * This module is intentionally independent of React Flow and of the
 * `@abapify/acds` parser AST internals. Both the backend (which builds the
 * graph) and the frontend (which renders it) consume these types.
 *
 * Edge semantics: an edge means "the `from` object depends on the `to` object".
 * Visually the dependent (from) sits above its dependency (to).
 */

/** Broad classification of a dependency source. */
export type SourceKind = "cds" | "table" | "view" | "structure" | "unknown";

/**
 * Lifecycle/result status of a node within one analysis.
 *
 * - `loaded`       — object retrieved (or served from cache) successfully.
 * - `not-expanded` — a dependency at the maximum depth (or past a limit)
 *                    that was intentionally not expanded further.
 * - `read-error`   — object could not be resolved/retrieved (not found, auth,
 *                    timeout, unsupported type, ambiguous search match, …).
 * - `parse-error`  — CDS source retrieved but the parser reported errors.
 * - `empty-source` — source retrieved but it was empty.
 * - `unknown`      — no information available about the node.
 */
export type NodeStatus =
  | "loaded"
  | "not-expanded"
  | "read-error"
  | "parse-error"
  | "empty-source"
  | "unknown";

/**
 * Machine-readable error codes, mirroring the distinct failure classes in the
 * initial brief and the repository/resolution tasks.
 * `errorCode` is set together with a human-readable `errorMessage`.
 */
export type ErrorCode =
  | "invalid-name"
  | "adt-connection"
  | "object-not-found"
  | "empty-source"
  | "parse-failure"
  | "unknown-source"
  | "max-depth"
  | "max-objects"
  | "cache-miss"
  | "ambiguous"
  | "unsupported-type"
  | "search-failed"
  | "read-failed";

/**
 * Outcome of resolving a discovered dependency against the SAP repository.
 * `cache-miss` is produced only by the local repository in cache-only mode.
 */
export type ResolutionStatus =
  | "resolved"
  | "not-found"
  | "ambiguous"
  | "unsupported-type"
  | "search-failed"
  | "read-failed"
  | "cache-miss";

/** Local repository access policy. */
export type CacheMode = "cache-first" | "cache-only" | "refresh";

/**
 * Format of the stored source/payload.
 *
 * - `asddls`        — CDS DDL source (parsed with `@abapify/acds`).
 * - `table`         — DDIC transparent-table DDL (`adt table read`).
 * - `structure`     — DDIC structure DDL (`adt structure read`).
 * - `view-metadata` — DDIC view metadata XML. The installed ADT CLI (0.4.23)
 *                     exposes no working DDIC view source/structure reader.
 */
export type SourceFormat = "asddls" | "table" | "structure" | "view-metadata";

/** One repository-search candidate for a requested object name. */
export interface RepositoryCandidate {
  name: string;
  /** Base ADT object type, e.g. `DDLS`, `TABL`, `VIEW`. */
  objectType: string;
  /** ADT subtype, e.g. `DF`, `DT`, `DS`, `DV`. */
  objectSubtype?: string;
  packageName?: string;
  uri?: string;
  description?: string;
}

/** Role of a source relationship within its parent's SELECT structure. */
export type SourceRole = "primary" | "join" | "association" | "set-operation";

/** One output column/element of a CDS view or one field of a DDIC table/structure. */
export interface ObjectColumn {
  /** Display name: alias, field name, or final expression segment. */
  name: string;
  /** Projection expression, when the column is a CDS view element. */
  expression?: string;
  /** Formatted type, when the AST provides one. */
  type?: string;
  isKey: boolean;
  kind: "projection" | "field";
  localized?: boolean;
  isVirtual?: boolean;
  redirectedTo?: string;
  notNull?: boolean;
}

/** Association declared by a CDS view. */
export interface ObjectAssociation {
  /** Association alias, e.g. `_PRReleaseDate`. */
  name: string;
  target: string;
  associationKind: "association" | "composition";
  /** Formatted bracket or word cardinality. */
  cardinality?: string;
  condition?: string;
  /** True when the alias is referenced by an output projection element. */
  usedInProjection: boolean;
  toParent?: boolean;
  redirected?: boolean;
  defaultFilter?: string;
}

/** One parser issue attached to a node. */
export interface ParseIssue {
  message: string;
  line: number;
  column: number;
}

/** Reference to a source alias and its resolved object name. */
export interface SourceRef {
  alias?: string;
  /** Resolved object name. */
  name: string;
}

/** Best-effort decomposition of one ON-clause predicate. */
export interface JoinPredicate {
  text: string;
  left?: string;
  operator?: string;
  right?: string;
}

/** Rich relationship metadata for an edge. */
export interface EdgeRelationship {
  kind: "primary" | "join" | "association" | "set-operation";
  joinType?: string;
  alias?: string;
  cardinality?: string;
  associationKind?: "association" | "composition";
  condition?: string;
  predicates?: JoinPredicate[];
  /** Aliases/objects already in scope that participate in the condition. */
  left?: SourceRef[];
  /** Newly introduced source. */
  right?: SourceRef;
  /** Whether the source contributes at least one output column. */
  usedInProjection?: boolean;
  toParent?: boolean;
  redirected?: boolean;
  self?: boolean;
}

export type DiagnosticCategory =
  | "parse"
  | "resolution"
  | "cache"
  | "limit"
  | "cycle"
  | "metadata"
  | "request"
  | "other";

export type DiagnosticSeverity = "error" | "warning" | "info";

/** Structured diagnostic used by the Errors tab. */
export interface GraphDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  objectId?: string;
  edgeId?: string;
  line?: number;
  column?: number;
}

export interface DependencyNode {
  /** Stable identity — the canonical (upper-cased) object name. */
  id: string;
  /** Display name, as the object is known in SAP (canonical upper-case). */
  name: string;
  kind: SourceKind;
  /** ADT base type when confirmed, e.g. `DDLS`, `TABL`, `VIEW`. */
  objectType?: string;
  /** ADT subtype when confirmed, e.g. `DF`, `DT`, `DS`, `DV`. */
  objectSubtype?: string;
  /** Distance from the requested root object (root is depth 0). */
  depth: number;
  status: NodeStatus;
  /** True when the object is a CDS source that *could* be expanded. */
  expandable: boolean;
  /** How the object was resolved (or why it was not). */
  resolution?: ResolutionStatus;
  /** True when the object was served from the local repository. */
  cacheHit?: boolean;
  /** True when cached source exists but derived artifacts were stale. */
  stale?: boolean;
  errorCode?: ErrorCode;
  errorMessage?: string;
  /** Columns/elements when the source is parseable. */
  columns?: ObjectColumn[];
  /** Associations declared by this CDS view. */
  associations?: ObjectAssociation[];
  /** Parser issues for this object (partial AST still keeps dependencies). */
  parseErrors?: ParseIssue[];
  /** False when no incoming relationship contributes output columns. */
  usedInProjection?: boolean;
  /** Ids of the node's direct dependencies (for the details panel). */
  dependencies: string[];
}

export interface DependencyEdge {
  /** Stable identity for a source relationship (deterministic). */
  id: string;
  /** Dependent object id (sits above in the layout). */
  from: string;
  /** Referenced dependency id (sits below in the layout). */
  to: string;
  /** e.g. primary source or join source, when known. */
  sourceRole?: SourceRole;
  /** Normalized join type, when the edge came from a join. */
  joinType?: string;
  /** Rich relationship detail for the Details tab. */
  relationship?: EdgeRelationship;
}

export interface DependencyGraph {
  rootId: string;
  maxDepth: number;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  warnings: string[];
  /** Structured diagnostics for the Errors tab. */
  diagnostics?: GraphDiagnostic[];
}

/** Outcome of an analysis request, including limit information. */
export interface AnalyzeResult {
  graph: DependencyGraph;
  /** True when traversal stopped early due to a configured limit. */
  truncated: boolean;
  /** Which limit stopped traversal, when `truncated` is true. */
  limitReached?: "max-depth" | "max-objects";
  /** Small cache-usage summary (no filesystem paths). */
  cache?: {
    mode: CacheMode;
    systemKey?: string;
    hits: number;
    misses: number;
  };
}

/** Request body for `POST /api/analyze`. */
export interface AnalyzeRequest {
  name: string;
  maxDepth?: number;
}

/** Canonicalize an object name for use as a stable node id. */
export function canonicalName(name: string): string {
  return name.trim().toUpperCase();
}

/** Default limits, shared by backend defaults and frontend controls. */
export const DEFAULT_MAX_DEPTH = 4;
/** Hard cap: the visualiser intentionally never crawls deeper than this. */
export const MAX_DEPTH_LIMIT = 4;
export const DEFAULT_MAX_OBJECTS = 200;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_CACHE_MODE: CacheMode = "cache-first";
