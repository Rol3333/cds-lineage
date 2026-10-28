# Task: Implement a Filesystem-Based SAP Object Repository

## Objective

Add a local, filesystem-based repository to the existing Abapify CDS Visualiser so SAP objects retrieved through ADT can be saved, indexed, reused, and analysed offline.

Use ordinary files plus a lightweight index. **Do not introduce SQLite or another database in this task.**

The repository should be generic enough to support future SAP object types and future comparison of objects across DEV, TEST, and PROD systems, while keeping the initial implementation focused on CDS definitions and the dependency collector already built.

## Current project context

The application is a TypeScript npm-workspaces monorepo in:

`D:\Rolandas\code\fiori\cds-lineage`

Current packages:
- `packages/shared` — application-owned `DependencyGraph` model; edges mean dependent → dependency.
- `packages/backend` — Node.js + TypeScript ESM backend, ADT CLI wrapper, `@abapify/acds` extraction adapter, bounded dependency collector.
- `packages/frontend` — React + Vite + React Flow UI.
- The parser `@abapify/acds` v0.4.23 successfully parses the supplied real CDS fixture `ZC_PurReqItemQRY001.asddls`.
- The ADT DDL read output has been observed as UTF-16 LE with BOM in one environment; other local files may be UTF-8. The existing source reader reportedly detects UTF-16 LE and UTF-8.
- The repository was initialised with Git, but the initial implementation may not yet have a commit.
- Inspect the actual current repository before editing. Do not assume this brief exactly matches the current code.

## Scope

Implement the local repository and integrate it into the backend dependency retrieval path.

### 1. Repository layout

Use a configurable storage root, with a sensible default under the project (for example `storage/`), and keep generated cache data out of source-controlled files by adding the appropriate ignore rule.

Organise data by SAP system identity, then package where known. Suggested shape:

```text
storage/
└── sap/
    └── <system-key>/
        ├── system.json
        ├── index.json
        └── packages/
            ├── <safe-package-key>/
            │   ├── package.json
            │   └── objects/
            │       └── <safe-object-key>/
            │           ├── source.asddls
            │           ├── metadata.json
            │           ├── parsed.json
            │           └── dependencies.json
            └── _unassigned/
                └── objects/
                    └── ...
```

This layout is illustrative, not rigid. Inspect existing conventions and choose the simplest robust design. Package and object paths must be safe on Windows and other supported platforms. Never use untrusted SAP names directly as path segments without sanitisation and validation. Preserve the original SAP object name in metadata. Support objects with no known package.

### 2. Object identity and metadata

Define a generic cached-object record that can represent at least:
- SAP system identity (including SID and, where relevant, client/connection identity)
- Object name, preserving SAP spelling/case
- Object type (`DDLS`, `TABL`, `VIEW`, or an unknown/unclassified type)
- Package assignment, when known
- Retrieval timestamp
- Content hash for source or canonical object payload
- Source/payload format and encoding
- Parser name/version and derived-artifact version where relevant
- Whether metadata/classification is confirmed or unknown

Avoid storing credentials, tokens, passwords, or other secrets.

SID alone may not uniquely identify environments. Define a stable system key from configured non-secret connection identity, or make the identity explicitly configurable. Do not assume DEV, TEST, and PROD can be distinguished by SID alone. The design should make cross-system comparison possible later without implementing comparison now.

### 3. Stored artifacts

For a CDS object, persist:
- `source.asddls` — source in UTF-8 without BOM for consistent local use, preserving all Unicode characters
- `metadata.json` — generic identity, SAP metadata, retrieval information, hash and classification confidence
- `parsed.json` — serialisable application-owned representation of parser output or extracted structure, not a fragile dump of parser internals unless the existing code already deliberately supports that
- `dependencies.json` — direct dependencies extracted structurally, with dependency name/type where known and unresolved/unknown classification represented explicitly

Not every SAP object has CDS source. For non-CDS objects, store the best available metadata/canonical payload in a clearly named artifact, and do not create fake `.asddls` source files.

The source is the primary cached artifact. Parsed output and dependency information are derived artifacts that must be reproducible from source and the current parser/extraction implementation.

Use the existing `@abapify/acds` adapter where possible. Do not use regular expressions as the primary mechanism for extracting CDS dependencies.

### 4. Index

Use a JSON index, not a database.

The index should support efficient-enough lookups by:
- object identity within a system
- object name and type
- package
- stored artifact paths
- last retrieval/update time

Keep index format versioned. Avoid rewriting it unnecessarily. Make writes resilient to interruption (temporary file + atomic rename/replace where supported). If an index is missing, malformed, or stale, report the issue and provide a clear rebuild/recovery path rather than silently losing objects. A rebuild should be possible by scanning repository metadata files.

The index is a lookup optimisation; per-object metadata/files are the durable source of truth.

### 5. Repository API

Create a backend service/interface with operations equivalent to:
- `getObject(system, objectIdentity)` — retrieve cached record/artifacts if present
- `saveObject(...)` — persist source/payload, metadata and derived artifacts
- `findObjects(...)` — filter by name/type/package
- `listPackages(system)`
- `rebuildIndex(system)` — reconstruct index from on-disk metadata
- `markDerivedArtifactsStale(...)` or equivalent version/hash checks

Use project naming conventions if they already exist. Keep filesystem operations separate from ADT retrieval and parsing so each can be tested independently.

### 6. Integrate with dependency collection

Update the current collector/backend flow so that:
1. It checks the local repository first.
2. On a cache hit, it can use the cached source and valid derived data without an SAP connection.
3. On a cache miss, the existing read-only ADT service fetches the object and saves it locally.
4. It extracts and persists dependencies and parsed data.
5. It recursively resolves dependencies using existing depth, object-count, concurrency and cycle protections.
6. A previously cached graph can be rebuilt/opened with SAP disconnected, provided all required objects are cached.
7. The collector supports a cache-only/offline mode that never tries to connect to SAP and reports missing objects clearly.
8. A refresh mode can force retrieval from SAP and update cached artifacts.

Do not classify an object as a table solely because `adt ddl read` failed. Preserve unknown/unresolved classifications and distinguish an absent object from authorization, connectivity, timeout, or unsupported-type errors where the available ADT responses allow that distinction.

Avoid making the frontend depend on filesystem paths or repository implementation details. Expose appropriate backend APIs.

### 7. Cache consistency and safety

- Calculate and store a content hash (for example SHA-256) for the primary source/payload.
- When source content changes, regenerate parsed/dependency artifacts.
- Record parser/extractor versions so stale derived artifacts can be detected and regenerated offline.
- When the parser changes, cached source should not need to be fetched again from SAP.
- Write individual artifacts safely using temporary files and atomic replacement where supported.
- Avoid path traversal, unsafe names, and writes outside the configured storage root.
- Preserve a previously valid cached object if a refresh fails.
- Treat stored SAP source/metadata as potentially sensitive. Keep the cache local by default and do not expose unrestricted filesystem access over HTTP.
- Do not silently overwrite a good cache entry with a partial or failed retrieval.

### 8. Configuration and user-facing behavior

Add documented configuration for:
- storage root
- cache policy: `cache-first`, `cache-only`, or `refresh`
- optionally a cache freshness/refresh setting if it fits the existing architecture

Defaults:
- `cache-first`
- bounded current collector limits remain in force
- local storage is excluded from Git
- no secrets in cache files

Do not build a full cache-management UI in this task. Minimal API/configuration and clear status/error reporting are enough. If adding a small indication of cache use to existing responses is straightforward, do so without expanding UI scope.

### 9. Future cross-system comparison (design for it, do not implement it)

Prepare the identity and metadata model so objects can later be compared across DEV, TEST, and PROD:
- distinguish source system/environment identity from object name/type
- retain content hashes and retrieval timestamps
- make it possible to compare the same logical object across system keys
- do not assume that matching names mean identical content
- do not implement cross-system diff UI or migration tooling in this task

### 10. Tests and acceptance criteria

Add automated tests for at least:
- saving and loading a CDS source with Lithuanian and other non-ASCII characters
- UTF-8 normalisation of persisted `.asddls` source
- object identity separation across two SAP systems with the same object name
- package-assigned and unassigned objects
- safe handling of namespace-style and unsafe names
- index writes and recovery/rebuild when the index is missing or malformed
- content hash changes when source changes
- stale parsed/dependency artifact detection after parser/extractor version changes
- cache hit without invoking ADT
- cache miss invokes mocked ADT and persists result
- cache-only mode does not invoke ADT and reports missing objects
- refresh mode invokes ADT and preserves existing valid cache if refresh fails
- recursive dependency collection from cache with SAP unavailable
- partial results when a dependency is missing or cannot be classified
- tests run without access to a live SAP system

Run the existing tests and typecheck/build scripts that are available. Fix regressions caused by this task. Report commands run and actual outcomes; do not claim live SAP verification unless it was performed.

## Non-goals

- No SQLite or other database.
- No cross-system comparison UI or diff algorithm yet.
- No bulk package crawler unless the current architecture already has a small reusable capability; focus on objects discovered from a requested root and its dependencies.
- No write/activation operations in SAP.
- No credentials in cache metadata.
- No major redesign of the React Flow UI.

## Implementation approach

Proceed in small, testable increments:
1. Inspect the current repository and existing tests, scripts, ADT service, collector and parser adapter.
2. Propose a short implementation map identifying files/modules to add or change.
3. Implement identity, filesystem artifact store and JSON index.
4. Add unit tests for persistence, path safety, encoding and index recovery.
5. Integrate cache-first/cache-only/refresh behavior into the collector.
6. Add mocked integration tests for offline recursion and failed refresh behavior.
7. Update documentation with storage layout, configuration, cache modes and limitations.
8. Run tests, typecheck and build; report exact outcomes and any remaining gaps.

Keep changes focused. Do not refactor unrelated modules. Do not silently change existing graph edge semantics or collector safety limits. If a design decision is genuinely blocked by missing repository information, inspect the code first and ask only the essential question.
