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
export type SourceRole = "primary" | "join" | "set-operation";

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
}

export interface DependencyGraph {
  rootId: string;
  maxDepth: number;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  warnings: string[];
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
