# Task 004 — UI Upgrade Proposal

**Status:** Proposed for review  
**Date:** 2026-10-28  
**Scope:** Frontend UI, shared graph model, CDS extraction, collector edge metadata  
**Related:** Task 001 (initial visualiser), Task 002 (repository/resolution), Task 003 (logging)

---

## 1. Goals

1. Replace the single long left sidebar with a tabbed sidebar: **Main**, **Details**, **Errors**.
2. Keep the analysis form and analysis summary in **Main**.
3. Move parse/diagnostic messages out of the Main tab into a dedicated **Errors** tab.
4. Show CDS view columns (and, where cheaply available, DDIC table/structure fields) in **Details** when a node is selected.
5. Make joins selectable. Clicking a join/association shows its properties and highlights the two participating node cards in the graph.
6. Extract and display CDS **associations** as first-class relationships, visually distinct from SQL joins.
7. Make graphs with several joins between several tables readable: separate connection ports, routed lanes, role colours, and selection focus.
8. Add a **Save HTML** button at the top-right of the header. It downloads a self-contained HTML report with the graph snapshot and metadata.
9. Preserve all existing safety and scope rules: read-only SAP access, no browser-supplied commands, depth cap 4, concurrency 5, max 200 objects, cache modes, no raw SAP source in logs.

### Non-goals

- Column-level lineage (only column metadata is shown).
- A new CDS parser. All extraction uses the existing `@abapify/acds` AST.
- SAP writes, activation, or deployment.
- Electron, SQLite, or another database.
- Cross-system diff UI or bulk crawling.
- Frontend logging or telemetry.
- Compliance audit logging.
- Full join-group tree visualisation (current flattened extraction is preserved; see §11).

---

## 2. Current State and Findings

### 2.1 Frontend

- `packages/frontend/src/App.tsx` renders `Controls`, a plain warning list, and `DetailsPanel` in one scrolling sidebar.
- `DetailsPanel` only accepts a node. There is no selected-edge model and no edge-click handling.
- `GraphCanvas` only handles `onNodeClick`.
- `DependencyNodeCard` has one target handle at the top and one source handle at the bottom. All edges from a parent therefore share the same start point, and all edges into a child share the same end point.
- `graph-layout.ts` uses Dagre with `rankdir: TB`, but every edge is a plain `smoothstep` edge with no port or lane separation. Labels are always shown.
- Warnings are rendered as orange boxes in the Main sidebar.

### 2.2 Parser/AST capabilities

The installed `@abapify/acds` 0.4.23 AST already provides the data needed for this task:

- `ViewElement[]` through `walkViewElements(ast)`:
  - `expression`, `alias`, `isKey`, `isVirtual`, `isRedirected`, `localized`, `type`, `notNull`.
- `AssociationDeclaration`:
  - `associationKind` (`association` / `composition`), `target`, `alias`, `cardinality`, `wordCardinality`, `on`, `toParent`, `redirected`, `withDefaultFilter`.
- `JoinClause`:
  - `joinType`, `source`, `on.source`, `on.tokens`, optional `cardinality`.
- `FieldDefinition[]` through `walkFields(ast)` for table/structure fields.

Important findings from the real `ZC_PurReqItemCube` fixture:

- It contains **116 view elements**, **6 joins**, and **14 FROM-region associations**.
- Several associations target the same `I_CalendarDate` through different aliases (`_PRCreateDate`, `_PRReleaseDate`, `_PRDeliveryDate`, …). The graph must show one target node and multiple distinct association edges.
- `walkAssociations(ast)` returned 0 associations for this fixture; the FROM associations are available via `definition.fromAssociations`. The implementation must collect:
  - `definition.fromAssociations ?? []`, plus
  - `definition.members.filter(isAssociation)`.
- Join `loc` is `undefined` in this build, so join details cannot promise source line numbers. Parser errors do have line/column.
- `ViewElement` has no `kind`; use `walkViewElements`, not a member-kind filter.
- Projection expressions generally have no type metadata; only typed elements/fields have `element.type`.

### 2.3 Cache/derived artifacts

- `ParsedArtifact` / `DependenciesArtifact` are derived from `extractSources`.
- `EXTRACTOR_VERSION` is currently `"2"`.
- Adding association/column/join-detail extraction changes structural extraction semantics, so `EXTRACTOR_VERSION` must be bumped to `"3"`. Cached source is not re-fetched; derived artifacts are regenerated from cached source as the repository already supports.

---

## 3. Proposed UX

### 3.1 Overall layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Abapify CDS Visualiser   [fixture/cache badges]        [Save HTML] │
├──────────────────────┬──────────────────────────────────────────────┤
│ [Main] [Details] [Errors]                                            │
│                      │                                              │
│  tab content         │            React Flow graph                  │
│  (scrolls)           │                                              │
│                      │                                              │
└──────────────────────┴──────────────────────────────────────────────┘
```

- Sidebar width: 360–380 px (up from 300 px) so column/condition text is usable.
- Tab bar stays fixed; only the active panel scrolls.
- Header gets a right-aligned **Save HTML** button.
- Tabs use proper `role="tablist"`, `role="tab"`, `role="tabpanel"`, and arrow-key navigation.
- The **Errors** tab shows a count badge. Parse errors are no longer orange boxes in Main.

### 3.2 Main tab

Contents:

1. Existing analysis form:
   - CDS/DDIC object name.
   - Maximum dependency depth.
   - Analyse dependencies button.
2. Analysis summary when a result exists:
   - Root object.
   - Nodes / edges.
   - Max depth.
   - Cache mode, hits, misses.
   - Truncated / limit reached banner.
3. **Associations** visibility toggle (display-only; see §3.6).
4. Legend:
   - Primary source.
   - Join types.
   - Association.
   - Set operation.
5. A compact diagnostics summary with a button that switches to the Errors tab.
6. The request-level error banner remains visible in Main if the HTTP request itself failed.

The existing warning list is removed from Main. Diagnostics live in the Errors tab.

### 3.3 Details tab

The Details tab has three states: no selection, selected node, selected edge.

#### No selection

> Select a node or a connection in the graph to inspect it.

#### Selected node

Sections:

1. **Header**
   - Object name, kind, status, depth, cache badge.
2. **Repository metadata**
   - ADT type/subtype, resolution, source (cache/SAP), stale state, error code/message.
3. **Columns** (new)
   - Table with: Name, Expression, Type, Flags.
   - Key columns marked with a key badge.
   - Flags: `localized`, `virtual`, `redirected`, `not null`.
   - Filter input and “keys only” toggle.
   - Sticky table header, maximum height, scrollable body.
   - Empty state when no column metadata is available.
4. **Associations** (new)
   - Alias, target, association/composition, cardinality, used-in-projection badge, condition preview.
   - Clicking a row selects the corresponding association edge and switches the graph focus.
5. **Depends on**
   - Existing dependency chips; clicking a chip selects that node.
6. **Parse errors** (new)
   - Line/column and message for the selected object.
   - This is in addition to the Errors tab, not a replacement.

For `ZC_PurReqItemCube`, the fixture should show 116 columns. For DDIC tables/structures, fields are shown through the same table when `walkFields` can parse the cached source.

#### Selected edge

The Details tab distinguishes joins, associations, primary-source edges, and set-operation edges.

For a **join**:

- Relationship: Join.
- Join type: inner / left outer / right outer / full outer / cross.
- From (dependent) and To (dependency) object names.
- Joined source alias and object name.
- **Left**: the aliases/objects already in scope that participate in the ON condition.
- **Right**: the newly joined source alias and object name.
- Condition: raw `on.source`, monospace and wrapped.
- Predicates: best-effort decomposed conditions, for example:
  - `_Item.PurchaseRequisition = _ZI_MMPurOrdInvAmtQty.PurchaseRequisition`
  - `_Item.PurchaseRequisitionItem = _ZI_MMPurOrdInvAmtQty.PurchaseRequisitionItem`
- Cardinality when the AST provides word-form join cardinality.
- Buttons: “Select source” and “Select target”.

For an **association**:

- Relationship: Association / Composition.
- Association alias.
- Target object.
- Cardinality (bracket or word form).
- Condition.
- Used in projection: yes/no.
- `to parent` / `redirected` flags when present.
- Buttons: “Select source” and “Select target”.

For a **primary source**:

- Relationship: Primary source.
- Alias.
- Buttons to select either side.

For a **set operation**:

- Relationship: Union / Union All / Intersect / Except.
- No ON condition.

#### “Left” and “Right” semantics

To avoid ambiguity:

- **Left** = aliases/objects that already exist in the join scope and are referenced by the ON condition.
- **Right** = the source introduced by this join/association.
- For associations, `$projection` is resolved to the current view object and shown on the left.
- The raw condition is always displayed, even when the best-effort decomposition cannot identify both sides.

### 3.4 Errors tab

The Errors tab consumes structured diagnostics instead of raw warning strings.

Features:

- Summary counts: errors, warnings, info.
- Filter chips: All / Errors / Warnings / Info.
- Category filter: parse, resolution, cache, limit, cycle, metadata, request.
- Grouped list, sorted by severity then category.
- Each item shows:
  - Severity icon/label.
  - Category badge.
  - Message.
  - Object/edge chip when applicable.
  - `line:column` for parser errors.
- Clicking an item:
  - Selects the referenced node or edge.
  - Switches to Details.
  - Highlights the object/connection in the graph.
- Empty state when there are no diagnostics.
- Fallback: if an older result has only `warnings`, convert them to `other/warning` diagnostics in the frontend.

Severity mapping:

| Source | Severity |
|---|---|
| Full parse failure | error |
| Partial parse / recovered AST | warning |
| Resolution/read failure | error |
| Cache stale/refresh fallback | warning |
| Max depth | info (intentional limit) |
| Max objects | warning |
| Cycle | warning |
| Metadata-only DDIC view | info |
| Unknown leaf type | warning |
| Request/HTTP failure | error (local, not from the graph) |

### 3.5 Canvas interactions and focus

- `onNodeClick`: select node, clear edge selection, switch to Details.
- `onEdgeClick`: select edge, clear node selection, switch to Details.
- `onPaneClick`: clear selection (or keep it; see open questions).
- When an edge is selected:
  - Endpoint node cards get a strong outline.
  - The selected edge is thicker and uses the primary colour.
  - All unrelated nodes and edges are dimmed to ~20% opacity.
  - A small overlay banner shows `From → To · relationship`.
- When a node is selected:
  - Its card is outlined.
  - Its incident edges are emphasised.
- Hovering an edge:
  - Shows the full relationship label/condition tooltip.
  - Does not change the persistent selection.
- The graph remains non-draggable and non-connectable.
- Add a “Fit graph” control if React Flow’s built-in controls are not sufficient.

### 3.6 Associations visibility

Associations are extracted and resolved by default. The Main tab gets a **Show associations** toggle:

- **On (default):** association nodes and dashed association edges are visible.
- **Off:** association edges are hidden, and nodes that are reachable only through association edges are hidden too. Nodes that also have a non-association path remain.
- Toggling is display-only; it does **not** re-run the analysis or contact SAP.
- If the selected node/edge becomes hidden, clear the selection.

This keeps the graph readable without hiding associations from users who want them.

---

## 4. Shared Data Model Changes

File: `packages/shared/src/index.ts`

### 4.1 New/changed types

```ts
export type SourceRole = "primary" | "join" | "association" | "set-operation";

export interface ObjectColumn {
  /** Display name: alias, field name, or final expression segment. */
  name: string;
  /** Projection expression, when the column is a CDS view element. */
  expression?: string;
  /** Formatted type, when the AST provides one. */
  type?: string;
  isKey: boolean;
  kind: "projection" | "field";
  localized?: boolean;
  isVirtual?: boolean;
  redirectedTo?: string;
  notNull?: boolean;
}

export interface ObjectAssociation {
  /** Association alias, e.g. `_PRReleaseDate`. */
  name: string;
  target: string;
  associationKind: "association" | "composition";
  /** Formatted bracket or word cardinality. */
  cardinality?: string;
  condition?: string;
  /** True when the alias is referenced by the projection/filter. */
  usedInProjection: boolean;
  toParent?: boolean;
  redirected?: boolean;
  defaultFilter?: string;
}

export interface ParseIssue {
  message: string;
  line: number;
  column: number;
}

export interface SourceRef {
  alias?: string;
  /** Resolved object name. */
  name: string;
}

export interface JoinPredicate {
  text: string;
  left?: string;
  operator?: string;
  right?: string;
}

export interface EdgeRelationship {
  kind: "primary" | "join" | "association" | "set-operation";
  joinType?: string;
  alias?: string;
  cardinality?: string;
  associationKind?: "association" | "composition";
  condition?: string;
  predicates?: JoinPredicate[];
  /** Aliases/objects already in scope that participate in the condition. */
  left?: SourceRef[];
  /** Newly introduced source. */
  right?: SourceRef;
  usedInProjection?: boolean;
  toParent?: boolean;
  redirected?: boolean;
  self?: boolean;
}

export type DiagnosticCategory =
  | "parse"
  | "resolution"
  | "cache"
  | "limit"
  | "cycle"
  | "metadata"
  | "request"
  | "other";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface GraphDiagnostic {
  id: string;
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  message: string;
  objectId?: string;
  edgeId?: string;
  line?: number;
  column?: number;
}

export interface DependencyNode {
  // existing fields unchanged
  columns?: ObjectColumn[];
  associations?: ObjectAssociation[];
  parseErrors?: ParseIssue[];
}

export interface DependencyEdge {
  // existing fields unchanged
  sourceRole?: SourceRole;
  joinType?: string;
  relationship?: EdgeRelationship;
}

export interface DependencyGraph {
  // existing fields unchanged
  warnings: string[];
  /** Structured diagnostics for the Errors tab. */
  diagnostics?: GraphDiagnostic[];
}
```

### 4.2 Compatibility

- `warnings` remains in the graph for backward compatibility and existing tests.
- `sourceRole` and `joinType` remain on edges. `relationship` carries the richer detail.
- New node/edge/diagnostic fields are optional, so old cached results and older frontend code remain valid.
- `AnalyzeRequest` does not change.

---

## 5. Backend Extraction Changes

File: `packages/backend/src/parser/extract-sources.ts`

### 5.1 Extraction output

Extend `ExtractionResult` with:

- `columns: ObjectColumn[]`
- `associations: ObjectAssociation[]`
- richer `sources: ExtractedSource[]`
- `definitionKinds` and `parseErrors` as today.

Extend `ExtractedSource` with optional relationship metadata:

```ts
interface ExtractedSource {
  name: string;
  role: SourceRole;
  joinType?: string;
  alias?: string;
  relationship?: EdgeRelationship;
}
```

### 5.2 Columns

- For view entities:
  - Iterate `walkViewElements(ast)`.
  - `name = element.alias ?? lastPathSegment(element.expression) ?? element.expression`.
  - `expression = element.expression`.
  - `isKey = element.isKey`.
  - `type = formatTypeRef(element.type)` when present.
  - Carry `localized`, `isVirtual`, `isRedirected`, `redirectedTo`.
- For tables/structures:
  - Iterate `walkFields(ast)`.
  - `name = field.name`, `type = formatTypeRef(field.type)`, `isKey = field.isKey`, `notNull = field.notNull`.
  - `kind = "field"`.
- Deduplicate by `name + expression`.
- Cap at 500 columns per object; add a diagnostic if truncated (defensive; 116 is normal).
- Partial AST is acceptable: `walkViewElements` still returns usable columns even when the parser reports projection-list errors.

### 5.3 Associations

Collect both sources:

```ts
const fromAssociations = definition.fromAssociations ?? [];
const memberAssociations = definition.members.filter(isAssociation);
```

Do **not** rely only on `walkAssociations` for 0.4.23: it returned zero for the real cube’s FROM associations.

For each association:

- `name = association.alias ?? association.target`.
- `target = association.target`.
- `associationKind = association.associationKind`.
- `cardinality = formatCardinality(association.cardinality, association.wordCardinality)`.
- `condition = association.on?.source`.
- `defaultFilter = association.withDefaultFilter?.source`.
- `toParent`, `redirected`.
- `usedInProjection`: token-based check of the association alias against:
  - all `ViewElement.expression` values,
  - `where`, `groupBy`, `having` when available.
- Add an `ExtractedSource` with `role: "association"` and a relationship object.
- Deduplicate identical `target + alias + condition` declarations.
- Preserve multiple associations to the same target when aliases differ.

### 5.4 Join relationship details

For each join:

- `joinType = join.joinType`.
- `condition = join.on?.source`.
- `right = { alias: source.alias, name: source.name }`.
- `predicates = parsePredicates(join.on?.tokens ?? [])`.
- Resolve `left` aliases against a scope map built while walking:
  - Start with the primary source alias/name.
  - Add each join source as it is encountered.
  - `$projection` maps to the current view name for associations.
- Split predicates on top-level `and`/`or`, but do not split the `and` inside `between … and …`.
- For each predicate, capture the first comparison operator (`=`, `<>`, `<`, `<=`, `>`, `>=`, `between`, `like`) and the left/right token expressions.
- The raw `condition` remains authoritative; structured predicates are best-effort display data.

Join groups:

- Preserve the current flattened extraction.
- Attach the join type/condition to the source introduced by each join.
- Do not attempt to render the parenthesised group as a nested subgraph in this task.

### 5.5 Repository artifacts

- Extend `ParsedArtifact.sources` and `DependenciesArtifact.dependencies` with optional relationship fields, columns, and associations as appropriate.
- Keep artifact `schemaVersion: 1`; all additions are optional.
- Bump `EXTRACTOR_VERSION` from `"2"` to `"3"`.
- The existing stale-derived-artifact path regenerates `parsed.json` / `dependencies.json` from cached source without contacting SAP.

---

## 6. Collector Changes

File: `packages/backend/src/collector/collector.ts`

### 6.1 Associations as dependencies

- Add association sources to the normal dependency traversal with `sourceRole: "association"`.
- Association targets are resolved and read exactly like joins:
  - `DDLS` → expandable CDS.
  - `TABL`/`DT` → table leaf.
  - `TABL`/`DS` → structure leaf.
  - `VIEW`/`DV` → metadata-only leaf.
  - Unsupported/unknown → explicit unknown node.
- Association targets count toward depth and max-object limits.
- To avoid associations starving structural joins:
  1. Process primary/join/set-operation sources first.
  2. Process association sources afterwards.
  3. If `maxObjects` is reached before an association is added, record a diagnostic and skip the remaining associations for that node.
- Preserve partial results and independent branches as today.

### 6.2 Self-associations

- A self-association (`target === node.id`) is kept as an edge with `relationship.self = true`.
- It is not treated as a traversal cycle and does not produce a cycle warning.
- It is rendered as a compact self-loop or a self badge if React Flow self-loops prove visually unstable.
- Ordinary self-references in joins remain cycles as today.

### 6.3 Edge metadata

`addEdge` gains an optional relationship object:

```ts
addEdge(from, to, role, joinType, relationship)
```

- Edge IDs keep the existing deterministic `from->to` / `from->to#n` scheme.
- Multiple aliases to the same target produce multiple edges with distinct IDs.
- `node.dependencies` remains deduplicated by object id.

### 6.4 Diagnostics

Add a helper that writes both the legacy warning string and a structured diagnostic:

```ts
const addDiagnostic = (diagnostic: Omit<GraphDiagnostic, "id">) => {
  diagnostics.push({ id: `diag-${diagnostics.length + 1}`, ...diagnostic });
  warnings.push(diagnostic.message);
};
```

Refactor existing warning sites to use it:

- resolution failures → `resolution/error`, `objectId`
- cache stale/refresh fallback → `cache/warning`, `objectId`
- partial parse → `parse/warning`, `objectId`, line/column
- full parse failure → `parse/error`, `objectId`, line/column
- max depth → `limit/info`, `objectId`
- max objects → `limit/warning`, `objectId`
- cycle → `cycle/warning`, `objectId`
- DDIC view metadata-only → `metadata/info`, `objectId`
- unknown leaf type → `resolution/warning`, `objectId`

Attach parser issues to the node:

```ts
node.parseErrors = extracted.parseErrors;
```

For a full parse failure, keep the existing `parse-error` status and error message; the Errors tab can show all parser issues.

### 6.5 Logging

- No new source payload logging.
- Existing analysis warning logs continue to use the warning strings.
- Optionally log diagnostic counts/categories at `debug`, never full conditions or source text.
- Frontend export/logging remains out of scope.

---

## 7. Graph Layout and Edge Routing

File: `packages/frontend/src/graph-layout.ts` and new/updated graph components.

### 7.1 Two-pass layout with ports

1. Filter the graph according to the associations visibility toggle.
2. Build Dagre graph with nodes and visible edges.
3. Run Dagre once to get node positions.
4. Sort outgoing edges per source by target y/x/id and assign source ports.
5. Sort incoming edges per target by source y/x/id and assign target ports.
6. Emit React Flow edges with `sourceHandle` / `targetHandle`.

Node cards expose six target handles at the top and six source handles at the bottom:

```tsx
const PORT_COUNT = 6;

<Handle id="in-0" type="target" position={Position.Top} style={{ left: "14%" }} />
...
<Handle id="out-0" type="source" position={Position.Bottom} style={{ left: "14%" }} />
```

- Ports are visually subtle (small dots or transparent) so they do not clutter the card.
- More than six edges on one side wrap to additional lanes.
- Edges with no assigned port fall back to the first port.

### 7.2 Lane offsets

- Use `type: "smoothstep"`.
- Set `pathOptions: { borderRadius: 12, offset: 12 + lane * 10 }`.
- Optionally vary `stepPosition` slightly (`0.4`, `0.5`, `0.6`) per lane if the first pass still overlaps.
- Increase Dagre spacing:
  - `nodesep: 48`
  - `ranksep: 80`
  - `marginx: 24`
  - `marginy: 24`
- Keep `rankdir: "TB"` so the dependent remains above its dependency.

### 7.3 Edge styles

| Relationship | Style |
|---|---|
| Primary source | Solid slate `#64748b`, 1.5 px |
| Join `inner` | Solid blue `#2563eb`, 1.75 px |
| Join `leftOuter` | Solid amber `#d97706`, 1.75 px |
| Join `rightOuter` | Solid violet `#7c3aed`, 1.75 px |
| Join `fullOuter` | Solid pink `#db2777`, 1.75 px |
| Join `cross` | Dashed slate, 1.5 px |
| Association | Dashed violet `#7c3aed`, 1.75 px |
| Set operation | Dotted teal `#0f766e`, 1.5 px |
| Selected edge | Primary blue `#0a6cff`, 3 px |
| Dimmed edge | Same colour, opacity ~0.18 |

- Add `MarkerType.ArrowClosed` arrowheads pointing from dependent to dependency.
- Use a custom edge component if built-in `smoothstep` cannot render role-specific labels/hover states cleanly.
- `interactionWidth: 28` for easier edge clicking.

### 7.4 Labels

- Default: no label on every edge; colour and legend carry the role.
- On hover or selection: show a compact label:
  - `join: left outer · _alias`
  - `association: _PRReleaseDate [0..1]`
- Optional “Show all edge labels” toggle in Main for users who want a denser view.
- Labels use a white background with padding and are clamped/truncated.

### 7.5 Selection focus

- `GraphCanvas` receives `selectedNodeId`, `selectedEdgeId`, and callbacks.
- `buildFlow` marks data:
  - `highlight: "endpoint"` for both endpoints of a selected edge.
  - `highlight: "selected"` for the selected node.
  - `dimmed: true` for unrelated nodes/edges.
- CSS handles outline, opacity, and transition.
- Clicking an edge selects it; clicking a node clears edge selection; clicking the pane clears both (subject to review).

### 7.6 Fallback if overlap remains

The primary approach is ports + lane offsets + focus. If a real graph with many joins is still unreadable:

- Evaluate `elkjs` as an optional second layout engine.
- Do not add it in the first implementation unless the fixture/live smoke shows the port/lane approach is insufficient.

---

## 8. HTML Export

### 8.1 Button

- Add a **Save HTML** button at the far right of the header.
- Disabled when there is no graph or while an export is running.
- Shows a short success/failure message next to the button.

### 8.2 Capture approach

Recommended: add `html-to-image` as a frontend dependency.

- Capture the current `.react-flow__viewport` as a PNG or SVG data URI.
- Use React Flow’s `getNodesBounds` / `getViewportForBounds` to size the image.
- Cap the image at a reasonable size (for example 4000 × 4000) to keep the HTML file manageable.
- If capture fails, still export the report without the image and include a clear “snapshot unavailable” note.

Alternative if a new dependency is not acceptable:

- Generate an inline SVG report directly from the laid-out nodes/edges.
- This avoids `html-to-image`, but requires custom node-box and edge-path rendering and will not exactly match the React Flow canvas.

### 8.3 Report contents

A single self-contained `.html` file with inline CSS and no external scripts:

1. Header:
   - “Abapify CDS Visualiser”.
   - Generated timestamp.
   - Root object.
   - System/cache mode and fixture mode.
   - Max depth, node count, edge count, truncated state.
2. Graph snapshot:
   - Embedded image data URI, or “snapshot unavailable”.
3. Selected details at export time:
   - Node metadata + columns + associations, or
   - Edge relationship + condition + left/right.
4. Node table:
   - Name, kind, ADT type, depth, status, cache, error code.
5. Edge table:
   - From, to, role, join type, alias, cardinality, condition.
6. Diagnostics:
   - Grouped by severity/category, with line/column for parse errors.
7. Footer:
   - Tool name and note that the report was generated from the local visualiser.

### 8.4 File naming and safety

- Filename: `cds-lineage-<ROOT>-<YYYYMMDD-HHmmss>.html`.
- Sanitise the root to `[A-Z0-9_-]`; fall back to `graph`.
- Escape all graph-provided strings before inserting them into HTML.
- Embed the snapshot as a data URI; do not inline untrusted SVG markup directly.
- Do not include raw SAP source payloads; only metadata, column expressions, join conditions, and diagnostics.
- Use `Blob`, `URL.createObjectURL`, an anchor with `download`, then revoke the URL.
- Handle export errors without crashing the UI.

---

## 9. File Impact

| File | Change |
|---|---|
| `packages/shared/src/index.ts` | New column/association/relationship/diagnostic types; `SourceRole` association; optional node/edge/graph fields |
| `packages/backend/src/parser/extract-sources.ts` | Columns, associations, join details, predicates, left/right resolution |
| `packages/backend/src/parser/version.ts` | Bump `EXTRACTOR_VERSION` to `"3"` |
| `packages/backend/src/collector/collector.ts` | Association traversal, relationship metadata, diagnostics, self-association handling |
| `packages/backend/src/repository/types.ts` | Optional relationship/column/association fields in derived artifacts |
| `packages/backend/src/repository/caching-provider.ts` | Persist new derived fields |
| `packages/frontend/src/App.tsx` | Tab state, node/edge selection, associations visibility, export wiring |
| `packages/frontend/src/components/SidebarTabs.tsx` | New tab shell |
| `packages/frontend/src/components/MainPanel.tsx` | Form, summary, legend, associations toggle, diagnostics link |
| `packages/frontend/src/components/DetailsPanel.tsx` | Node columns/associations/parse errors; edge relationship details |
| `packages/frontend/src/components/ErrorsPanel.tsx` | Structured diagnostics list, filters, click-to-select |
| `packages/frontend/src/components/GraphCanvas.tsx` | Edge clicks, selection focus, edge hover, export ref |
| `packages/frontend/src/components/DependencyNodeCard.tsx` | Multiple source/target handles, highlight states |
| `packages/frontend/src/components/RelationshipEdge.tsx` | Optional custom edge for role styles/labels/tooltips |
| `packages/frontend/src/graph-layout.ts` | Two-pass layout, port assignment, lane offsets, filtering, styles |
| `packages/frontend/src/export-html.ts` | Self-contained HTML report builder and download helper |
| `packages/frontend/src/format.ts` | Labels for roles, join types, diagnostic categories, cardinality |
| `packages/frontend/src/index.css` | Tabs, details tables, diagnostics, edge/node focus, export button |
| `packages/frontend/package.json` | `html-to-image` dependency (if approved) |
| `packages/frontend/src/*.test.ts` | Layout, filtering, export HTML tests |
| `packages/backend/test/extract-sources.test.ts` | Columns, associations, join predicates, duplicate targets |
| `packages/backend/test/collector.test.ts` | Association traversal, diagnostics, limits, self-association |
| `README.md` | UI tabs, association behaviour, export, new details |
| `tasks/004/UI_upgrade_implementation.md` | Written after review and implementation |

No SAP command changes, no new HTTP endpoint, and no logging schema change are required.

---

## 10. Testing and Verification

### 10.1 Backend unit tests

`extract-sources.test.ts`:

- Extract view columns with aliases, keys, expressions, and flags.
- Extract FROM-region associations (including the `walkAssociations` caveat).
- Extract member associations.
- Extract multiple associations to the same target with different aliases.
- Extract association cardinality and condition.
- Extract join type, condition, predicates, left/right aliases, and resolved names.
- Handle `between … and …` without splitting the internal `and`.
- Handle join groups without regressing existing flattening.
- Extract table/structure fields.
- Preserve partial-AST columns when parser errors exist.

`collector.test.ts`:

- Association targets become nodes and edges with `sourceRole: "association"`.
- Association targets are expanded to the configured depth.
- Associations count toward max objects.
- Core joins are processed before associations.
- Self-association does not produce a cycle warning.
- Diagnostics are emitted with correct category/severity and object ids.
- Existing cache, resolution, depth, and cycle tests still pass.

### 10.2 Frontend tests

- `graph-layout`:
  - Associations hidden → association-only nodes removed, shared nodes retained.
  - Edges get deterministic source/target handles.
  - More edges than ports wrap to lanes.
  - Edge role styles/labels are applied.
- `export-html`:
  - Escapes object names/conditions.
  - Includes graph summary, node/edge tables, diagnostics, and selected details.
  - Omits scripts and raw source.
  - Produces a safe filename.
- `DetailsPanel` rendering (if a DOM test setup is added):
  - 116-column fixture renders a scrollable table.
  - Edge selection shows left/right and condition.
- Keep tests independent of live SAP.

### 10.3 Fixture smoke test

Use `ZC_PurReqItemCube` in fixture mode:

- Expect 116 columns on the root.
- Expect 14 association declarations.
- Expect multiple edges to `I_CalendarDate` with distinct aliases.
- Expect 6 joins with condition text and left/right details.
- Toggle associations off and confirm association-only nodes disappear.
- Click an association edge and confirm endpoint highlighting and Details content.
- Export HTML and open it from disk; confirm the snapshot and tables render offline.

### 10.4 Commands

```
npm test
npm run typecheck
npm run build
```

### 10.5 Live read-only smoke (optional, after review)

- Use the existing `DS4`/`100` read-only setup and `cache-first` or `cache-only`.
- Confirm no new SAP command shape and no source payload in logs.
- Confirm association reads respect depth and max-object limits.

---

## 11. Risks, Limitations, and Open Questions

### 11.1 Risks and limitations

1. **Associations are not SQL joins.**
   - They are navigation relationships. Rendering them like joins could mislead users, so they get a distinct dashed style and an “Association” label.
2. **Graph growth.**
   - The real cube has 14 associations. Other CDS objects may have many more. Existing depth/object limits still apply; joins are processed before associations so structural joins are not starved.
3. **AST limitations.**
   - Join `loc` is absent in 0.4.23, so join details cannot show source line numbers.
   - Projection columns usually have no type metadata.
   - `walkAssociations` does not return FROM associations in this build; use `fromAssociations` plus `members.filter(isAssociation)`.
4. **Join groups.**
   - Current extraction flattens parenthesised groups. The Details tab shows the immediate join condition, not a nested group tree. Full group visualisation is a follow-up.
5. **Predicate decomposition is best-effort.**
   - Complex expressions may not split perfectly. The raw condition is always shown.
6. **Snapshot export.**
   - `html-to-image` may fail on unusual fonts or cross-origin assets. The report still exports without the image.
7. **Large reports.**
   - A 200-node graph with 116-column details can produce a large HTML file. The snapshot is capped; tables remain compact.
8. **Self-association rendering.**
   - A self-loop may be visually noisy. A badge fallback is specified.
9. **No column lineage.**
   - Columns are metadata only; the graph still represents object-level dependencies.
10. **No request-level association opt-out.**
    - Associations are always extracted in this proposal. The UI toggle is display-only. If SAP load becomes a concern, a request-level `includeAssociations` option can be added later.

### 11.2 Questions for review

1. Should associations be visible by default? **Recommendation: yes.**
2. Should unused associations be shown? **Recommendation: show all declared associations, with a “used in projection” badge; optionally add a “used only” filter later.**
3. Should DDIC table/structure fields appear in the same Columns table? **Recommendation: yes, because the parser already exposes `walkFields`.**
4. Is adding `html-to-image` acceptable? **Recommendation: yes; it gives a faithful snapshot with little code. The no-dependency SVG fallback is available if preferred.**
5. Should edge labels be always visible? **Recommendation: show on hover/selection by default, with an optional “show all labels” toggle.**
6. Should hiding associations re-layout the graph? **Recommendation: yes, hide association-only nodes and re-run Dagre for the visible subgraph.**
7. Should clicking the canvas background clear the selection? **Recommendation: yes, with Details returning to its empty state.**

---

## 12. Acceptance Criteria

- [ ] Sidebar has accessible **Main**, **Details**, and **Errors** tabs.
- [ ] Main contains the analysis form, summary, associations toggle, and legend.
- [ ] Parse/diagnostic messages no longer appear as orange boxes in Main.
- [ ] Errors tab shows structured diagnostics with counts, filters, categories, and parse line/column.
- [ ] Clicking a diagnostic selects the related node/edge where possible.
- [ ] Selecting a node shows its existing metadata plus columns and associations.
- [ ] `ZC_PurReqItemCube` shows 116 columns in fixture mode.
- [ ] Selecting a join/association shows relationship type, from/to, left/right, condition, predicates, and cardinality where available.
- [ ] Selecting a join/association highlights both endpoint node cards and dims unrelated graph elements.
- [ ] Associations are extracted from FROM-region and member declarations and rendered as dashed edges.
- [ ] Multiple associations to the same target remain distinct edges with distinct aliases.
- [ ] Multiple joins from one parent use separate ports/lanes and are readable in the graph.
- [ ] Associations can be hidden without re-running the analysis.
- [ ] Header has a working **Save HTML** button on the right.
- [ ] The downloaded HTML is self-contained, opens offline, includes the graph snapshot and report tables, and contains no scripts or raw source payloads.
- [ ] `EXTRACTOR_VERSION` is bumped and cached derived artifacts regenerate without SAP re-reads.
- [ ] Existing cache modes, resolution statuses, depth cap, concurrency, and max-object limits are unchanged.
- [ ] No SAP source or credentials are logged.
- [ ] `npm test`, `npm run typecheck`, and `npm run build` pass.

---

## 13. Suggested Implementation Phases

1. **Shared model + extraction**
   - Add types.
   - Extract columns, associations, join details.
   - Bump extractor version.
   - Add parser tests.
2. **Collector + diagnostics**
   - Traverse associations.
   - Add relationship metadata and diagnostics.
   - Add collector tests.
3. **Tabbed sidebar**
   - Main, Details, Errors.
   - Node columns/associations.
   - Edge details.
4. **Graph readability**
   - Ports, lane offsets, role styles, selection focus, hover labels.
5. **HTML export**
   - Snapshot capture, report builder, download, tests.
6. **Documentation and verification**
   - README updates.
   - Fixture/live smoke.
   - Write `tasks/004/UI_upgrade_implementation.md` after review.

---

## 14. Summary

The proposal uses the existing `@abapify/acds` AST rather than adding a parser. It adds richer graph metadata, keeps associations distinct from SQL joins, makes joins inspectable and visually traceable, moves diagnostics into their own tab, and adds an offline HTML export. The main trade-offs are association-driven graph growth and the limits of the installed AST (no join line numbers, limited type metadata), both of which are handled explicitly rather than hidden.
