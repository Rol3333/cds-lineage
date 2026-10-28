import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CACHE_MODE,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_OBJECTS,
  DEFAULT_READ_TIMEOUT_MS,
  MAX_DEPTH_LIMIT,
  type CacheMode,
} from "@cds-visualiser/shared";
import type { LogLevel } from "./logging/logger.js";
import { resolveSystemIdentity, type ResolvedSystemIdentity } from "./repository/system-key.js";

/** Repository root (the monorepo root), not `process.cwd()` (npm workspaces). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface AppConfig {
  port: number;
  /** When set, serve from bundled fixtures instead of the ADT CLI (demo/test). */
  fixtureDir?: string;
  adtCommand: string;
  readTimeoutMs: number;
  maxDepth: number;
  maxObjects: number;
  concurrency: number;
  /** Local object repository root. */
  storageRoot: string;
  /** Local repository access policy. */
  cacheMode: CacheMode;
  /** Stable SAP system identity used to partition the local repository. */
  system: ResolvedSystemIdentity;
  /** Directory for JSONL log files. */
  logDir: string;
  logLevel: LogLevel;
  /** Pretty console output in addition to JSONL files. */
  logPretty: boolean;
  logRetentionDays: number;
  logStderrPreview: number;
  logSlowSapMs: number;
  logSlowParseMs: number;
  logSlowAnalysisMs: number;
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseCacheMode(value: string | undefined): CacheMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "cache-first" || normalized === "cache-only" || normalized === "refresh") {
    return normalized;
  }
  return DEFAULT_CACHE_MODE;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "fatal"
  ) {
    return normalized;
  }
  return "info";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT);
  return {
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 8787,
    fixtureDir: env.CDS_FIXTURE_DIR?.trim() || undefined,
    adtCommand: env.ADT_COMMAND?.trim() || "adt",
    readTimeoutMs: toInt(env.ADT_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS),
    maxDepth: Math.min(toInt(env.CDS_MAX_DEPTH, DEFAULT_MAX_DEPTH), MAX_DEPTH_LIMIT),
    maxObjects: toInt(env.CDS_MAX_OBJECTS, DEFAULT_MAX_OBJECTS),
    concurrency: toInt(env.CDS_CONCURRENCY, DEFAULT_CONCURRENCY),
    storageRoot: env.CDS_REPO_ROOT?.trim()
      ? resolve(env.CDS_REPO_ROOT.trim())
      : resolve(REPO_ROOT, "storage"),
    cacheMode: parseCacheMode(env.CDS_CACHE_MODE),
    system: resolveSystemIdentity(env),
    logDir: env.CDS_LOG_DIR?.trim() ? resolve(env.CDS_LOG_DIR.trim()) : resolve(REPO_ROOT, "logs"),
    logLevel: parseLogLevel(env.CDS_LOG_LEVEL),
    logPretty: parseBoolean(env.CDS_LOG_PRETTY, process.stdout.isTTY === true),
    logRetentionDays: toInt(env.CDS_LOG_RETENTION_DAYS, 30),
    logStderrPreview: toInt(env.CDS_LOG_STDERR_PREVIEW, 2000),
    logSlowSapMs: toInt(env.CDS_LOG_SLOW_SAP_MS, 10_000),
    logSlowParseMs: toInt(env.CDS_LOG_SLOW_PARSE_MS, 1000),
    logSlowAnalysisMs: toInt(env.CDS_LOG_SLOW_ANALYSIS_MS, 30000),
  };
}

export { DEFAULT_MAX_DEPTH, MAX_DEPTH_LIMIT };
