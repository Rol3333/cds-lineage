# Abapify CDS Visualiser — Initial Implementation Brief

## 1. Purpose

Build the first working version of a web-based tool that visualises dependencies between SAP ABAP CDS entities.

The user enters a CDS entity name. The application reads its DDL source from a connected SAP system using the existing ADT CLI workflow, parses that source with `@abapify/acds`, discovers the sources referenced by its `FROM` and `JOIN` clauses, and renders the dependency graph.

The initial milestone is **CDS dependency visualisation**, not complete column lineage. Design the foundations so a later, separate **column lineage view** can reuse source retrieval, parsing, and graph-model services.

## 2. Scope

### In scope
- Browser-based UI.
- TypeScript, consistent with the Abapify JavaScript/TypeScript ecosystem.
- React for the UI.
- React Flow (`@xyflow/react`) for interactive graph rendering.
- Node.js + TypeScript backend/service for ADT CLI invocation, source retrieval, parsing, and dependency collection.
- `@abapify/acds` as the CDS parser.
- Default maximum dependency depth of **3 levels below the root CDS**.
- Top-to-bottom graph layout: requested CDS at the top, dependencies below.
- Zoom, pan, fit-to-view, node selection, and a node details panel.
- Distinguish CDS entities, database tables, and unknown source types where possible.
- Handle repeated dependencies, cycles, read failures, and parse failures visibly.
- Automated tests using fixtures, plus setup/run documentation.

### Out of scope
- Column/field lineage and expression-level source mapping.
- Any SAP write operation: create, save, update, activate, or delete.
- Writing a CDS parser from scratch or replacing `@abapify/acds`.
- SAP release/dialect validation.
- A comprehensive SAP object browser.
- Electron packaging.
- Sophisticated graph analytics or a custom graph-rendering engine.

Keep the design extensible, but do not implement future features prematurely.

## 3. Proposed technology stack

- **Language:** TypeScript.
- **Frontend:** React + Vite, unless the repository already has a suitable setup.
- **Graph UI:** React Flow via `@xyflow/react`.
- **Layout:** directed top-to-bottom layout; start with Dagre if suitable, and consider ELK only if real graph structures require more advanced placement.
- **Backend:** Node.js + TypeScript.
- **SAP access:** existing ADT CLI workflow.
- **CDS parsing:** `@abapify/acds`.
- **Graph model:** application-owned typed model, independent of React Flow and parser AST internals.
- **Desktop packaging:** Electron may be evaluated later, but is not in this milestone.

Inspect the repository and reuse its conventions before adding dependencies or scaffolding. Do not replace existing build tooling without a clear reason.

## 4. SAP source retrieval

The developer has tested this command successfully:

```powershell
adt ddl read ZC_PurReqItemQRY001 > ZC_PurReqItemQRY001.asddls
```

Documentation: https://adt-cli.netlify.app/guides/cds-authoring

Use the equivalent programmatic or controlled process invocation supported by the installed ADT CLI version. Inspect the package documentation and repository before assuming a particular SDK API.

The backend must be **read-only**. It may retrieve source and metadata, but must not invoke write, save, activate, create, update, or delete operations against SAP.

Requirements:
- Never execute arbitrary commands supplied by the browser.
- Validate CDS names as object identifiers before passing them to the CLI.
- Prefer argument-array process invocation over constructing a shell command string.
- Capture stdout, stderr, exit status, and timeout/cancellation where feasible.
- Treat command failures as explicit errors, not as empty source.
- Never log credentials, cookies, authorization headers, or sensitive connection details.
- Do not expose local filesystem paths or secrets to the browser.
- Do not persist retrieved source by default unless the existing project has an explicit cache policy.
- Put ADT access behind a small service interface so tests can use fixtures without SAP.

## 5. Dependency discovery semantics

For the requested root CDS:

1. Retrieve its DDL source.
2. Parse it using `@abapify/acds`.
3. Extract all relevant source declarations from the CDS `FROM` structure, including the primary source and sources introduced by joins.
4. Classify sources where possible.
5. For each expandable CDS dependency, retrieve and parse its source.
6. Repeat until the configured maximum depth is reached.
7. Build a graph model and return it to the frontend.

Rules:
- Root depth is `0`. Maximum depth `3` permits dependencies at depths `1`, `2`, and `3`.
- Do not expand nodes at the maximum depth.
- Depth limits levels, not total object count. Add a configurable maximum-object safety limit.
- Fetch each unique object at most once per analysis where possible; do not refetch for every incoming edge.
- Use bounded concurrency for ADT reads.
- Detect cycles and represent cycle edges without recursing indefinitely.
- A source mentioned in an `ON` condition is not a new dependency merely because it appears there. Dependencies come from source declarations in `FROM`/`JOIN`.
- Do not treat every source as a CDS entity. Tables and other source types may be leaf nodes.
- Do not silently omit unresolved, inaccessible, or unparsable dependencies. Return a status/error on the relevant node or edge and display it.
- Prefer structured AST extraction over regular expressions for nested source structure.
- Do not add release-specific syntax validation. This is structural extraction from source retrieved from a working SAP system.

If the parser does not expose enough structure to extract a dependency safely, document the gap and add a focused adapter/test or propose the smallest required parser change. Do not silently guess.

## 6. Application-owned graph model

Define typed graph data independent of React Flow and raw parser AST objects. A possible starting point (adapt to repository conventions):

```ts
type SourceKind = "cds" | "table" | "unknown";

type NodeStatus =
  | "loaded"
  | "not-expanded"
  | "read-error"
  | "parse-error"
  | "unknown";

interface DependencyNode {
  id: string;             // stable identity, normally canonical object name
  name: string;
  kind: SourceKind;
  depth: number;
  status: NodeStatus;
  expandable: boolean;
  errorMessage?: string;
}

interface DependencyEdge {
  id: string;             // stable identity for a source relationship
  from: string;           // dependent object
  to: string;             // referenced dependency/source object
  sourceRole?: string;    // e.g. primary source or join source, if available
}

interface DependencyGraph {
  rootId: string;
  maxDepth: number;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  warnings: string[];
}
```

This is illustrative, not a mandate to copy it verbatim. Refine edge direction and naming consistently. Semantically, an edge must mean **“the source object depends on this referenced object.”**

- Core relationship: dependent object → referenced dependency.
- Visual layout: dependent above its dependencies.
- If React Flow edge rendering requires inverted direction for the desired layout, transform it in the React Flow adapter, not in the core model.
- A shared dependency should be one node with multiple relationships, not duplicated nodes.
- Avoid building a general graph framework.

## 7. UI requirements

Create a simple, professional browser UI suitable for an SAP developer or solution architect.

### Controls
- CDS entity input.
- Maximum depth control defaulting to `3`.
- Button to start dependency analysis.
- Loading/progress feedback.
- Clear success, partial-success, and failure states.

### Graph canvas
- Top-to-bottom layout, root at the top and dependencies below.
- Custom React Flow nodes for CDS entities, database tables, and unknown/unresolved sources.
- Visually distinguish node kinds and error/not-expanded statuses.
- Zoom, pan, fit-to-view, and node selection.
- Keep labels readable and avoid overlap where possible.
- Informative empty state before the first analysis.
- Do not show fabricated sample data as production results. Fixtures may be used in tests and clearly labelled demos.

### Details panel
When a node is selected, show available details:
- Object name.
- Source kind.
- Depth.
- Retrieval/parse/expansion status.
- Error details or warnings.
- Direct dependencies, if available.

Never expose credentials or sensitive backend details.

Column lineage is a separate future view. Do not implement it now. Preserve useful structured information, but do not couple the UI to internal parser AST structures.

## 8. Error handling and system protection

- Default maximum depth: `3`.
- Configurable maximum object count per analysis.
- Bounded concurrency for ADT reads.
- Reuse results within one analysis.
- Cycle detection.
- Sensible request timeout and cancellation if feasible.
- Distinguish invalid object name, ADT/authentication/connection failure, object not found or inaccessible (if distinguishable), empty source, parse failure, unknown source type, maximum depth reached, and maximum object count reached.
- Keep partial results displayable if one branch fails.
- Never interpret a failed retrieval as a dependency-free CDS object.

## 9. Testing strategy

Use deterministic tests with saved and sanitised CDS fixtures. Most tests must not require SAP.

Include tests for:
1. Simple CDS with one source.
2. CDS with multiple joins.
3. A CDS whose source is another CDS.
4. A CDS with both table and CDS sources.
5. A dependency chain reaching exactly depth `3`.
6. No expansion beyond configured depth.
7. Repeated references to the same object.
8. A cycle between sources.
9. A read failure in one branch while another branch succeeds.
10. Parse failure or incomplete AST information.
11. Maximum object count and bounded concurrency where practical.
12. Stable edge semantics and top-to-bottom presentation mapping.

Keep any live-SAP integration/smoke test optional and separate from normal tests. Never require SAP credentials in CI.

## 10. Suggested implementation sequence

Work in small, reviewable increments. Inspect and report the repository structure before making broad changes.

### Step 1 — Repository and package reconnaissance
- Inspect repository structure, package scripts, existing frontend/backend architecture, and how `@abapify/acds` is consumed.
- Verify the installed ADT CLI invocation/API and documentation.
- Confirm parser AST representation for primary and joined sources.
- Report proposed file layout and blockers before major scaffolding.
- Do not rewrite existing architecture to match this brief.

### Step 2 — Define graph contract and tests
- Add application-owned graph types.
- Add focused tests for edge semantics, identity, depth, and cycles.
- Keep the model independent of React Flow.

### Step 3 — Implement source extraction adapter
- Use the parser to extract primary and join sources.
- Add fixture tests for supported source forms.
- If parser limitations block correctness, document them and isolate any workaround.

### Step 4 — Implement ADT read service
- Add a controlled, read-only wrapper around the tested ADT CLI workflow.
- Test success, stderr/exit errors, timeouts, and invalid names using a mocked process adapter.

### Step 5 — Implement bounded dependency collector
- Recursively fetch/parse unique sources to depth `3`.
- Add object-count and concurrency limits, cycle handling, and partial-result reporting.
- Test without SAP.

### Step 6 — Build the React Flow UI
- Add CDS input, depth control, loading/error states, graph canvas, and node details.
- Implement top-to-bottom layout.
- Add custom nodes for CDS, table, and unknown source types.

### Step 7 — End-to-end validation
- Test with `ZC_PurReqItemQRY001` in a configured development SAP system.
- Verify dependencies against its DDL source.
- Verify depth `3` means three levels below the root.
- Check performance and failure display.
- Confirm no SAP write operation is invoked.
- Document setup, configuration, tests, and known limitations.

Do not attempt all steps in one large change. Keep each increment testable and reviewable.

## 11. Acceptance criteria

The milestone is complete when:
- A developer can start the app using documented commands.
- A user can enter a CDS entity and request dependency analysis.
- The backend reads source through the established ADT CLI path without modifying SAP.
- The parser extracts primary and join sources correctly for supported fixtures.
- The collector traverses up to three dependency levels below the root by default.
- Repeated dependencies are deduplicated and cycles cannot cause infinite recursion.
- The result uses an application-owned graph model.
- The graph displays the root at the top and dependencies below.
- Users can zoom, pan, fit the graph, select nodes, and inspect status/details.
- Errors and partial results are visible and not mistaken for dependency-free nodes.
- Tests run without SAP; live validation is an optional explicit smoke test.
- No SAP write/activation operations are implemented or invoked.
- Column lineage and Electron remain future work.

## 12. Working rules for the AI coding agent

- Inspect repository and current Git branch/status first; do not overwrite or discard existing work.
- State assumptions and report meaningful architecture decisions.
- Prefer small, tested increments over a large speculative implementation.
- Do not invent undocumented ADT CLI APIs; inspect the installed version and docs.
- Do not replace the parser, implement a parallel CDS grammar, or add dialect validation.
- Do not silently guess when the parser cannot identify a source.
- Avoid unrelated features, unnecessary abstractions, or dependencies without a clear reason.
- Keep SAP access, parsing, dependency analysis, graph model, and UI separated.
- Run relevant tests and lint/type checks; report exact commands and results.
- Distinguish completed work from unverified assumptions.
- If repository inspection reveals a significant conflict with this brief, stop and explain it before sweeping changes.

## 13. Reference

ADT CLI CDS authoring guide: https://adt-cli.netlify.app/guides/cds-authoring

Tested read command:

```powershell
adt ddl read ZC_PurReqItemQRY001 > ZC_PurReqItemQRY001.asddls
```
