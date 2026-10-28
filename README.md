# Abapify CDS Visualiser

A browser-based tool that visualises dependencies between SAP ABAP CDS entities
and their underlying DDIC objects.

The user enters a CDS entity or DDIC object name. The backend **resolves the
object through SAP repository search**, reads it with the matching typed ADT
reader, parses CDS DDL with [`@abapify/acds`](https://www.npmjs.com/package/@abapify/acds),
walks `FROM`/`JOIN`/set-operation sources up to a hard-capped depth of **4**, and
renders the dependency graph top-to-bottom (the requested object at the top,
dependencies below).

Retrieved objects are cached in a local, filesystem-based repository, so repeat
analyses do not hit SAP. The cache can be inspected, rebuilt, or used fully
offline.

Column-level lineage, SAP writes, SQLite/other databases, bulk crawlers, and
cross-system diff UI are intentionally out of scope.

## Architecture

```
packages/
  shared/     Application-owned graph/resolution/cache model
  backend/    Node.js + TypeScript service (search resolver, typed ADT readers,
              local repository, parser adapter, bounded collector)
  frontend/   React + Vite + React Flow (@xyflow/react) UI
```

Layers are kept separate:

- **SAP repository resolution** (`backend/src/adt`) — `AdtObjectProvider` runs
  `adt search --json <name>`, keeps exact-name candidates, then dispatches to a
  typed reader:
  - `DDLS/DF` → `adt ddl read <name>`
  - `TABL/DT` → `adt table read <name>`
  - `TABL/DS` → `adt structure read <name>`
  - `VIEW/DV` → `adt fetch` of the VIT metadata URI (metadata-only; see
    [Known limitations](#known-limitations))
  - anything else → an explicit `unsupported-type` result; it is **not** guessed.
  `adt get` is deliberately **not** used as a resolver. `AdtObjectProvider` is
  the only component that talks to SAP.
- **Local repository** (`backend/src/repository`) — `FileSystemRepository`
  stores ordinary files plus a versioned JSON index. `CachingObjectProvider`
  wraps the SAP provider and implements `cache-first`, `cache-only`, and
  `refresh`.
- **Source extraction** (`backend/src/parser`) — walks the `@abapify/acds` AST
  for the primary `FROM` source, the join chain (including parenthesised join
  groups), and set-operation operands. No regular-expression source parsing.
- **Dependency collector** (`backend/src/collector`) — bounded traversal with
  depth/object/concurrency limits, deduplication, cycle detection, and
  partial-result reporting. CDS nodes are expanded; tables, structures, and views
  are captured leaves; unresolved/unsupported nodes are preserved as `unknown`.
- **Graph model** (`packages/shared`) — `DependencyNode` / `DependencyEdge` /
  `DependencyGraph`. An edge means *"the `from` object depends on the `to`
  object"*; the React Flow adapter renders `from` above `to`.

## Prerequisites

- Node.js 18+ (developed on Node 22).
- The `adt` CLI installed and configured against a development SAP system:

  ```powershell
  adt search --json I_ChangeDocumentItem
  adt ddl read I_ChangeDocumentItem
  adt table read CDPOS
  adt structure read BAPIRET2
  ```

  See <https://adt-cli.netlify.app/guides/cds-authoring> for setup.

All SAP access is read-only. Object names are validated before process
invocation, and the CLI is spawned with an argument array (no shell
interpolation of user input).

## Setup

```bash
npm install
```

## Running

### Against a real SAP system (default)

```bash
npm run dev            # starts backend (ADT CLI + local repository) + frontend
# or in two terminals:
npm run dev:backend
npm run dev:frontend
```

The frontend dev server proxies `/api` to `http://localhost:8787`. Open
<http://localhost:5173>.

On first use the backend creates `storage/sap/<systemKey>/`. The system key is
derived offline from `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY`, or from
`~/.adt/config.json` (`defaultSid` + client, e.g. `DS4-100`). No username,
password, token, or URL is written to the repository.

### Fixture/demo mode (no SAP)

```bash
npm run dev:fixtures   # backend serves bundled fixtures instead of ADT CLI
npm run dev:frontend
```

The UI shows a **"Fixture mode (no SAP)"** badge. Fixtures are clearly-labelled
synthetic sources under `packages/backend/fixtures/` (plus a copy of the real
`ZC_PurReqItemQRY001` sample); they are never presented as production data.
Fixture mode does not use the local repository.

### Cache modes

Select with `CDS_CACHE_MODE`. The system key is resolved without contacting SAP;
if you move a cache to a machine without `~/.adt/config.json`, set
`CDS_REPO_SYSTEM_KEY` to the original key (for example `DS4-100`).

| Mode | Behaviour |
| ---- | --------- |
| `cache-first` (default) | Serve a valid cached object. On a miss (or a cache entry whose source is missing), search/read SAP and persist the result. Stale derived artifacts are regenerated from cached source without a SAP round-trip. |
| `cache-only` | Never contact SAP. A miss is shown as an unresolved `cache-miss` node; the rest of the graph is still returned. Useful for demos, offline work, and reviewing captured data. |
| `refresh` | Always contact SAP and overwrite the cached copy. If the refresh fails, the previously valid cached copy is served and a warning is attached, preserving the graph branch. |

### Rebuilding the index

The JSON index is an optimisation. It is rebuilt automatically when it is
missing, malformed, or refers to missing object metadata. To force a rebuild:

```bash
npm run repo:rebuild
```

Set `CDS_REPO_ROOT` to point at a different repository first if needed.

## Configuration

Backend environment variables:

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PORT` | `8787` | Backend HTTP port. |
| `ADT_COMMAND` | `adt` | Executable used for repository search and typed reads. |
| `ADT_READ_TIMEOUT_MS` | `30000` | Per-invocation timeout. |
| `CDS_MAX_DEPTH` | `4` | Default maximum dependency depth; clamped to `4`. |
| `CDS_MAX_OBJECTS` | `200` | Safety limit on total objects per analysis. |
| `CDS_CONCURRENCY` | `5` | Bound on concurrent ADT reads. |
| `CDS_FIXTURE_DIR` | — | When set, serve from fixtures instead of ADT/repository. |
| `CDS_REPO_ROOT` | `<repo>/storage` | Local object repository root. |
| `CDS_CACHE_MODE` | `cache-first` | `cache-first`, `cache-only`, or `refresh`. |
| `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY` | from ADT config | Stable system key used to partition the repository. |
| `SAP_SID` / `SAP_CLIENT` | — | Optional system metadata when an explicit key is used. |
| `CDS_LOG_DIR` | `<repo>/logs` | Directory for structured JSONL logs. |
| `CDS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `fatal`. |
| `CDS_LOG_PRETTY` | TTY detection | Pretty console output in addition to JSONL files. |
| `CDS_LOG_RETENTION_DAYS` | `30` | Days of log files to keep. |
| `CDS_LOG_STDERR_PREVIEW` | `2000` | Maximum characters of `adt` stderr written to a log line. |
| `CDS_LOG_SLOW_SAP_MS` | `10000` | Warn when an ADT command exceeds this duration. |
| `CDS_LOG_SLOW_PARSE_MS` | `1000` | Warn when a CDS parse exceeds this duration. |
| `CDS_LOG_SLOW_ANALYSIS_MS` | `30000` | Warn when an analysis exceeds this duration. |

Per-request depth **1–4** can also be chosen in the UI. Depth is hard-capped at 4
so a UI or API request cannot make the crawler go deeper.

## Logging

The backend writes structured JSONL logs under `<repo>/logs/` (gitignored).
Each channel has its own daily file, and `error`/`fatal` events are mirrored into
a shared error file:

```
logs/
  app-2026-10-28.jsonl      # HTTP, analysis lifecycle, cache/repository, security
  sap-2026-10-28.jsonl      # every adt search/read invocation
  parse-2026-10-28.jsonl    # CDS parsing and object classification
  error-2026-10-28.jsonl    # error/fatal mirror from all channels
```

Files rotate at local midnight and are retained for 30 days by default. Set
`CDS_LOG_LEVEL=debug` to include per-object cache details, SAP stderr previews,
and raw timing events. Files are always JSONL; `CDS_LOG_PRETTY=true` only adds
human-readable console output.

Every line carries `ts`, `level`, `channel`, `event`, and `msg`, plus the active
`requestId`, `analysisId`, `rootObject`, `object`, `depth`, `systemKey`, and
`cacheMode` where applicable. The HTTP response includes an `x-request-id`
header so a UI action can be matched to the log.

Example: follow one analysis (PowerShell):

```powershell
Get-Content .\logs\*.jsonl |
  ConvertFrom-Json |
  Where-Object { $_.analysisId -eq "<id>" } |
  Sort-Object ts
```

Example: find failed SAP reads:

```powershell
Get-Content .\logs\sap-*.jsonl |
  ConvertFrom-Json |
  Where-Object { $_.event -eq "sap.read.failed" } |
  Select-Object ts, object, operation, errorCode, durationMs
```

Logging is diagnostic only and never affects an analysis: if the log directory
cannot be created or opened, the backend falls back to JSONL on stderr and
continues. SAP source payloads, credentials, cookies, and tokens are never
written to the logs; source is represented by byte count and SHA-256 where a
digest is needed. Error responses and fatal events include a serialized stack.

The design, event catalog, and acceptance criteria are documented in
[`tasks/003/loggin_plan.md`](tasks/003/loggin_plan.md).

## Repository layout

```
storage/
  sap/<systemKey>/
    system.json
    index.json
    packages/
      <packageName>/
        package.json
        objects/
          <objectName>/
            metadata.json          # source of truth for this object
            parsed.json            # parser result (CDS) or a clear "not parsed" note
            dependencies.json      # structural dependencies extracted from source
            source.asddls          # CDS DDL (UTF-8, no BOM)
            source.table           # DDIC table DDL
            source.structure       # DDIC structure DDL
            source.view.xml        # DDIC view metadata XML
```

Only the artifact matching the object type is written; non-CDS payloads are
never stored under a fake `.asddls` name. Objects without a known package are
stored under `_unassigned`. Directory names are sanitised for Windows (reserved
device names, trailing dots/spaces, namespace `/` → `~`, case-collision hashes)
and constrained to the repository root. `metadata.json` preserves the original
SAP spelling, package, type/subtype, source format, SHA-256, byte size, retrieval
source, cache mode, parser/extractor versions, and search candidates.

Writes are atomic (temp file + rename). A failed refresh never replaces a good
cached source. The full repository layout and behaviour are documented in
[`tasks/002/implementation.md`](tasks/002/implementation.md).

## API

`POST /api/analyze` — body `{ "name": "I_ChangeDocumentItem", "maxDepth": 1 }`.
Returns an `AnalyzeResult` containing an application-owned `DependencyGraph`,
`truncated`/`limitReached`, warnings, and a small `cache` summary (mode, system
key, hits, misses). Nodes carry `objectType`, `objectSubtype`, `resolution`,
`cacheHit`, and `stale` where known.

`GET /api/health` — returns
`{ "status": "ok", "fixtureMode": false, "cacheMode": "cache-first", "systemKey": "DS4-100" }`.

## Testing

```bash
npm test              # all workspace tests (no SAP required)
npm run typecheck     # all workspace type checks
npm run build         # frontend production build
```

The backend has 99 tests covering source extraction, the collector (depth cap,
dedup, cycles, partial failure, object limits), search-first resolution and
typed-reader dispatch, the filesystem repository (atomic writes, index rebuild,
stale detection, safe paths, cross-system isolation), caching modes, UTF-16/UTF-8
decoding, structured logging, and name validation. The frontend has 2 tests for
the top-to-bottom layout mapping. A live-SAP smoke test is intentionally
separate:

```powershell
Invoke-RestMethod -Uri http://localhost:8787/api/analyze -Method Post `
  -ContentType application/json -Body '{"name":"I_ChangeDocumentItem","maxDepth":1}'
```

## Known limitations

- **DDIC views are metadata-only.** The installed ADT CLI 0.4.23 has no working
  DDIC view source/structure reader: `adt get`, `adt source get`, and
  `adt table read` fail for `V_T001`; `/sap/bc/adt/ddic/views/v_t001` returns
  HTTP 500 even with the documented `Accept` header. The VIT metadata URI does
  work, so views are captured as a leaf with `source.view.xml`, `sourceFormat:
  "view-metadata"`, and `metadataOnly: true`. They are not expanded into their
  base tables.
- **`dependencies.json` stores dependency types as unknown.** The structural
  extractor only knows names/roles at parse time; the collector confirms types
  later during resolution. The graph is authoritative for resolved types.
- **Named-argument syntax is a parser gap.** `@abapify/acds` does not yet parse
  the named-argument form of built-ins such as
  `currency_conversion(amount => …, target_currency => …)`. These appear in the
  *projection list* only, so dependency extraction is unaffected: the collector
  still extracts `FROM`/`JOIN` sources from the partial AST and surfaces the
  parse errors as a graph warning. Covered by a regression test against a real
  `ZC_PurReqItemCube` source.
- The ADT CLI emits DDL source as **UTF-8**; the reader also auto-detects UTF-16
  (e.g. when source is captured through PowerShell `>` redirection, which
  re-encodes to UTF-16 LE).
- `@abapify/acds` is ESM-only, so the backend runs as ESM via `tsx`.
- The repository has no authentication and is intended for local use. Do not
  expose the backend or `storage/` publicly.
- Column/field lineage, Electron packaging, bulk crawling, and write operations
  are out of scope for this milestone.
