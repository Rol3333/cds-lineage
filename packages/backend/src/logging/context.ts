import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheMode } from "@cds-visualiser/shared";

/**
 * Ambient context attached to every log line by the pino `mixin`.
 *
 * It is populated per HTTP request, per analysis, and per object so that a
 * single `requestId` / `analysisId` can join HTTP, SAP, parsing, cache and
 * repository events without threading a logger through every function.
 */
export interface LogContext {
  requestId?: string;
  analysisId?: string;
  rootObject?: string;
  object?: string;
  depth?: number;
  systemKey?: string;
  cacheMode?: CacheMode;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Current context, or an empty object outside a request/analysis. */
export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Run `fn` with `context` merged over the current context.
 *
 * Nesting is intentional: the HTTP request sets `requestId`, the collector adds
 * `analysisId`, and each object task adds `object`/`depth`.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...getLogContext(), ...context };
  // Correlation values are log-only, but callers can supply unvalidated input
  // (e.g. a rejected root name). Keep every line bounded.
  if (merged.rootObject) merged.rootObject = clip(merged.rootObject);
  if (merged.object) merged.object = clip(merged.object);
  return storage.run(merged, fn);
}

/** Strip control characters from caller-supplied correlation IDs. */
export function sanitizeCorrelationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

function clip(value: string, max = 200): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
