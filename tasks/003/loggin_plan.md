# Logging Proposal — Abapify CDS Visualiser

**Status:** Proposed  
**Date:** 2026-10-28  
**Scope:** Backend (`packages/backend`)  
**Related:** Task 002 (SAP object repository and cache)

---

## 1. Goals

1. Make SAP communication observable: every `adt` CLI invocation, its duration, exit code, timeout state, and classified failure.
2. Make parsing observable: which object was parsed, with which parser/extractor versions, what was extracted, and which parse errors occurred.
3. Make an analysis reproducible: root object, requested/effective depth, cache mode, graph size, unresolved nodes, truncation, cycles, and warnings.
4. Make cache and repository behaviour diagnosable: hit/miss/stale/regeneration, index rebuild/recovery, atomic-write failures.
5. Correlate all of the above with a `requestId` and `analysisId`.
6. Persist logs locally under `<repo>/logs/` with daily rotation and 30-day retention.
7. Never log SAP source payloads, secrets, credentials, cookies, or auth headers by default.
8. Keep logging testable without a live SAP system.

### Non-goals

- Remote log aggregation (ELK, Loki, OpenTelemetry, Sentry).
- Frontend/browser error logging.
- Full payload capture or replay.
- Compliance-grade audit logging.
- Log-based metrics dashboards.

---

## 2. Decisions

| Decision | Choice |
|---|---|
| Library | `pino` for structured JSONL logging |
| Rotation | `rotating-file-stream`, daily, 30-day retention |
| Layout | Per-category daily files: `app`, `sap`, `parse`, `error` |
| Payload detail | Metadata only (hashes, byte sizes, exit codes) plus truncated stderr preview |
| Correlation | `AsyncLocalStorage` + pino `mixin` |
| Console | Pretty output in development; JSONL in files |
| Source content | Never logged by default |
| Log directory | `<repo>/logs`, override with `CDS_LOG_DIR` |
| Failure behaviour | Logging must never fail an analysis; fall back to console with one warning |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Express / collector / resolver / repository                  │
│   child logger per channel + AsyncLocalStorage context       │
└──────────────────────────────┬───────────────────────────────┘
                               │ pino
                 ┌─────────────┴─────────────┐
                 │ pino.multistream          │
                 │  - channel stream         │
                 │  - error stream (>=error) │
                 └─────────────┬─────────────┘
                               │
        ┌──────────────┬───────┴───────┬──────────────┐
        ▼              ▼               ▼              ▼
  app-YYYY-MM-DD  sap-YYYY-MM-DD  parse-YYYY-MM-DD  error-YYYY-MM-DD
      .jsonl          .jsonl           .jsonl           .jsonl
```

### 3.1 Logger construction

Create one root logger per channel:

```ts
const log = createChannelLogger("sap");
```

Each channel logger:

- has a fixed `channel` base field (`app`, `sap`, `parse`);
- writes to its own daily file;
- additionally writes `error` and `fatal` records to the shared `error` file;
- inherits the request/analysis/object context through a pino `mixin`;
- redacts known sensitive paths;
- serialises `Error` objects through `pino.stdSerializers.err`.

`error` is not a source channel. It is a mirror destination for `error`/`fatal` events from every channel, so operators have one file to check first.

### 3.2 Correlation context

Use `node:async_hooks`:

```ts
interface LogContext {
  requestId?: string;
  analysisId?: string;
  rootObject?: string;
  object?: string;
  depth?: number;
  systemKey?: string;
  cacheMode?: CacheMode;
}
```

- `app.ts` creates `requestId` per `/api/analyze` (or reuses a validated `x-request-id` header).
- `collector.analyze()` creates `analysisId`.
- Each collector task runs inside `runWithLogContext({ object, depth }, ...)`.
- Every log line inherits the active context fields.
- Context is not trusted input; IDs are generated server-side or validated as short safe strings.

### 3.3 Output modes

| Environment | Files | Console |
|---|---|---|
| Development (`CDS_LOG_PRETTY=true`) | JSONL | Pretty, colourised |
| Production / CI | JSONL | Off or plain JSON |
| Tests | In-memory stream | Off |

Files always contain JSONL, even when the console is pretty.

### 3.4 Shutdown

- Handle `SIGINT` and `SIGTERM`.
- Stop accepting new analyses.
- Flush pino and close all file streams.
- End the process only after streams close (with a short timeout).

---

## 4. What is logged

### 4.1 SAP communication — `sap` channel

Every subprocess invocation is logged, including failures to spawn.

| Event | Level | Fields |
|---|---|---|
| `sap.search.start` | info | `object`, `timeoutMs` |
| `sap.search.ok` | info | `object`, `durationMs`, `candidateCount` |
| `sap.search.not-found` | info | `object`, `durationMs` |
| `sap.search.failed` | warn | `object`, `durationMs`, `errorCode`, `exitCode`, `timedOut` |
| `sap.read.start` | info | `object`, `operation` (`ddl`, `table`, `structure`, `view-fetch`), `timeoutMs` |
| `sap.read.ok` | info | `object`, `operation`, `durationMs`, `stdoutBytes`, `sourceFormat`, `metadataOnly` |
| `sap.read.failed` | warn | `object`, `operation`, `durationMs`, `errorCode`, `exitCode`, `timedOut`, `stderrBytes` |
| `sap.spawn.failed` | error | `object`, `operation`, `err` |
| `sap.candidate.selected` | info | `object`, `objectType`, `objectSubtype`, `resolution` |
| `sap.candidate.refused` | warn | `object`, `resolution` (`ambiguous`, `unsupported-type`), `candidates` |
| `sap.stderr.preview` | debug | `object`, `operation`, `preview` (max 2 000 chars) |
| `sap.timeout` | warn | `object`, `operation`, `timeoutMs` |

Rules:

- Log the argv array conceptually, but only stable, validated values (`search`, `ddl read`, object name). Never log cookies, tokens, or environment variables.
- Never log the full stdout/source. Log `stdoutBytes`, `sourceHash`, and `sourceFormat` instead.
- Truncate stderr to `CDS_LOG_STDERR_PREVIEW` characters and strip ANSI escape sequences.
- Log the classified `errorCode` from `classifyFailure` (`not-found`, `auth`, `timeout`, `connection`, `other`).
- Do not log SAP hostnames or user names unless already present in the resolved, non-secret system identity.

### 4.2 Object parsing — `parse` channel

| Event | Level | Fields |
|---|---|---|
| `parse.start` | debug | `object`, `bytes`, `sourceHash` |
| `parse.ok` | info | `object`, `durationMs`, `definitionKinds`, `dependencyCount`, `parseErrorCount` |
| `parse.partial` | warn | `object`, `parseErrorCount`, `firstError` (`line`, `column`, `message`), `dependencyCount` |
| `parse.failed` | error | `object`, `parseErrorCount`, `errors` (first 10), `durationMs` |
| `parse.regenerated` | info | `object`, `sourceHash`, `reason` (`parser-version`, `extractor-version`, `missing-derived`) |
| `object.classified` | info | `object`, `objectType`, `objectSubtype`, `kind`, `metadataOnly` |
| `object.empty-source` | warn | `object`, `objectType` |
| `object.unknown-leaf` | warn | `object`, `objectType`, `objectSubtype` |

Parser/extractor versions (`PARSER_NAME`, `PARSER_VERSION`, `EXTRACTOR_VERSION`) are included on every parse summary so stale-cache decisions are explainable.

### 4.3 Analysis lifecycle and graph quality — `app` channel

| Event | Level | Fields |
|---|---|---|
| `analysis.start` | info | `root`, `requestedDepth`, `effectiveDepth`, `maxObjects`, `concurrency`, `cacheMode` |
| `analysis.finish` | info | `durationMs`, `nodes`, `edges`, `loaded`, `unknown`, `notExpanded`, `truncated`, `limitReached`, `warningCount`, `cacheHits`, `cacheMisses` |
| `analysis.node.failed` | warn | `object`, `depth`, `resolution`, `errorCode`, `message` |
| `analysis.cycle` | warn | `from`, `to`, `depth` |
| `analysis.limit.depth` | info | `object`, `depth`, `maxDepth` |
| `analysis.limit.objects` | warn | `object`, `maxObjects`, `nodeCount` |
| `analysis.warning` | warn | `object`, `message` |

At `info`, per-object success is summarised through counts rather than one line per node. Per-node success can be logged at `debug` if needed.

### 4.4 Cache and repository — `app` channel

| Event | Level | Fields |
|---|---|---|
| `cache.hit` | debug | `object`, `systemKey`, `stale` |
| `cache.miss` | info | `object`, `systemKey`, `mode` |
| `cache.stale` | warn | `object`, `systemKey`, `reason` |
| `cache.regenerated` | info | `object`, `systemKey`, `durationMs` |
| `cache.persist.failed` | warn | `object`, `systemKey`, `err` |
| `cache.refresh.fallback` | warn | `object`, `systemKey`, `upstreamResolution` |
| `repo.index.loaded` | debug | `systemKey`, `objectCount` |
| `repo.index.rebuilt` | warn | `systemKey`, `objectCount`, `reason` |
| `repo.index.recovery` | warn | `systemKey`, `reason` |
| `repo.object.saved` | debug | `object`, `type`, `bytes`, `sourceHash` |
| `repo.rebuild.summary` | info | `systemKey`, `objectCount`, `durationMs` |

Never log cached source text, only hashes and byte counts.

### 4.5 HTTP/API — `app` channel

| Event | Level | Fields |
|---|---|---|
| `http.request.start` | info | `requestId`, `method`, `path` |
| `http.request.finish` | info | `requestId`, `method`, `path`, `status`, `durationMs` |
| `http.request.rejected` | warn | `requestId`, `reason` |
| `http.error` | error | `requestId`, `status`, `err` |
| `http.health` | debug | `fixtureMode`, `cacheMode`, `systemKey` |

Request bodies are not logged wholesale. For `/api/analyze`, log only the validated `name` and effective `maxDepth`.

### 4.6 Security and audit — `app` channel

| Event | Level | Fields |
|---|---|---|
| `security.name.rejected` | warn | `input`, `errorCode`, `requestId` |
| `security.resolution.refused` | warn | `object`, `resolution`, `candidates` |
| `security.path.rejected` | error | `reason`, `requestId` (repository path containment) |
| `security.readonly.violation` | fatal | `operation`, `args` (should never fire) |

The last event is a tripwire: it proves the read-only contract is enforced, and it must never appear in normal operation.

### 4.7 Lifecycle, configuration, crashes — `app` channel

| Event | Level | Fields |
|---|---|---|
| `app.startup` | info | `mode`, `cacheMode`, `systemKey`, `storageRoot`, `logDir`, `nodeVersion`, `parserVersion`, `extractorVersion` |
| `app.shutdown` | info | `signal`, `uptimeMs` |
| `app.unhandled-rejection` | fatal | `err` |
| `app.uncaught-exception` | fatal | `err` |
| `app.startup.failed` | fatal | `err` |
| `config.loaded` | debug | non-secret effective configuration |

Configuration logs must never include passwords, tokens, cookies, or the contents of `~/.adt/config.json`.

### 4.8 Performance — `app` channel

| Event | Level | Fields |
|---|---|---|
| `perf.slow.sap` | warn | `object`, `operation`, `durationMs`, `thresholdMs` |
| `perf.slow.parse` | warn | `object`, `durationMs`, `thresholdMs` |
| `perf.slow.analysis` | warn | `root`, `durationMs`, `thresholdMs` |
| `perf.queue.saturated` | debug | `pending`, `concurrency` |

Default thresholds:

- SAP call: 5 000 ms
- Parse: 1 000 ms
- Analysis: 30 000 ms

Thresholds are configurable.

---

## 5. Event schema

Every line is one JSON object:

```json
{
  "ts": "2026-10-28T14:32:10.123Z",
  "level": "info",
  "channel": "sap",
  "module": "adt-resolver",
  "event": "sap.read.ok",
  "msg": "Read CDS source",
  "requestId": "b0d4f3c2-6a1e-4f0e-9c2a-3f9d2a1c7e11",
  "analysisId": "1f8a2c44-0e2b-4a71-8f3d-6c5b9a0d2e33",
  "rootObject": "I_CHANGEDOCUMENTITEM",
  "object": "I_CHANGEDOCUMENTITEM",
  "depth": 0,
  "systemKey": "DS4-100",
  "cacheMode": "cache-first",
  "operation": "ddl",
  "durationMs": 842,
  "exitCode": 0,
  "stdoutBytes": 4937,
  "sourceHash": "9a1c…",
  "sourceFormat": "asddls"
}
```

Common fields:

- `ts` — ISO-8601 UTC
- `level` — pino level
- `channel` — `app`, `sap`, `parse`
- `module` — source module
- `event` — stable dot-notation event name
- `msg` — human summary
- `requestId`, `analysisId`, `rootObject`, `object`, `depth`
- `systemKey`, `cacheMode`
- `durationMs`
- `errorCode`, `resolution`
- `err` — serialised error (`type`, `message`, `stack`) only for genuine errors

Event names are stable identifiers intended for filtering; `msg` may change.

### 5.1 Redaction

Redact at the logger level:

```
req.headers.authorization
req.headers.cookie
*.password
*.token
*.secret
*.cookie
*.authorization
```

Additional rules:

- Never log `process.env` as an object.
- Never log the ADT config file.
- Never log source text unless `CDS_LOG_SOURCE_PREVIEW=true` (default false).
- Stderr previews strip ANSI escapes and are truncated.
- Object names are validated before logging.

---

## 6. Files, rotation, retention

### 6.1 Layout

```
<repo>/logs/
  app-2026-10-28.jsonl
  sap-2026-10-28.jsonl
  parse-2026-10-28.jsonl
  error-2026-10-28.jsonl
```

- Date is the local date at rotation time.
- One file per channel per day.
- `error-*.jsonl` receives every `error` and `fatal` record from all channels.
- Files are append-only during the day.

### 6.2 Rotation

- `rotating-file-stream` with `interval: "1d"`.
- `maxFiles: 30` per channel.
- No size cap, per the chosen policy.
- Rotation happens at local midnight.
- Old files are deleted beyond 30 days.

Because there is no size cap, a pathological debug session could grow large. Mitigations:

- Default level is `info`.
- Per-object success logs are `debug`.
- Payloads are never logged.
- Add an optional `CDS_LOG_MAX_FILE_MB` guard later if disk usage becomes a concern.

### 6.3 Startup and failure behaviour

1. Resolve `logDir` from `CDS_LOG_DIR` or `<repo>/logs`.
2. Create the directory recursively.
3. Open streams.
4. If creation/open fails:
   - emit one warning to stderr;
   - continue with console-only logging;
   - never fail the HTTP server or an analysis.

### 6.4 Windows considerations

- Close all streams before process exit to avoid locked-file errors.
- Use forward-slash-safe path joins through `node:path`.
- Do not attempt to rename/delete files that another process holds open.
- Verify that `rotating-file-stream` handles the Windows rename/lock case; add a startup smoke test.

---

## 7. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CDS_LOG_DIR` | `<repo>/logs` | Log directory |
| `CDS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `fatal` |
| `CDS_LOG_PRETTY` | auto (`true` on TTY) | Pretty console output |
| `CDS_LOG_RETENTION_DAYS` | `30` | Days of files to keep |
| `CDS_LOG_STDERR_PREVIEW` | `2000` | Max stderr characters logged |
| `CDS_LOG_SOURCE_PREVIEW` | `false` | Reserved; source excerpts are not logged |
| `CDS_LOG_SLOW_SAP_MS` | `5000` | Slow SAP warning threshold |
| `CDS_LOG_SLOW_PARSE_MS` | `1000` | Slow parse warning threshold |
| `CDS_LOG_SLOW_ANALYSIS_MS` | `30000` | Slow analysis warning threshold |

`.gitignore` gains:

```
logs/
```

The log directory is local operational data and must never be committed.

---

## 8. Integration points

| File | Change |
|---|---|
| `src/logging/logger.ts` (new) | pino root/channel loggers, multistream, serializers, redaction |
| `src/logging/streams.ts` (new) | `rotating-file-stream` setup, retention, close/flush |
| `src/logging/context.ts` (new) | `AsyncLocalStorage` store, `runWithLogContext`, request/analysis helpers |
| `src/logging/events.ts` (new, optional) | Typed event-name constants and field helpers |
| `src/config.ts` | log directory/level/pretty/retention/threshold settings |
| `src/index.ts` | initialise logger, replace `console` injections, startup/shutdown/crash handlers |
| `src/app.ts` | request ID middleware, request finish/error logs, pass logger to collector |
| `src/collector/collector.ts` | analysis start/finish, per-node failures, cycles, limits, warnings, cache summary |
| `src/adt/adt-resolver.ts` | search/read timing, candidate selection/refusal, typed-read failures, stderr preview |
| `src/adt/process-adapter.ts` | spawn-error and raw invocation timing at debug (optional) |
| `src/repository/repository.ts` | use the real logger; hit/miss/stale/index recovery/save failures |
| `src/repository/caching-provider.ts` | cache mode decisions, hit/miss, refresh fallback, persist failure, regeneration |
| `src/repository/rebuild-cli.ts` | rebuild summary through the shared logger |
| `packages/backend/package.json` | add `pino`, `rotating-file-stream` |
| `.gitignore` | add `logs/` |
| `README.md` | document log files, variables, and troubleshooting |
| `tasks/003/logging.md` (new) | implementation notes and verification results |

Optional:

- `src/adt/version.ts`: run `adt --version` once at startup and log the CLI version. This is read-only and useful when diagnosing behaviour differences between CLI releases.

Logger parameters remain optional in constructors:

```ts
constructor(options: { logger?: Logger })
```

This keeps fixture mode and existing tests working without a logger.

---

## 9. Testing

### Unit tests

- Logger writes valid JSONL with the expected fields.
- Channel routing: `sap` events land only in the SAP file (plus `error` when applicable).
- `error`/`fatal` mirroring into `error-*.jsonl`.
- Level filtering.
- Redaction of `authorization`, `cookie`, `password`, `token`.
- `Error` serialisation includes `type`, `message`, `stack`.
- Infinite/nested error handling does not throw.
- `AsyncLocalStorage` fields appear on child logs.
- Stderr preview truncation and ANSI stripping.
- Source text is absent by default.
- Retention cleanup removes files older than the configured days.
- Rotation file naming and date boundaries (fake timers or injectable clock).
- Unwritable log directory falls back to console without throwing.

### Integration tests

- `createApp` with an in-memory logger: successful analysis emits `http.request.finish` and `analysis.finish` with matching `requestId`.
- Invalid name emits `security.name.rejected` and still returns a graph.
- Fixture-mode analysis emits `parse.ok` and `object.classified`.
- Cache hit/miss/refresh-fallback events are emitted with the expected fields.
- No test requires a live SAP system.

### Manual verification

1. `npm run dev:fixtures` → confirm `logs/app-*.jsonl`, `logs/parse-*.jsonl`, `logs/sap-*.jsonl` is absent (fixtures bypass SAP).
2. Live `cache-first` analysis → confirm `sap.search.*` and `sap.read.*` lines with durations.
3. `cache-only` with `ADT_COMMAND=definitely-not-adt` → confirm cache hits and no SAP invocation.
4. `refresh` with a broken SAP command → confirm `cache.refresh.fallback` warning and cached data served.
5. Inspect `error-*.jsonl` after a deliberate failure.
6. Confirm `logs/` is ignored by Git.
7. Confirm no source text appears in any log file.

### Commands

```powershell
npm test
npm run typecheck
npm run build
```

---

## 10. Privacy and security

- SAP source can be proprietary. It is **not** logged.
- Source identity is represented by SHA-256 and byte count.
- Stderr can contain server paths or URLs; previews are truncated and ANSI-stripped.
- No credentials, cookies, tokens, or environment dumps.
- Object names are validated before inclusion in a log line.
- Logs stay local under `logs/`; they are never uploaded.
- On POSIX, create log files with owner-only permissions (`0600`) where supported.
- The `security.readonly.violation` tripwire gives a clear signal if a write operation is ever introduced.

---

## 11. Operational notes

### Tail the current SAP log

```powershell
Get-Content .\logs\sap-2026-10-28.jsonl -Tail 50
```

### Find failed SAP reads

```powershell
Get-Content .\logs\sap-*.jsonl |
  ConvertFrom-Json |
  Where-Object { $_.event -eq "sap.read.failed" } |
  Select-Object ts, object, operation, errorCode, durationMs
```

### Follow one analysis

```powershell
Get-Content .\logs\*.jsonl |
  ConvertFrom-Json |
  Where-Object { $_.analysisId -eq "<id>" } |
  Sort-Object ts
```

### What to attach to a bug report

- The relevant `app`, `sap`, and `parse` files for the day.
- `error-*.jsonl`.
- The `requestId` and `analysisId`.
- Do **not** attach source payloads; they are not in the logs.

---

## 12. Rollout plan

1. **Logger core** — pino setup, channels, streams, rotation, redaction, context; unit tests.
2. **Configuration** — `config.ts`, `.gitignore`, directory creation and fallback behaviour.
3. **HTTP and lifecycle** — request IDs, request logs, startup/shutdown/crash handlers.
4. **SAP** — resolver search/read events, candidate decisions, stderr preview, error classification.
5. **Parsing and analysis** — collector lifecycle, per-node outcomes, parse summaries, graph metrics.
6. **Cache and repository** — hit/miss/stale/regeneration, index recovery, save failures.
7. **Documentation** — README log section, task verification notes.
8. **Full verification** — tests, typecheck, build, fixture and live smoke tests.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Log volume from 200-object analyses | Per-object success at `debug`; `info` logs summaries |
| Daily-only rotation with no size cap | Default `info`, no payloads, optional size guard later |
| Windows file locking during rotation | Close streams on shutdown; smoke-test rotation |
| Accidental source leakage | Metadata-only logging; test asserts source absence |
| Stderr contains sensitive paths | Truncate, strip ANSI, document local-only retention |
| Logger failure breaks analysis | Fallback to console; logging never throws into request paths |
| Async context leaks between requests | Use `AsyncLocalStorage.run` per request; test isolation |
| `rotating-file-stream` timer/test flakiness | Inject clock/stream factory; avoid real timers in unit tests |

---

## 14. Acceptance criteria

- [ ] Logs are written under `<repo>/logs/` in four per-category daily files.
- [ ] `sap`, `parse`, `app`, and `error` channels are populated by real code paths.
- [ ] Every analysis log line can be joined by `requestId` and `analysisId`.
- [ ] SAP search/read events include duration, exit code, timeout state, byte counts, and classified errors.
- [ ] Parse events include parser/extractor versions, definition kinds, dependency counts, and parse errors.
- [ ] Cache hit/miss/stale/refresh-fallback events are recorded.
- [ ] HTTP request finish and analysis finish events include graph metrics.
- [ ] No SAP source, credentials, cookies, or tokens appear in logs.
- [ ] Files rotate daily and older than 30 days are removed.
- [ ] An unwritable log directory does not break the backend.
- [ ] Tests cover routing, redaction, context, rotation/retention, and source absence.
- [ ] `npm test`, `npm run typecheck`, and `npm run build` pass.
- [ ] README documents configuration and troubleshooting.
