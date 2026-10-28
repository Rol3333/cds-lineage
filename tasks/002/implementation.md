# Task 002 — Implementation Results

**Date:** 2026-10-28
**Project:** `D:\Rolandas\code\fiori\cds-lineage`
**Scope:** search-first SAP object resolution + local filesystem repository + cache modes + DDIC table/structure/view capture.
**SAP access:** read-only. No SAP writes were performed.

---

## 1. Verdict

The change is implemented end-to-end and verified with automated tests plus a
read-only live-SAP smoke test.

- Objects are resolved through `adt search --json` and read with the matching
  typed reader. `adt get` is no longer used as a resolver.
- CDS entities, transparent tables (`TABL/DT`), DDIC structures (`TABL/DS`), and
  DDIC views (`VIEW/DV`, metadata only) are captured.
- Every retrieved object is stored in a local repository under
  `storage/sap/<systemKey>/packages/<package>/objects/<object>/`.
- The repository supports `cache-first`, `cache-only`, and `refresh`, with
  atomic writes, content hashes, stale-derived-artifact detection, index
  recovery, and safe Windows paths.
- Dependency depth is defaulted and hard-capped at **4**. Requests for 5–10 are
  clamped to 4; the UI only offers 1–4.
- Unresolved/unsupported dependencies are preserved as explicit `unknown`
  nodes with an edge, not guessed or dropped.
- **90 tests pass** (88 backend + 2 frontend); typecheck and frontend build pass.
- A live smoke test against `DS4` client `100` captured `I_ChangeDocumentItem` +
  `CDPOS`, `BAPIRET2`, and `V_T001`, then proved `cache-only` works with a
  nonexistent ADT command and `refresh` failure preserves the old cache.

---

## 2. What changed

### 2.1 Resolver: search first, then typed read

New/changed backend modules:

- `packages/backend/src/adt/adt-resolver.ts` — `AdtObjectProvider`:
  - validates the object name,
  - invokes `adt search --json <name>`,
  - extracts the JSON array from the human banner/footer,
  - keeps **exact-name** candidates (canonical upper-case comparison),
  - reports `not-found` / `ambiguous` / `unsupported-type` before reading,
  - dispatches:
    - `DDLS/DF` → `adt ddl read <name>`,
    - `TABL/DT` → `adt table read <name>`,
    - `TABL/DS` → `adt structure read <name>`,
    - `VIEW/DV` → `adt fetch /sap/bc/adt/vit/wb/object_type/viewdv/object_name/<name>`,
  - reports `search-failed` for search process/auth/timeout/parse failures,
  - reports `read-failed` for typed-reader failures, preserving the underlying
    `not-found` / `empty-source` / `timeout` / `auth` / `connection` code,
  - never falls back from a failed typed reader to another reader.
- `packages/backend/src/adt/types.ts` — new `ObjectProvider` /
  `ObjectReadResult` contract and ADT error codes.
- `packages/backend/src/adt/validate.ts` — `validateObjectName`
  (`validateCdsName` retained as an alias); allows CDS/DDIC namespace names and
  rejects shell/unsafe characters before process invocation.
- `packages/backend/src/adt/fixture-service.ts` — fixture provider now supports
  `DDLS`, `TABL/DT`, `TABL/DS`, and `VIEW/DV`, with explicit source formats.
- `packages/backend/src/adt/adt-cli.ts` — **deleted** (old `adt get`-based
  classifier/reader).
- `packages/backend/test/adt-cli.test.ts` — **deleted**, replaced by
  `adt-resolver.test.ts`.

`adt fetch` prints a `🔄 GET …` banner and `✅ Done!` footer on stdout. The
resolver extracts the first `<` through the last `>` and stores canonical XML
only (`source.view.xml`). A response with no XML is a `read-failed` result.

### 2.2 Local repository

New modules under `packages/backend/src/repository/`:

| File | Responsibility |
| ---- | -------------- |
| `types.ts` | Metadata, index, artifact, save-input, and system-identity types. |
| `paths.ts` | Windows-safe segment/object/package keys, reserved names, trailing dots/spaces, namespace `/` → `~`, case-collision hashes, path containment. |
| `atomic.ts` | Temp-file + rename writes, JSON serialization, Windows rename retry. |
| `hash.ts` | SHA-256 content hashing. |
| `system-key.ts` | Offline system identity: `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY`, then `~/.adt/config.json`, then `default`. Never persists credentials/URLs. |
| `repository.ts` | `FileSystemRepository`: save/load, metadata, index load/rebuild/lock, stale detection, package listing, filtered lookup, `saveDerived`. |
| `caching-provider.ts` | `CachingObjectProvider`: `cache-first`, `cache-only`, `refresh`, cache-hit/miss/stale reporting, offline recursion. |
| `rebuild-cli.ts` | `npm run repo:rebuild` index recovery command. |

Layout:

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
            metadata.json
            parsed.json
            dependencies.json
            source.asddls | source.table | source.structure | source.view.xml
```

- `metadata.json` is the per-object source of truth. It preserves:
  original SAP name, canonical name, type/subtype, package, description, URI,
  metadata-only flag, source artifact/format, encoding, SHA-256, byte size,
  retrieval timestamp/source, cache mode, parser/extractor versions,
  classification candidates, and derived-artifact timestamps.
- `index.json` is an optimisation with `schemaVersion`, system identity,
  generation time, and one entry per object (canonical name, type/subtype,
  package, metadata path, object directory, artifact/format/hash, timestamps).
  It is rebuilt automatically when missing/malformed or when entries refer to
  missing metadata files.
- `system.json` stores only `schemaVersion`, `key`, `sid`, `client`,
  `updatedAt`. `package.json` stores `schemaVersion`, original package name,
  system key, and `updatedAt`. No usernames, passwords, tokens, or URLs.
- Objects with no known package go under `_unassigned`.
- Non-CDS payloads are stored under clearly named artifacts; no fake `.asddls`.

Integrity properties:

- Writes are atomic. A failed write/refresh does not replace a valid cached
  source.
- Source content is hashed; a changed source file makes the derived artifacts
  stale. `saveDerived` re-derives from the cached source and updates the stored
  source hash/byte size.
- A missing source artifact marks the entry stale. In `cache-first` it is
  re-fetched; in `cache-only` it is reported as `cache-miss`; in `refresh` the
  normal SAP path is used.
- CDS derived artifacts are stale when the parser or extractor version differs,
  when `parsed.json` / `dependencies.json` is missing, or when the source hash
  differs.
- Index writes are serialized with a promise queue so the collector's
  concurrency (5) cannot interleave index updates.
- The repository is partitioned by system key, so multiple systems can share one
  storage root without mixing objects.

### 2.3 Cache modes

| Mode | Behaviour |
| ---- | --------- |
| `cache-first` (default) | Serve a valid cached entry. On a miss, or if the cached source artifact is missing, search/read SAP and persist. Stale CDS derived artifacts are regenerated from cached source without SAP. |
| `cache-only` | Never contact SAP. A miss is an explicit `cache-miss` node; independent cached branches still resolve. |
| `refresh` | Always contact SAP and overwrite on success. If refresh fails, the previously valid cached copy is served with `refreshFailed` and a warning; no data is lost. |

`GET /api/health` reports `cacheMode` and `systemKey` (no paths or secrets).
`POST /api/analyze` includes a small `cache` summary:
`{ mode, systemKey?, hits, misses }`. Per-node `cacheHit` and `stale` flags are
also returned. Fixture mode bypasses the repository.

### 2.4 Collector

`packages/backend/src/collector/collector.ts` now consumes `ObjectProvider` and
handles the full resolution model:

- The root may be a CDS entity, table, structure, or view. The root is resolved
  through the same provider; it is no longer forced to `kind: "cds"`.
- CDS (`DDLS`) sources are parsed and expanded.
- `TABL/DT` → `kind: "table"`, loaded leaf.
- `TABL/DS` → `kind: "structure"`, loaded leaf.
- `VIEW/DV` → `kind: "view"`, loaded metadata-only leaf, with a warning.
- Other resolved types → `kind: "unknown"`, loaded leaf, with a warning.
- Non-`resolved` outcomes become `read-error` / `empty-source` nodes with
  distinct `errorCode`s:
  - `not-found` → `object-not-found`
  - `cache-miss` → `cache-miss`
  - `ambiguous` → `ambiguous`
  - `unsupported-type` → `unsupported-type`
  - `search-failed` → `search-failed`
  - `read-failed` → `read-failed` (or `empty-source` / `invalid-name` /
    `adt-connection` as appropriate)
- Edges are still added for failed dependencies; independent branches continue.
- `maxDepth` is clamped to `MAX_DEPTH_LIMIT` (4). Root is depth 0; four levels
  below the root are read. A reference discovered at depth 5 is rendered as
  `not-expanded` with `max-depth` and is not fetched.
- Cycle detection, deduplication, object-count limit, deterministic node/edge
  ordering, and partial-result warnings are retained.
- Parse errors that are projection-only still yield extracted `FROM`/`JOIN`
  dependencies plus a warning; a total parse failure is `parse-error`.

### 2.5 Shared model

`packages/shared/src/index.ts`:

- `SourceKind` extended with `view` and `structure`.
- `ResolutionStatus` added: `resolved`, `not-found`, `ambiguous`,
  `unsupported-type`, `search-failed`, `read-failed`, `cache-miss`.
- `CacheMode` and `SourceFormat` added.
- `ErrorCode` extended with `cache-miss`, `ambiguous`, `unsupported-type`,
  `search-failed`, `read-failed`.
- `DependencyNode` extended with `objectType`, `objectSubtype`, `resolution`,
  `cacheHit`, `stale`.
- `AnalyzeResult.cache` summary added.
- `DEFAULT_MAX_DEPTH = 4`, `MAX_DEPTH_LIMIT = 4`,
  `DEFAULT_CACHE_MODE = "cache-first"`.

### 2.6 Backend wiring and config

- `packages/backend/src/config.ts`:
  - `CDS_REPO_ROOT` (default `<repo>/storage`; resolved from the monorepo root,
    not `process.cwd()`),
  - `CDS_CACHE_MODE`,
  - `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY`, plus optional `SAP_SID` /
    `SAP_CLIENT` metadata,
  - existing ADT/depth/object/concurrency settings; depth clamped to 4.
- `packages/backend/src/index.ts`:
  - fixture mode → `createFixtureProvider`,
  - real mode → `FileSystemRepository` + `AdtObjectProvider` wrapped by
    `CachingObjectProvider`,
  - logs mode, system key, cache mode, storage root (server-local log only).
- `packages/backend/src/app.ts`:
  - health includes `cacheMode` and `systemKey`,
  - analyze clamps request depth to 4 and passes cache context,
  - default validator is `validateObjectName`.
- `packages/backend/package.json` / root `package.json`:
  - `repo:rebuild` script.
- `.gitignore`: `storage/` added.

### 2.7 Frontend

- Controls accept 1–4 depth options and describe repository/cache/depth
  behaviour.
- Header shows `cache: <mode> · <systemKey>` in real mode (fixture badge remains
  in fixture mode).
- Node cards show a `cached` tag when served from the repository.
- `KIND_LABEL` includes view/structure; `ERROR_CODE_LABEL` includes the new
  resolution errors.
- Details panel shows repository type (`TABL/DT` etc.), resolution, source
  (cache hit vs SAP), and stale state.
- CSS tags for view, structure, and cached.

---

## 3. Verification

### 3.1 Automated tests (no SAP)

```text
backend: 8 files, 88 tests passed
frontend: 1 file, 2 tests passed
```

Coverage added/updated:

- `adt-resolver.test.ts` — exact matching, prefix rejection, no-match, DDLS /
  table / structure / view dispatch, ambiguity, unsupported types, search vs
  read failure separation, timeout, invalid names, UTF-16 payloads, JSON
  extraction, XML banner/footer stripping, and an assertion that `adt get` is
  never called.
- `repository.test.ts` — UTF-8/no-BOM, non-ASCII data, system isolation, package
  and `_unassigned` layout, `package.json`/`system.json`, Windows-safe paths,
  index rebuild (missing/malformed), stale detection, missing-source stale,
  source-hash refresh, derived regeneration, table/structure/view artifacts,
  filtered lookup, rebuild, artifact-name rejection, no leftover temp files, and
  no network calls.
- `caching-provider.test.ts` — cache hit/miss, cache-only offline, refresh
  overwrite, refresh failure preservation, stale regeneration, missing-source
  refetch, cache-only missing-source, full cached branch recursion, partial
  branch, upstream failure with no cache, and cache-write failure tolerance.
- `collector.test.ts` — existing depth/dedup/cycle/limit tests plus structure,
  view, unsupported-type preservation, table/structure/view roots, depth-4 hard
  cap, and resolution/cache metadata.
- Existing parser, decoder, validation, and real-source regression tests remain.

Commands:

```bash
npm test
npm run typecheck
npm run build
```

All passed.

### 3.2 Live read-only smoke test (`DS4` / client `100`)

Health:

```json
{"status":"ok","fixtureMode":false,"cacheMode":"cache-first","systemKey":"DS4-100"}
```

`I_ChangeDocumentItem`, depth 1:

- 2 nodes, 1 edge: `I_CHANGEDOCUMENTITEM -> CDPOS` (primary).
- First run: `cache.hits = 0`, `cache.misses = 2`.
- Second run: `cache.hits = 2`, `cache.misses = 0`; both `cacheHit: true`.

Other roots:

| Root | Captured as | Reader |
| ---- | ----------- | ------ |
| `CDPOS` | table leaf | `adt table read` |
| `BAPIRET2` | structure leaf | `adt structure read` |
| `V_T001` | metadata-only view leaf | `adt fetch` VIT URI |

Storage inspection:

- `source.asddls` 4,937 bytes, `source.table` 1,601 bytes,
  `source.structure` 904 bytes, `source.view.xml` 497 bytes.
- All source artifacts are UTF-8 **without BOM**.
- `system.json` and `package.json` present.
- `source.view.xml` contains only the `mainObject` XML (no CLI banner/footer).
- `metadata.json` preserves `I_ChangeDocumentItem` spelling and package `SZD`.
- `parsed.json` records `@abapify/acds` 0.4.23, extractor version 2, and the
  `viewEntity` definition kind; `dependencies.json` records `cdpos` / `CDPOS`
  with `objectType: null`, `resolution: "unknown"` (types are confirmed later by
  the collector).

Offline proof:

- Restarted with `CDS_CACHE_MODE=cache-only` and
  `ADT_COMMAND=definitely-not-adt`.
- `I_ChangeDocumentItem` (2 hits), `BAPIRET2` (1 hit), `V_T001` (1 hit) resolved
  from cache.
- `NOT_CACHED_OBJECT` became a `read-error` node with `cache-miss` and a warning.
- The nonexistent command was never invoked.

Refresh failure preservation:

- Restarted with `CDS_CACHE_MODE=refresh` and the same nonexistent command.
- Cached nodes were served with `cacheHit: true` and warnings containing
  `refresh failed; serving the previously cached copy` plus the underlying
  `search-failed` message.
- Cached source remained intact.

Depth cap:

- Requested `maxDepth: 10`; response `graph.maxDepth: 4`.

Index rebuild:

- `npm run repo:rebuild` reported `4 object(s)` for `DS4-100`.

---

## 4. Configuration reference

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `8787` | Backend HTTP port. |
| `ADT_COMMAND` | `adt` | ADT CLI executable. |
| `ADT_READ_TIMEOUT_MS` | `30000` | Per-invocation timeout. |
| `CDS_MAX_DEPTH` | `4` | Default depth; hard-clamped to 4. |
| `CDS_MAX_OBJECTS` | `200` | Object-count safety limit. |
| `CDS_CONCURRENCY` | `5` | Concurrent ADT reads. |
| `CDS_FIXTURE_DIR` | — | Fixture mode. |
| `CDS_REPO_ROOT` | `<repo>/storage` | Repository root. |
| `CDS_CACHE_MODE` | `cache-first` | `cache-first` / `cache-only` / `refresh`. |
| `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY` | from ADT config | System partition key. |
| `SAP_SID` / `SAP_CLIENT` | — | Optional metadata with explicit key. |

---

## 5. Known limitations and follow-ups

1. **DDIC views are metadata-only.**
   `adt` 0.4.23 exposes no working view source/structure reader. The DDIC view
   endpoint returns HTTP 500 for `V_T001`/`V_T001W` even with the documented
   `Accept` header. Views are captured as leaves via the VIT metadata URI; their
   base tables are not expanded. See `analysis.md` for the probe evidence.
2. **`dependencies.json` types remain unknown.**
   The structural artifact is generated at parse time, before child types are
   resolved. The graph and index carry the confirmed types. Enriching the
   artifact after resolution is a possible follow-up; it is not needed for
   traversal because the collector re-parses cached source.
3. **Parser gap for projection-only named arguments.**
   `@abapify/acds` fails on `currency_conversion(amount => …)` in the projection
   list. `FROM`/`JOIN` extraction still works from the partial AST and a warning
   is emitted. Unchanged from Task 001.
4. **No cross-system diff UI.**
   The repository is partitioned by system key, which is the groundwork for
   future DEV/TEST/PROD comparison.
5. **No repository auth.**
   The backend and `storage/` are local-only. Do not expose them publicly.
6. **Bulk crawling remains out of scope.**
   Depth 4 + concurrency 5 + 200-object default bound SAP load. First-time
   analyses still perform one search and one typed read per object.

---

## 6. How to run

```bash
# real SAP, cache-first (default)
npm run dev

# optional: isolate the cache and pin the system
$env:CDS_REPO_ROOT = "D:\sap-cache"
$env:CDS_REPO_SYSTEM_KEY = "DS4-100"
$env:CDS_CACHE_MODE = "cache-first"
npm run dev

# offline review of already cached objects
$env:CDS_CACHE_MODE = "cache-only"
npm run dev

# force a refresh (falls back to cached copy on failure)
$env:CDS_CACHE_MODE = "refresh"
npm run dev

# fixtures, no SAP
npm run dev:fixtures
npm run dev:frontend

# index recovery
npm run repo:rebuild
```

Example request:

```powershell
Invoke-RestMethod -Uri http://localhost:8787/api/analyze -Method Post `
  -ContentType application/json `
  -Body '{"name":"I_ChangeDocumentItem","maxDepth":1}'
```

---

## 7. Files touched (summary)

- `packages/shared/src/index.ts`
- `packages/backend/src/adt/{adt-resolver,types,validate,fixture-service}.ts`
- `packages/backend/src/adt/{adt-cli.ts}` removed
- `packages/backend/src/repository/{types,paths,atomic,hash,system-key,repository,caching-provider,rebuild-cli}.ts`
- `packages/backend/src/{collector/collector,parser/version,fixtures/load,config,index,app}.ts`
- `packages/backend/package.json`, root `package.json`, `.gitignore`
- `packages/backend/test/{adt-resolver,repository,caching-provider,collector}.test.ts`
- `packages/backend/test/adt-cli.test.ts` removed
- `packages/frontend/src/{App.tsx,api.ts,format.ts,index.css}`
- `packages/frontend/src/components/{Controls,DetailsPanel,DependencyNodeCard}.tsx`
- `README.md`
- `tasks/002/analysis.md`
- `tasks/002/implementation.md` (this file)
