# Task 002 — SAP Repository Resolution: Analysis

**Date:** 2026-10-28
**Environment:** `adt` CLI 0.4.23, `@abapify/acds` 0.4.23, SAP system `DS4` client `100`, Windows / PowerShell.
**Scope:** read-only probes. No SAP writes were performed.

This document records the CLI behaviour that drove the search-first resolver and
typed-reader dispatch, including the exact stdout/stderr split, the DDIC view
blocker, and the live verification of the implemented cache.

---

## 1. Verdict

- `adt get <name>` is **not usable as a resolver** in this environment. It
  reports `Object '<name>' not found` for both a CDS entity and a DDIC table and
  exits with code **0**. Using it would produce false negatives and could not
  distinguish "not found" from "unsupported type".
- `adt search --json <name>` works and returns exact-name candidates with
  `type`, `uri`, `packageName`, and `description`.
- Typed readers work and are type-specific:
  - `adt ddl read` for CDS,
  - `adt table read` for transparent tables,
  - `adt structure read` for DDIC structures (`TABL/DS`),
  - `adt fetch` of the VIT metadata URI for DDIC views (metadata only).
- The resolver therefore searches, selects **exact-name** candidates, and
  dispatches by base type/subtype. A typed-reader failure is reported as a
  **read failure**, never re-interpreted as a different object type.
- DDIC views have **no working source/structure reader** in this CLI version.
  They are captured as metadata-only leaves rather than guessed or dropped.

---

## 2. Output-channel findings

### 2.1 Repository search writes everything to stdout

Command:

```powershell
adt search --json I_ChangeDocumentItem
```

Observed (captured with `child_process.spawn`, separate streams):

| Stream | Length | Content |
| ------ | -----: | ------- |
| stdout | 684 bytes | `🔍 Searching for: "I_ChangeDocumentItem" (max: 50 results)...\n\n` + pretty-printed JSON array + `\n\n✅ Search complete!\n` |
| stderr | 0 bytes | empty |
| exit code | 0 | success |

The JSON is **not the whole stdout**. It is surrounded by a human banner and a
success footer. Stdout is also used for the "no results" message:

```text
🔍 Searching for: "NO_SUCH_OBJECT_XYZ" (max: 50 results)...

No objects found matching your query.
```

- Exit code: **0**.
- stderr: empty.
- No JSON array is present.

**Implication:** parse a JSON array from stdout (string-aware bracket matching),
not the entire stdout as JSON. Do not use stderr to decide success. Treat "no
JSON array + exit 0" as `not-found`, not as a connection failure.

`adt search` does **not** support `--type`:

```text
$ adt search --json CDPOS --type TABL
exit code: 1
stderr: error: unknown option '--type'
```

Search without a wildcard returns candidates of all matching types for the
exact name (for example `I_ChangeDocumentItem` returns `DCLS/DL`, `DDLS/DF`, and
`STOB/DO` candidates). Type resolution must therefore be done by selecting the
supported candidate, not by asking the CLI to filter.

### 2.2 Typed reads write payload to stdout and progress to stderr

| Command | stdout | stderr | Exit |
| ------- | ------ | ------ | ---: |
| `adt ddl read I_ChangeDocumentItem` | 4,937-byte CDS DDL | 120 bytes of `🔍 Loading …` / `📄 Fetching source...` progress with ANSI `\r\u001b[K` sequences | 0 |
| `adt table read CDPOS` | 1,601-byte table DDL | 90 bytes of the same progress output | 0 |
| `adt structure read BAPIRET2` | 904-byte structure DDL | 96 bytes of the same progress output | 0 |

Representative stderr for `ddl read`:

```text
🔍 Loading I_CHANGEDOCUMENTITEM...\r\u001b[K🔍 Loading I_CHANGEDOCUMENTITEM...\n
📄 Fetching source...\r\u001b[K📄 Fetching source...\n
```

**Implication:** use **stdout bytes** as the payload and the **exit code** as the
success signal. stderr is progress/diagnostics, not source. Decode stdout as
UTF-8 (the reader also handles a UTF-16 BOM for PowerShell-redirected captures).
Do not merge stderr into the stored source.

### 2.3 `adt fetch` wraps XML in a banner/footer

The VIT metadata fetch prints a human prefix and suffix on stdout, e.g.:

```text
🔄 GET /sap/bc/adt/vit/wb/object_type/viewdv/object_name/V_T001...

<?xml version="1.0" encoding="utf-8"?><adtcore:mainObject …>…</adtcore:mainObject>

✅ Done!
```

For `V_T001` the captured stdout was 579 bytes (banner + clean 497-byte XML +
footer), stderr was 0 bytes, and the exit code was 0. The stored
`source.view.xml` must contain the XML only; the implementation extracts the
first `<` through the last `>` and rejects a response with no XML payload.

### 2.4 `adt get` is a false-negative source

```text
$ adt get CDPOS --json
exit code: 0
stdout: ❌ Object 'CDPOS' not found

$ adt get I_ChangeDocumentItem --json
exit code: 0
stdout: ❌ Object 'I_ChangeDocumentItem' not found
```

Both are objects that exist and are readable by `adt table read` /
`adt ddl read`. The exit code is 0, and the message is on stdout.

**Implication:** never use `adt get` as a resolver, and never infer "not found"
from a reader failure. The resolver must search first; a typed-reader failure is
a `read-failed` result for an object that was already classified.

---

## 3. Type/subtype mapping observed

| Search type | Meaning | Reader | Result |
| ----------- | ------- | ------ | ------ |
| `DDLS/DF` | CDS DDL source | `adt ddl read` | parsed CDS; expandable |
| `TABL/DT` | Transparent table | `adt table read` | table leaf |
| `TABL/DS` | DDIC structure | `adt structure read` | structure leaf |
| `VIEW/DV` | DDIC view | `adt fetch` VIT metadata URI | metadata-only view leaf |
| `DCLS/DL` | Access control | — | `unsupported-type` |
| `STOB/DO` | Structure object | — | `unsupported-type` |
| `TRAN/T` | Transport object | — | `unsupported-type` |

Important details:

- A DDIC structure is returned by search as **`TABL/DS`**, not `STRU`.
- `adt structure read BAPIRET2` works; `adt table read BAPIRET2` returns HTTP 404.
- `adt table read --json CDPOS` returns only a minimal
  `{ "name": "CDPOS", "description": "…" }` object, not the DDL. The resolver
  uses non-JSON output for table/structure reads.
- `adt ddl read CDPOS` returns HTTP 404; `adt table read I_ChangeDocumentItem`
  returns HTTP 404. Reader selection must be based on the search type.
- `I_ChangeDocumentItem` search returns DCLS/DDLS/STOB candidates; exact-name
  selection plus supported-type filtering selects `DDLS/DF`. The real source
  parses with zero errors and its primary `FROM` is `CDPOS`.
- `V_T001` search returns `TRAN/T` and `VIEW/DV`; the supported candidate is
  `VIEW/DV`, so the resolver must not pick the first candidate.

---

## 4. DDIC view blocker (CLI 0.4.23)

Probes for `V_T001`:

| Attempt | Result |
| ------- | ------ |
| `adt get V_T001 --json` | `Object 'V_T001' not found`, exit 0 |
| `adt source get V_T001` | HTTP 404 |
| `adt table read V_T001` | HTTP 404 |
| `adt fetch /sap/bc/adt/ddic/views/v_t001` | HTTP 500 |
| same URI with `Accept: application/vnd.sap.ddic.view+xml` | HTTP 500 |
| same URI with `?version=active` | HTTP 500 |
| `adt fetch /sap/bc/adt/vit/wb/object_type/viewdv/object_name/V_T001` | works; returns `<adtcore:mainObject …>` with package ref |

The 500 is systemic (also observed for `V_T001W`), not a one-off object problem.
There is no CLI command that returns DDIC view source or its field structure in
this version.

**Decision:** capture the view as a loaded, non-expandable leaf:

- `source.view.xml` — the VIT `mainObject` XML (canonical XML only),
- `sourceFormat: "view-metadata"`,
- `metadataOnly: true`,
- a graph warning explaining the limitation.

The object is preserved in the graph and cache; its base tables are **not**
guessed or expanded.

---

## 5. Implementation consequences

1. `AdtObjectProvider` (search-first):
   - validate the name,
   - run `adt search --json <name>`,
   - extract the JSON array from stdout,
   - keep candidates whose canonical name matches exactly,
   - if none: `not-found`,
   - if more than one supported candidate: `ambiguous`,
   - if only unsupported candidates: `unsupported-type`,
   - dispatch by type/subtype,
   - return `search-failed` for search process/auth/timeout/parse failures,
   - return `read-failed` for typed-reader failures (with the underlying
     `not-found` / `empty-source` / `timeout` / `auth` / `connection` code),
   - never fall back from a failed typed reader to another reader.
2. The collector preserves `not-found`, `ambiguous`, `unsupported-type`,
   `search-failed`, `read-failed`, and `cache-miss` as distinct node error codes
   while still adding the edge. Independent branches continue.
3. The repository stores only canonical payloads:
   `source.asddls` for CDS, `source.table` for tables, `source.structure` for
   structures, `source.view.xml` for views.
4. Depth is capped at 4. Four levels below the root are read; a reference found
   at depth 5 is rendered as `not-expanded` and is not fetched.

---

## 6. Live verification of the implementation

The backend was run read-only against `DS4` client `100` with
`CDS_REPO_ROOT` pointing at a temporary directory.

### Cache-first

`GET /api/health`:

```json
{"status":"ok","fixtureMode":false,"cacheMode":"cache-first","systemKey":"DS4-100"}
```

`POST /api/analyze` with `{ "name": "I_ChangeDocumentItem", "maxDepth": 1 }`:

- First run: 2 nodes, 1 edge (`I_CHANGEDOCUMENTITEM -> CDPOS`, role `primary`),
  `cache = { mode: "cache-first", hits: 0, misses: 2 }`.
- Second run: `cache = { hits: 2, misses: 0 }`; both nodes `cacheHit: true`.
- `CDPOS` was resolved as `TABL/DT` and captured as a table leaf.
- Files created under `sap/DS4-100/packages/...`:
  `source.asddls` (4,937 bytes), `source.table` (1,601 bytes), plus
  `metadata.json`, `parsed.json`, and `dependencies.json`.

Other roots:

| Root | Result |
| ---- | ------ |
| `CDPOS` | `TABL/DT` table leaf |
| `BAPIRET2` | `TABL/DS` structure leaf (`adt structure read`) |
| `V_T001` | `VIEW/DV` metadata-only view leaf + warning |

`source.asddls`, `source.table`, `source.structure`, and `source.view.xml` were
all **UTF-8 without BOM**. `system.json` and `package.json` were present, and
`source.view.xml` contained clean XML without the fetch banner/footer.

`npm run repo:rebuild` reported **4 object(s)** for `DS4-100`.

### Cache-only (offline proof)

The backend was restarted with `CDS_CACHE_MODE=cache-only` and
`ADT_COMMAND=definitely-not-adt` (a command that does not exist).

- `I_ChangeDocumentItem` resolved fully from cache: 2 nodes, `hits: 2`,
  `misses: 0`.
- `BAPIRET2` and `V_T001` resolved from cache: `hits: 1` each.
- `NOT_CACHED_OBJECT` returned a `read-error` node with
  `errorCode: "cache-miss"` and a warning; the process never tried to invoke the
  nonexistent ADT command.

This proves `cache-only` is genuinely offline.

### Refresh failure preserves the cache

The backend was restarted with `CDS_CACHE_MODE=refresh` and
`ADT_COMMAND=definitely-not-adt`.

- The cached nodes were still served (`cacheHit: true`).
- Each node got a warning: `refresh failed; serving the previously cached copy`
  with the underlying `search-failed` message.
- No cached source was deleted or overwritten.

### Depth cap

`POST /api/analyze` with `maxDepth: 10` returned `graph.maxDepth: 4`. The
collector clamps the request; the UI only offers 1–4.

---

## 7. Remaining issues / risks

- **DDIC view depth:** views are metadata-only leaves; their base tables cannot
  be discovered in CLI 0.4.23. This is documented in the UI warning and README.
- **Search output format:** the banner/footer is human-oriented and may change.
  The parser is deliberately tolerant (string-aware array extraction) but a
  future CLI change should be re-probed.
- **`adt get` false negatives:** any future code that reintroduces `adt get` as
  a classifier would silently lose objects. The resolver test asserts that `get`
  is never called.
- **`dependencies.json` types:** the artifact stores `objectType: null` /
  `resolution: "unknown"` because types are confirmed later by the collector.
  The graph is authoritative for resolved types.
- **SAP load:** the first analysis performs one search and one typed read per
  object, bounded by concurrency 5 and depth 4. Repeat analyses are cache hits.
  Large graphs can still hit `CDS_MAX_OBJECTS` (default 200); the result is
  marked `truncated` with `limitReached: "max-objects"`.
- **Parser gap:** `@abapify/acds` fails on projection-only named-argument syntax
  (e.g. `currency_conversion(amount => …)`). Dependency extraction tolerates the
  partial AST and emits a warning; this is unchanged from Task 001.
- **No cross-system diff UI:** the repository is partitioned by system key, but
  comparing systems is future work.
