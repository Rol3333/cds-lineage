# Task 003 — Structured Logging Implementation

**Status:** Implemented  
**Date:** 2026-10-28  
**Plan:** [`loggin_plan.md`](loggin_plan.md)

## Summary

The backend now writes structured JSONL logs to `<repo>/logs/` with four
per-category daily files:

```
logs/
  app-YYYY-MM-DD.jsonl      # HTTP, analysis lifecycle, cache/repository, security
  sap-YYYY-MM-DD.jsonl      # every adt search/read invocation
  parse-YYYY-MM-DD.jsonl    # CDS parsing and object classification
  error-YYYY-MM-DD.jsonl    # error/fatal mirror from all channels
```

Logging is implemented with `pino`, `pino-pretty` (console only), and
`rotating-file-stream`. Every analysis can be reconstructed from its
`requestId` / `analysisId`, and SAP source payloads are never written to disk.

## Implementation

### New modules

| File | Purpose |
|---|---|
| `packages/backend/src/logging/context.ts` | `AsyncLocalStorage` context, `runWithLogContext`, correlation-ID validation |
| `packages/backend/src/logging/logger.ts` | pino setup, channel streams, daily rotation, 30-day retention, redaction, error mirroring, console fallback |

### Wiring

| File | Change |
|---|---|
| `src/config.ts` | `CDS_LOG_*` settings, thresholds, `<repo>/logs` default |
| `src/index.ts` | logger creation, real/fixture provider wiring, startup/listening/shutdown/crash events, graceful stream close |
| `src/app.ts` | `requestId` middleware, `x-request-id` response header, HTTP start/finish/error logs, analysis logger injection |
| `src/collector/collector.ts` | `analysis.start` / `analysis.finish`, per-node failures, cycles, depth/object limits, parse metrics, slow-analysis warning |
| `src/adt/adt-resolver.ts` | SAP search/read start/ok/fail/timeout, candidate selection/refusal, spawn failures, stderr previews, slow-SAP warning |
| `src/repository/repository.ts` | cache hit/miss/unreadable, save, derived regeneration, index load/rebuild/recovery |
| `src/repository/caching-provider.ts` | cache served/miss/populated, refresh fallback, persist failure |
| `src/repository/rebuild-cli.ts` | shared logger and rebuild summary |
| `.gitignore` | `logs/` |
| `README.md` | logging section, configuration, troubleshooting commands |
| `packages/backend/package.json` | `pino`, `pino-pretty`, `rotating-file-stream` |

### Behaviour

- **Correlation:** HTTP requests get a validated `x-request-id` or a generated
  UUID. The collector adds `analysisId`; each object task adds `object`/`depth`.
  All lines inherit `systemKey` and `cacheMode` where applicable.
- **Channels:** `app`, `sap`, and `parse` are separate pino loggers writing to
  their own files. `error`/`fatal` records are mirrored into `error-*.jsonl`.
- **Rotation:** local-midnight rotation via `intervalBoundary`; 30 daily files
  retained per channel. Startup also prunes files older than the retention
  window, so stale logs disappear even if the process never rotates.
- **Console:** JSONL files are always written. `CDS_LOG_PRETTY=true` (default
  when stdout is a TTY) adds colourised `pino-pretty` output.
- **Failure handling:** if the log directory cannot be created/opened, the
  backend logs JSONL to stderr and continues. Logging never fails an analysis.
- **Redaction:** `authorization`, `cookie`, `password`, `token`, and `secret`
  are censored at the logger level, including nested objects.
- **No source payloads:** SAP source is represented by `sourceBytes` and, for
  CDS parsing, a SHA-256 `sourceHash`. Stderr is truncated, ANSI-stripped, and
  scrubbed for token/password-shaped values.
- **Truncated diagnostics:** CLI stderr, parser error text, and cached failure
  messages are collapsed and capped before they reach a log field.
- **Slow-operation warnings:** SAP commands, parses, and analyses emit
  `perf.slow.*` above their thresholds.

### Event examples

```
sap.search.ok          { object, durationMs, candidateCount }
sap.read.ok            { object, operation, durationMs, stdoutBytes, sourceBytes, sourceFormat }
sap.read.failed        { object, operation, exitCode, errorCode, stderrPreview }
sap.candidate.selected { object, objectType, objectSubtype, packageName }
parse.ok               { object, sourceBytes, sourceHash, definitionKinds, dependencyCount }
parse.partial          { object, parseErrorCount, firstError }
object.classified      { object, objectType, objectSubtype, kind, metadataOnly }
analysis.finish        { nodes, edges, loaded, unknown, notExpanded, cacheHits, cacheMisses, durationMs }
cache.served           { object, cacheMode, stale, sourceBytes }
cache.miss             { object, cacheMode, reason }
cache.refresh.fallback { object, upstreamResolution }
repo.index.recovery    { systemKey, reason }
http.request.finish    { requestId, method, path, status, durationMs }
security.name.rejected { input, errorCode }
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CDS_LOG_DIR` | `<repo>/logs` | Log directory |
| `CDS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `fatal` |
| `CDS_LOG_PRETTY` | TTY detection | Pretty console output |
| `CDS_LOG_RETENTION_DAYS` | `30` | Days of files to keep |
| `CDS_LOG_STDERR_PREVIEW` | `2000` | Max stderr characters per log line |
| `CDS_LOG_SLOW_SAP_MS` | `10000` | Slow SAP threshold |
| `CDS_LOG_SLOW_PARSE_MS` | `1000` | Slow parse threshold |
| `CDS_LOG_SLOW_ANALYSIS_MS` | `30000` | Slow analysis threshold |

## Deviations from the proposal

1. **Slow SAP threshold raised from 5 s to 10 s.** Live measurement showed the
   installed CLI taking ~5.3–5.9 s per search/read, so 5 s produced a warning
   for every call. 10 s still surfaces genuinely slow calls.
2. **`pino-pretty` added as a runtime dependency.** It is only instantiated
   when `CDS_LOG_PRETTY` is enabled; files remain raw JSONL.
3. **`object.classified` is emitted at `info` for every loaded leaf.** This makes
   the DDIC table/structure/view decisions visible without enabling `debug`.

## Verification

### Automated

```
npm test            → 99 backend tests + 2 frontend tests passed
npm run typecheck   → backend, frontend, shared passed
npm run build       → frontend production build passed
```

New logging tests cover:

- per-channel routing and error mirroring;
- request/analysis/object context on every line;
- no field leakage between log calls while context is active;
- parse events routed correctly with ambient context;
- credential/token redaction;
- retention pruning;
- console fallback for an unwritable directory;
- absence of SAP source payloads;
- classified SAP read failures with stderr preview;
- concurrent analyses with isolated correlation IDs;
- on-demand log-directory creation.

### Fixture-mode smoke test

Request: `ZC_PurReqItemQRY001`, depth 2, `x-request-id: smoke-req-002`.

- 7 nodes / 6 edges.
- `app-2026-10-28.jsonl`: `analysis.start`, `analysis.finish`, `http.request.finish`,
  all carrying `smoke-req-002` and the same `analysisId`.
- `parse-2026-10-28.jsonl`: `parse.ok` events for the root, cube and
  `I_Purchaserequisition`, plus `object.classified` for `MARA`/`T001`.
- `sap-*.jsonl`: empty (fixtures bypass SAP).

### Offline cache-only smoke test

Request: `I_ChangeDocumentItem`, depth 1, `ADT_COMMAND=definitely-not-adt`.

- 2 nodes, `cacheHits=2`, `cacheMisses=0`.
- A missing object produced `cache.miss` and `analysis.node.failed`.
- `sap-*.jsonl` stayed empty, proving no SAP process was invoked.

### Live read-only SAP smoke test (`DS4`/`100`, `refresh`)

Request: `I_ChangeDocumentItem`, depth 1.

- 2 nodes / 1 edge, no warnings.
- `sap-*.jsonl`: `sap.search.ok`, `sap.candidate.selected`, `sap.read.ok` for the
  CDS source (4,937 bytes) and `CDPOS` (1,601 bytes), with durations and exit
  codes.
- `parse-*.jsonl`: `parse.ok` for the CDS source and `object.classified` for the
  table.
- No source text appeared in any log file.

### Pretty console

Verified with `CDS_LOG_PRETTY=true`; colourised output appeared on the console
while JSONL was still written to the configured log directory.

## Operational notes

- `logs/` is gitignored; logs are local operational data.
- Use `CDS_LOG_LEVEL=debug` for per-object cache hits and SAP stderr previews.
- Attach `app`, `sap`, `parse`, and `error` files for the relevant day, plus the
  `requestId`/`analysisId`, when reporting an issue.
- Daily rotation has no size cap by design. If a debug session grows too large,
  lower `CDS_LOG_LEVEL` or add an optional size guard later.
