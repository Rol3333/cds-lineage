# Task: Update SAP Repository Crawling to Resolve Object Types Before Reading

## Objective

Update the Abapify CDS visualiser backend's SAP repository crawling logic so that it **searches the SAP repository to resolve an object's type before attempting to read it**.

Do not use `adt get <name>` as the resolver. In the current environment, it returns `Object '<name>' not found` for both a CDS entity and a DDIC table, even though repository search and the typed readers work.

The implementation should use the installed Abapify ADT CLI's `adt search` command, inspect the search results, then dispatch to the appropriate typed reader.

## Confirmed behaviour in the user's SAP environment

### Repository search returns object types and ADT URIs

Command:

```powershell
adt search "I_ChangeDocument*"
```

Representative output:

```text
🔍 Searching for: "I_ChangeDocument*" (max: 50 results)...

Found 9 object(s):

1. I_CHANGEDOCUMENT (DCLS/DL)
   Auto assigned mapping role for I_ChangeDocument
   Package: SZD
   URI: /sap/bc/adt/acm/dcl/sources/i_changedocument

2. I_CHANGEDOCUMENT (DDLS/DF)
   Change document header
   Package: SZD
   URI: /sap/bc/adt/ddic/ddl/sources/i_changedocument

3. I_CHANGEDOCUMENT (STOB/DO)
   Package: SZD
   URI: /sap/bc/adt/ddic/ddl/sources/i_changedocument/source/main#name=i_changedocument

4. I_CHANGEDOCUMENTITEM (DCLS/DL)
   I_ChangeDocumentItem
   Package: SZD
   URI: /sap/bc/adt/acm/dcl/sources/i_changedocumentitem

5. I_CHANGEDOCUMENTITEM (DDLS/DF)
   Change document items
   Package: SZD
   URI: /sap/bc/adt/ddic/ddl/sources/i_changedocumentitem
```

Command:

```powershell
adt search "CDPOS"
```

Representative output:

```text
🔍 Searching for: "CDPOS" (max: 50 results)...

Found 1 object(s):

1. CDPOS (TABL/DT)
   Change document items
   Package: SZD
   URI: /sap/bc/adt/ddic/tables/cdpos

```

The output demonstrates that repository search results include object names, object type/subtype, package, and URI. The same logical CDS name may appear under more than one object type.

### Typed readers work

These commands succeeded in the user's environment:

```powershell
adt ddl read I_ChangeDocumentItem
adt table read CDPOS
```

### `adt get <name>` does not resolve these objects

These commands failed in the user's environment:

```powershell
adt get I_ChangeDocumentItem
# Object 'I_ChangeDocumentItem' not found

adt get CDPOS
# Object 'CDPOS' not found
```

Do not assume `adt get <name>` is a generic repository-object resolver.

### `--type` is not supported by the installed `adt search`

These commands failed with `error: unknown option '--type'`:

```powershell
adt search "I_ChangeDocument*" --type DDLS
adt search "CDPOS" --type TABL
```

Therefore, search without `--type`, then filter results in the backend.

## Required crawling workflow

Implement this general flow:

1. Given a dependency name discovered in a CDS AST, call repository search for that name.
2. Parse the search results into structured candidates. Prefer a machine-readable CLI output if the installed CLI provides one; inspect the installed command's help and existing project code first. Do not invent unsupported CLI options.
3. Match candidates to the requested object name case-insensitively and classify by the reported object type.
4. Dispatch based on a confirmed type:
   - `DDLS` → `adt ddl read <object-name>`
   - `TABL` → `adt table read <object-name>`
5. Parse/cache the successfully read object using the existing application architecture.
6. Extract its dependencies and continue crawling subject to the existing depth/size/concurrency limits.
7. Record unresolved, unsupported, ambiguous, and read-failed objects distinctly. Continue crawling other branches when one dependency fails, unless existing product requirements explicitly say otherwise.

The first implementation should support `DDLS` and `TABL`. Preserve other discovered types in metadata, but do not treat them as CDS source or DDIC table unless an explicit supported handler exists.

## Important matching and classification rules

- The search term can be a wildcard/pattern, but a dependency resolver should avoid accidentally selecting an unrelated partial/prefix match.
- Search results may include several objects with the same name:
  - `I_ChangeDocumentItem (DCLS/DL)`
  - `I_ChangeDocumentItem (DDLS/DF)`
  - possibly `I_ChangeDocumentItem (STOB/DO)`
- For a request to crawl a CDS dependency, select the `DDLS` candidate rather than `DCLS` or `STOB`.
- For a request to crawl a table, select the `TABL` candidate.
- Do not assume every `STOB` candidate is an additional independent CDS source. Preserve it as metadata or ignore it for source crawling until its role is explicitly established.
- Normalize names and types for comparisons, but retain the original spelling and full search metadata.
- Do not classify an object based on a reader failure. In particular, failure of `adt ddl read CDPOS` is not proof that `CDPOS` is a table. The repository search type is the evidence used to choose the reader.
- If search returns no exact candidate, multiple equally valid candidates, or an unsupported type, report the appropriate state instead of guessing.
- Search/read output encoding may vary. Reuse or strengthen the existing encoding detection and test non-ASCII source text end-to-end.

## Suggested internal model

Adapt this to the repository's current types rather than introducing redundant abstractions. A candidate structure could include:

```ts
type SapRepositoryObjectType = "DDLS" | "TABL" | string;

interface SapRepositoryCandidate {
  name: string;
  objectType: string;   // e.g. DDLS, TABL, DCLS, STOB
  objectSubtype?: string; // e.g. DF, DT, DL, DO
  packageName?: string;
  uri?: string;
  description?: string;
}
```

A resolved object should retain both identity and outcome, for example:

```ts
type ResolutionStatus =
  | "resolved"
  | "not-found"
  | "ambiguous"
  | "unsupported-type"
  | "search-failed"
  | "read-failed";
```

Use the existing project's error/result conventions if they already provide equivalent fields. Avoid broad refactoring.

## CLI integration requirements

- Inspect `adt search --help` and the installed CLI/package implementation to find whether search has a JSON or other structured output mode.
- Prefer structured output over parsing decorative terminal text if it is genuinely supported.
- If only human-readable output is available, implement a parser for the actual output format and test it against representative output like the examples above.
- Never pass the unsupported `--type` flag.
- Never use `adt get <name>` as the resolver for this workflow.
- Use argument-safe subprocess invocation where possible. Avoid building a shell command by concatenating untrusted object names. If the current CLI wrapper requires shell use, escape arguments appropriately and document the constraint.
- Keep the current bounded crawling controls and cache strategy intact.

## Tests

Add tests that match the current project's test framework and style. At minimum cover:

1. Search result containing `DDLS/DF` resolves to CDS and dispatches to `adt ddl read`.
2. Search result containing `TABL/DT` resolves to table and dispatches to `adt table read`.
3. Same name returned as `DCLS`, `DDLS`, and `STOB` selects `DDLS` for CDS crawling.
4. A prefix/wildcard match without an exact object name is not incorrectly selected.
5. No search match produces `not-found` without trying a typed reader.
6. Unsupported object type is recorded as unsupported and does not trigger the wrong reader.
7. Search command failure is distinct from an object not found.
8. A typed-reader failure is recorded as `read-failed`; it does not trigger fallback classification by trying another reader.
9. A failed dependency does not prevent independent dependencies from being crawled.
10. Search parsing handles descriptions/packages/URIs and realistic output; if structured JSON is available, test that parser instead.
11. Non-ASCII CDS source survives search/read, decoding, parsing, and cache write/read.

Mock the CLI/subprocess boundary for unit tests. Add a small manual smoke-test note for a connected SAP system.

## Acceptance criteria

- `I_ChangeDocumentItem` is resolved as `DDLS` and read through `adt ddl read`.
- `CDPOS` is resolved as `TABL` and read through `adt table read`.
- No resolver path relies on `adt get <name>`.
- No resolver path uses `adt search --type`.
- Duplicate result types are handled deterministically and conservatively.
- Unsupported or unresolved dependencies are visible in the result/diagnostics and do not silently disappear.
- Existing tests pass; new resolver tests pass.
- Existing graph direction, cache format, crawl limits, and frontend behaviour remain unchanged unless a minimal adjustment is required.
- Do not implement cross-system diffing in this task.

## Suggested manual verification

Run these commands against the configured SAP system:

```powershell
adt search "I_ChangeDocumentItem"
adt search "CDPOS"
adt ddl read I_ChangeDocumentItem
adt table read CDPOS
```

Then run the project's normal typecheck/test/build commands and a live crawl rooted at a CDS view that references both CDS entities and DDIC tables.

## Agent instructions

- Inspect the current repository and its existing crawler/CLI wrapper before editing.
- Make the smallest coherent change; do not rewrite the crawler architecture.
- Keep source-of-truth DDL and metadata separate from derived parsed/dependency artifacts.
- Do not add SQLite or a new database; preserve the existing filesystem/JSON cache design if present.
- Do not claim live SAP verification unless the connected commands were actually executed.
- Finish with a concise summary of changed files, tests run, any limitations, and any manual checks the user still needs to run.
