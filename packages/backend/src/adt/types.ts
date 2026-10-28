import type { RepositoryCandidate, ResolutionStatus, SourceFormat } from "@cds-visualiser/shared";

/** Distinct ADT/retrieval failure classes. */
export type AdtErrorCode =
  | "invalid-name"
  | "not-found"
  | "empty-source"
  | "timeout"
  | "auth"
  | "connection"
  | "other";

/** Resolution-specific failure code carried alongside `resolution`. */
export type ResolutionErrorCode =
  | AdtErrorCode
  | "ambiguous"
  | "unsupported-type"
  | "search-failed"
  | "read-failed"
  | "cache-miss";

/**
 * Result of resolving one object name.
 *
 * `resolution` says what happened; `source`/`sourceFormat` are only present for
 * `resolved` objects. Unsupported/unresolved dependencies are returned as
 * results (never dropped) so the collector can preserve them as `unknown`.
 */
export interface ObjectReadResult {
  resolution: ResolutionStatus;
  name: string;
  canonicalName: string;
  /** Confirmed base ADT type, e.g. `DDLS`, `TABL`, `VIEW`. */
  objectType?: string;
  /** Confirmed ADT subtype, e.g. `DF`, `DT`, `DS`, `DV`. */
  objectSubtype?: string;
  packageName?: string;
  description?: string;
  uri?: string;
  /** Source or canonical payload text (UTF-8 normalised). */
  source?: string;
  sourceFormat?: SourceFormat;
  /** True when only metadata is available (no parseable source). */
  metadataOnly?: boolean;
  /** All exact-name search candidates, retained for diagnostics/metadata. */
  candidates?: RepositoryCandidate[];
  cacheHit?: boolean;
  /** Cached source was present but derived artifacts had to be regenerated. */
  stale?: boolean;
  /** Refresh mode failed but a previously valid cached copy was served. */
  refreshFailed?: boolean;
  errorCode?: ResolutionErrorCode;
  message?: string;
}

/**
 * The capability the collector needs. The real implementation resolves via the
 * ADT CLI; the caching implementation wraps it with the filesystem repository;
 * fixtures implement it in memory for tests and demo mode.
 */
export interface ObjectProvider {
  resolve(name: string): Promise<ObjectReadResult>;
}

/** Raw process invocation result, decoupled from Node's child_process. */
export interface ProcessResult {
  /** Exit code, or null when the process was killed (timeout/cancel) or failed to start. */
  exitCode: number | null;
  /** Raw stdout bytes (encoding auto-detected by the reader). */
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/** Minimal process adapter so tests can mock CLI invocation without spawning. */
export interface ProcessAdapter {
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProcessResult>;
}
