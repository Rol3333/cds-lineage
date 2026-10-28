# Task 001 — Initial Implementation Results

> **Superseded in Task 002:** The `adt get --json` classification and the
> `AdtCliService` described below were replaced by search-first resolution
> (`adt search --json` + typed readers) and a local filesystem repository. See
> `tasks/002/implementation.md` and `tasks/002/analysis.md`. The parser,
> collector concepts, and graph model remain valid.

**Brief:** `abapify-cds-visualiser-initial-implementation-brief.md`
**Location:** `D:\Rolandas\code\fiori\cds-lineage`
**Milestone:** CDS dependency visualisation (column lineage out of scope)

---

## 1. Verdict

The initial implementation is **complete and working end-to-end**, verified against
the real sample `ZC_PurReqItemQRY001.asddls`. The two riskiest external dependencies
were validated directly rather than assumed:

- **`@abapify/acds` v0.4.23** parses the real DDL with **0 errors** and exposes the
  exact `source` / `joins` AST structure required for dependency extraction.
- **`adt` CLI v0.4.23** (`@abapify/adt-cli`) provides the `ddl read` / `get --json`
  workflow; the backend wraps it behind a read-only service interface.

The environment toolchain (Node v22.23.2, npm 10.9.8, git 2.53.0) was confirmed.

---

## 2. Repository reconnaissance

`D:\Rolandas\code\fiori\cds-lineage` was a **greenfield** directory containing only:

- `abapify-cds-visualiser-initial-implementation-brief.md`
- `ZC_PurReqItemQRY001.asddls` (sample DDL source)

No existing package/architecture existed to preserve or conflict with. The sample
DDL was originally UTF-16 LE (`FF FE` BOM); at some point it was re-encoded to
UTF-8 (content preserved). The reader below auto-detects both encodings, so this
does not affect the implementation.

---

## 3. Technology stack (as implemented)

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict, ESM) |
| Frontend | React 19 + Vite 8 |
| Graph UI | `@xyflow/react` 12 |
| Layout | `@dagrejs/dagre` (top-to-bottom `rankdir: TB`) |
| Backend | Node.js + Express 5, run via `tsx` |
| CDS parsing | `@abapify/acds` |
| SAP access | `adt` CLI (read-only `ddl read`, `get --json`) |
| Tests | Vitest |
| Monorepo | npm workspaces (`packages/*`) |

---

## 4. Architecture and file layout

```
cds-lineage/
├── package.json                  # workspaces + scripts (dev / test / typecheck)
├── README.md                     # setup + run documentation
├── packages/
│   ├── shared/                   # application-owned graph model
│   │   └── src/index.ts          # DependencyNode/Edge/Graph, limits, canonicalName
│   ├── backend/
│   │   ├── src/
│   │   │   ├── adt/
│   │   │   │   ├── types.ts          # CdsSourceProvider / ProcessAdapter contracts
│   │   │   │   ├── adt-cli.ts        # read-only ADT CLI wrapper + error classification
│   │   │   │   ├── process-adapter.ts# spawn adapter (arg-array, timeout, cancellation)
│   │   │   │   ├── decode.ts         # UTF-16/UTF-8 auto-detection
│   │   │   │   ├── validate.ts       # CDS name validation (rejects metacharacters)
│   │   │   │   └── fixture-service.ts# in-memory provider for tests/demo
│   │   │   ├── parser/extract-sources.ts # @abapify/acds AST → dependency sources
│   │   │   ├── collector/collector.ts # bounded traversal (depth/objects/concurrency)
│   │   │   ├── fixtures/load.ts      # loads .asddls fixtures + objectTypes.json
│   │   │   ├── config.ts / app.ts / index.ts
│   │   ├── fixtures/             # synthetic + real demo sources
│   │   └── test/                 # 41 tests (no SAP)
│   └── frontend/
│       ├── src/
│       │   ├── graph-layout.ts   # core model → React Flow (dagre)
│       │   ├── components/       # Controls, GraphCanvas, DependencyNodeCard, DetailsPanel
│       │   ├── format.ts / api.ts / App.tsx / main.tsx
│       └── vite.config.ts        # /api proxy → backend:8787
```

**Separation of concerns** (per brief §12): ADT access, parsing, dependency
collection, graph model, and UI are independent modules. The collector depends
only on the `CdsSourceProvider` interface, not on the CLI or parser internals.

---

## 5. Dependency discovery semantics

Implemented in `packages/backend/src/collector/collector.ts` and
`packages/backend/src/parser/extract-sources.ts`:

1. Retrieve the root DDL source (read-only `adt ddl read`).
2. Parse with `@abapify/acds`.
3. Extract primary `FROM` source + ordered join chain (including parenthesized
   join groups) + set-operation operands — structural AST walk, no regex.
4. Classify: `viewEntity` → CDS (expandable); `table` → table; other → CDS leaf;
   failed reads resolved via `adt get --json` (`TABL`/`VIEW` → table).
5. Recurse up to `maxDepth` (default **3**), deduplicating shared dependencies and
   terminating on cycles.
6. Build an application-owned graph and return it.

Rules honoured: root depth `0`; nodes at max depth are read but **not expanded**
(dependencies marked `not-expanded` with `errorCode: max-depth`); fetch-once per
name; bounded concurrency; partial results preserved; failed reads never treated
as dependency-free.

---

## 6. Graph model

`packages/shared/src/index.ts` — an edge means **"the `from` object depends on the
`to` object"**. `SourceKind` (`cds` | `table` | `unknown`), `NodeStatus`
(`loaded` | `not-expanded` | `read-error` | `parse-error` | `empty-source` | `unknown`),
and `ErrorCode` (mapping the brief §8 failure classes). The React Flow adapter
renders `from` above `to` with no direction inversion.

---

## 7. Verification results

### Type check

```bash
npm run typecheck   # shared + backend + frontend — all pass
```

### Tests

```bash
npm test            # 47 passed (45 backend + 2 frontend), no SAP required
```

Backend coverage: source extraction (single/multi-join/join-group, plus a
real-source regression test), collector (depth, dedup, cycle, partial failure,
object limit, invalid name, tolerant partial-parse), ADT CLI error classification
(mocked process adapter), UTF-16/UTF-8 decoding, name validation. Frontend:
top-to-bottom layout mapping.

### Live-SAP validation (real system)

`POST /api/analyze` against a connected development system for
`ZC_PurReqItemQRY001` confirmed the dependency graph is read correctly through
the ADT CLI. A real parser gap was found and handled (see §10.2): the cube
`ZC_PurReqItemCube` uses `currency_conversion(amount => …)` named-argument
syntax, which `@abapify/acds` does not parse. Extraction is now **tolerant** —
dependencies are taken from the partial AST and the projection-level parse
errors are surfaced as a graph warning rather than a hard node failure. The
node reports `loaded` with its 7 dependencies (primary + 6 joins).

### Backend end-to-end (fixture mode)

`POST /api/analyze` with `{ "name": "ZC_PurReqItemQRY001", "maxDepth": 3 }`
returned a graph of **9 nodes / 8 edges**:

```
ZC_PURREQITEMQRY001 (depth 0, cds)
└─ ZC_PURREQITEMCUBE (depth 1, cds)
   ├─ I_PURCHASEREQUISITION (depth 2, cds)
   │  ├─ I_PURCHASEREQUISITIONITEM (depth 3, cds)
   │  │  ├─ I_PURCHASEREQUISITIONACCOUNTASSIGNMENT (depth 4, not-expanded)
   │  │  └─ EKPO (depth 4, not-expanded)
   │  └─ EBAN (depth 3, table)
   ├─ T001 (depth 2, table)
   └─ MARA (depth 2, table)
```

### UI render

Verified in-browser: 9 visible React Flow nodes, 8 edges, details panel correct,
no console errors. A React Flow container-height issue (double `.canvas` wrapper)
was found and fixed; the graph now renders fully.

### Build

```bash
npm run build       # vite build succeeds
```

---

## 8. Run commands

```bash
cd D:\Rolandas\code\fiori\cds-lineage
npm install

# Against a real SAP system:
npm run dev                      # backend (ADT CLI) + frontend

# No-SAP demo (bundled fixtures, clearly labelled in UI):
npm run dev:fixtures             # fixture-mode backend
npm run dev:frontend             # frontend (open http://localhost:5173)
```

Backend environment variables: `PORT`, `ADT_COMMAND`, `ADT_READ_TIMEOUT_MS`,
`CDS_MAX_DEPTH`, `CDS_MAX_OBJECTS`, `CDS_CONCURRENCY`, `CDS_FIXTURE_DIR`.
See `README.md`.

---

## 9. Acceptance criteria — status

| Criterion | Status |
| --- | --- |
| Start via documented commands | ✅ `npm run dev` / `dev:fixtures` |
| Enter a CDS entity and request analysis | ✅ |
| Read source via ADT CLI without modifying SAP | ✅ read-only (`ddl read`, `get`) |
| Parse primary + join sources correctly (fixtures) | ✅ 41 backend tests |
| Traverse up to 3 levels by default | ✅ depth 3, boundary verified |
| Deduplicate repeated deps; cycles terminate | ✅ |
| Application-owned graph model | ✅ `packages/shared` |
| Root at top, dependencies below | ✅ dagre `TB`, test-covered |
| Zoom/pan/fit/select/details | ✅ React Flow controls + details panel |
| Errors/partial results visible, not "dependency-free" | ✅ status + error codes |
| Tests run without SAP | ✅ |
| No write/activate operations | ✅ |
| Column lineage & Electron out of scope | ✅ |

---

## 10. Known limitations / remaining work

1. **Live-SAP validation (brief Step 7, optional):** the `adt get --json` type
   mapping (e.g. `TABL`/`VIEW` → table) is implemented defensively but has not
   been exercised against a live system from this environment. It should be
   verified once `adt` is pointed at a development SAP system.
2. **Named-argument parser gap (`@abapify/acds`).** Built-ins such as
   `currency_conversion(amount => …, target_currency => …)` are not parsed. This
   only affects the *projection list*, so dependency extraction is unaffected:
   `FROM`/`JOIN` sources are still extracted from the partial AST and the parse
   errors are surfaced as warnings. The smallest correct long-term fix is a
   parser change in `@abapify/acds`; no regex workaround is applied. A
   regression test against a real `ZC_PurReqItemCube` source locks this in.
3. **Table vs unknown classification** depends on `adt get --json` output;
   sources that cannot be resolved are shown as `unknown` rather than guessed.
4. **ESM-only `@abapify/acds`** forces an ESM backend (run via `tsx`); acceptable
   for this milestone, worth revisiting if a compiled deploy target is added.
5. Column/field lineage, Electron packaging, and write operations remain out of
   scope, as specified.

---

## 11. Notes

- A `get.ps1` script exists in the project root (not created as part of this
  task); it re-reads the sample DDL and writes it as UTF-8. It was left untouched.
- `git init` was run; no commit has been created yet.
