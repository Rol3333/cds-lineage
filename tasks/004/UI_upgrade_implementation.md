# Task 004 — UI upgrade implementation

Implementation notes for the approved plan in `UI_upgrade_plan.md`.

## Summary

The visualiser now has a tabbed inspector, rich relationship metadata, CDS
associations, DDIC table/structure fields, unused-relationship marking, readable
multi-join routing, and a self-contained HTML export. Read-only SAP access,
depth/object/concurrency limits, cache modes, and the no-raw-source logging rule
are unchanged.

## Shared model

`packages/shared/src/index.ts` now carries the extra information needed by the
inspector and graph:

- `ObjectColumn` — projection columns and DDIC fields, including key/virtual/
  localized/redirect metadata.
- `ObjectAssociation` — declared CDS association/composition name, target,
  cardinality, condition, and projection usage.
- `ParseIssue` — parser message with line/column, attached to the owning node.
- `SourceRef`, `JoinPredicate`, and `EdgeRelationship` — join/association type,
  alias, cardinality, condition, decomposed predicates, left/right operands,
  projection usage, and self/redirect/parent flags.
- `GraphDiagnostic` — structured severity/category/message with optional object,
  edge, line, and column fields.
- `SourceRole` now includes `association`.
- `DependencyNode` gains `columns`, `associations`, `parseErrors`, and
  `usedInProjection`.
- `DependencyEdge` gains `joinType` and `relationship`.
- `DependencyGraph` gains `diagnostics`.

## Extraction

`packages/backend/src/parser/extract-sources.ts` was extended rather than replaced:

- Sources are collected from the typed AST's `from`/joins and
  `definition.fromAssociations` plus `definition.members.filter(isAssociation)`.
  `walkAssociations()` alone does not see `FROM` associations in the installed
  `@abapify/acds` version.
- Projection columns come from `walkViewElements()`. DDIC table/structure fields
  come from `walkFields()`.
- Column collection is capped at 1,000 entries and de-duplicated.
- Join conditions are tokenized and decomposed into predicates (`left`,
  `operator`, `right`, `text`). Path/function punctuation is formatted without
  stray spaces.
- `usedInProjection` is true only when an alias/source is referenced by an output
  projection element. A table referenced only by a join/filter condition but not
  selected into the view is marked unused, matching the “provides columns to the
  output view” rule.
- Fields without a usable type, and parser pseudo-fields produced by
  `with foreign key` clauses, are ignored for DDIC tables so recovery artifacts
  cannot pollute the column list or fail the whole analysis.

`EXTRACTOR_VERSION` was bumped from `2` to `3`, so cached CDS sources regenerate
their derived artifacts without another SAP read.

## Repository and collector

- `ParsedArtifact` persists `columns` and `associations`; dependency artifacts
  persist `alias` and `usedInProjection`.
- The caching provider regenerates the new artifact shape from cached source when
  the extractor version is stale.
- The collector now:
  - attaches columns, associations, and parser issues to CDS nodes;
  - parses table/structure DDL and attaches DDIC fields to leaf nodes;
  - emits one edge per source relationship, with `sourceRole`, `joinType`, and
    `relationship` metadata;
  - traverses declared associations like joins and creates association edges;
  - keeps self-associations as legitimate self-edges without reporting a
    dependency cycle;
  - computes `usedInProjection` for nodes from their incoming relationships;
  - records structured diagnostics for parser, resolution, cache, cycle, limit,
    and request failures;
  - emits one summary diagnostic for dependencies not expanded at max depth
    instead of one noisy diagnostic per leaf.

## Frontend

### Tabbed inspector

`App.tsx` now owns the active tab (`Main`, `Details`, `Errors`) and the current
selection (node or edge). Clicking a node or relationship opens `Details`.

- **Main** — object name, maximum depth, analyse button, association visibility
  toggle, analysis summary, and legend.
- **Details** — node or relationship inspector.
- **Errors** — parser errors, analysis issues, and remaining warnings.

Parse failures no longer render as orange error boxes on graph nodes. A node with
parser issues shows a small “See the Errors tab” hint and the full diagnostics are
listed in `Errors`.

### Node details

`DetailsPanel.tsx` shows:

- object identity, type, depth, status, resolution, cache source, and errors;
- all projection columns / DDIC fields in a scrollable table, with key, DDIC,
  localized, virtual, not-null, and redirect flags;
- declared associations with target, cardinality, condition, used/unused state,
  and click-through to the target node;
- clickable dependency chips.

### Relationship details

Clicking an edge shows:

- relationship kind (primary/join/association/set operation);
- join type, alias, cardinality, association kind, and projection usage;
- participating objects with click-through;
- the full condition;
- left/right operands;
- decomposed predicates.

Selecting an edge also highlights both endpoint nodes in the graph.

### Graph rendering

`graph-layout.ts` now:

- lays out a dagre multigraph so parallel edges are distinct;
- groups nodes by dependency depth after dagre ordering and wraps each depth
  into a grid of at most 14 columns. A cube with hundreds of max-depth leaves
  would otherwise become a 40,000-pixel horizontal line that is unreadable on
  screen and in the exported image;
- assigns a separate source/target handle to every edge and distributes handles
  across the node edge. This prevents multiple joins between the same pair of
  objects from collapsing onto one line;
- defaults associations to visible and hides association-only nodes when the
  toggle is off;
- styles primary, join, association, and unused relationships differently;
- attaches a hover/selection-only label to each edge.

`RelationshipEdge.tsx` renders the smooth-step edge and keeps labels hidden until
hover or selection. `DependencyNodeCard.tsx` renders dynamic multi-port handles
and unused/column/association/parser badges. The graph is still top-to-bottom:
the dependent object sits above its dependencies.

### HTML export

The header’s **Save HTML** button uses `html-to-image` (`toPng`). Export:

- recalculates the full graph bounds and captures the entire graph, not just the
  current viewport;
- embeds the PNG as a data URL;
- includes summary counts, object inventory, relationship inventory, and
  structured diagnostics;
- writes a single self-contained `.html` file with no external assets.

## Tests and verification

Commands run:

```text
npm test -w @cds-visualiser/backend       # 104 tests
npm test -w @cds-visualiser/frontend      # 6 tests
npm run typecheck -w @cds-visualiser/backend
npm run typecheck -w @cds-visualiser/frontend
npm run build
```

Additional coverage:

- extraction of primary/join/association sources, join types, aliases,
  predicates, projection columns, DDIC fields, association usage, and unused
  relationships;
- collector traversal of associations, DDIC leaf fields, parser diagnostics,
  and unused node marking;
- graph layout with parallel edges, distinct handles, association filtering,
  wide-depth grid wrapping, and unused edge labels.

Live cache-only smoke check (`DS4-100`, `ZC_PurReqItemCube`, max depth 2):

- 200 nodes: 28 CDS, 170 unresolved/not-expanded leaves, 2 DDIC tables;
- DDIC table fields are present, e.g. `EBAN` (181 fields) and `USR21`
  (14 fields); parser pseudo-fields from `with foreign key` clauses are filtered
  out.
- parser diagnostics, resolution diagnostics, and the max-depth summary are
  returned in `graph.diagnostics`;
- the depth-2 export contained 200 nodes and 255 relationships; the embedded
  full-graph PNG was 3904×3736 px and the self-contained HTML was about 3.1 MB;
- exported HTML contains object, relationship, and diagnostic tables in addition
  to the embedded image.

## Known limitations

- The installed parser does not expose source locations for joins, so join
  details do not show line numbers. Parser issues still have line/column data.
- Projection expressions often lack type metadata in the AST, so many CDS
  columns show `—` in the Type column.
- DDIC views are metadata-only with the installed ADT CLI; they do not expose
  source fields.
- Very large graphs (for example a cube with many associations and max-depth
  leaves) are inherently dense. Depth-grid wrapping keeps the aspect ratio
  usable; the canvas still supports zoom and full-graph export. The export image
  is capped at 6000×4000 px and switches to pixel ratio 1 above 4 megapixels to
  stay within browser canvas limits.
- Unused marking is based on output projection references, not on whether a table
  participates in a join/filter condition.
