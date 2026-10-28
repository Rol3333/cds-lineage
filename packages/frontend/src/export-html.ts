import { toPng } from "html-to-image";
import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import type { DependencyEdge, DependencyGraph, DependencyNode } from "@cds-visualiser/shared";
import { joinTypeLabel, KIND_LABEL, relationshipKindLabel, STATUS_LABEL } from "./format";
import { buildFlow } from "./graph-layout";

export interface ExportHtmlOptions {
  graph: DependencyGraph;
  element: HTMLElement;
  showAssociations: boolean;
  systemKey?: string;
  fixtureMode?: boolean;
}

/**
 * Capture the graph as a PNG and wrap it in a self-contained HTML file.
 * No server call is made; the HTML contains the image plus a readable inventory
 * of nodes, relationships, and diagnostics.
 */
export async function exportGraphHtml(options: ExportHtmlOptions): Promise<string> {
  const { graph, element, showAssociations, systemKey, fixtureMode } = options;
  const image = await captureGraph(element, graph, showAssociations);
  const html = renderHtml(graph, image, systemKey, fixtureMode);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const filename = `${safeFilename(graph.rootId)}-dependency-graph.html`;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return filename;
}

async function captureGraph(
  element: HTMLElement,
  graph: DependencyGraph,
  showAssociations: boolean,
): Promise<string> {
  const viewport = element.querySelector(".react-flow__viewport") as HTMLElement | null;
  const nodes = buildFlow(graph, { showAssociations }).nodes;

  if (viewport && nodes.length > 0) {
    const bounds = getNodesBounds(nodes);
    const imageWidth = Math.min(6000, Math.max(1200, Math.ceil(bounds.width + 160)));
    const imageHeight = Math.min(4000, Math.max(800, Math.ceil(bounds.height + 160)));
    const view = getViewportForBounds(bounds, imageWidth, imageHeight, 0.05, 2, 0.1);
    const pixelRatio = imageWidth * imageHeight > 4_000_000 ? 1 : 2;

    return toPng(viewport, {
      backgroundColor: "#fbfcfe",
      width: imageWidth,
      height: imageHeight,
      pixelRatio,
      cacheBust: true,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
      },
    });
  }

  return toPng(element, {
    backgroundColor: "#fbfcfe",
    pixelRatio: 2,
    cacheBust: true,
    filter: (node) => {
      const target = node as HTMLElement;
      if (!target.classList) return true;
      return (
        !target.classList.contains("react-flow__controls") &&
        !target.classList.contains("react-flow__minimap") &&
        !target.classList.contains("react-flow__panel") &&
        !target.classList.contains("react-flow__attribution")
      );
    },
  });
}

function renderHtml(
  graph: DependencyGraph,
  image: string,
  systemKey: string | undefined,
  fixtureMode: boolean | undefined,
): string {
  const title = `${graph.rootId} — CDS dependency graph`;
  const diagnostics = graph.diagnostics ?? [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f6f9; color: #1f2733; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 1400px; margin: 0 auto; padding: 24px; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 10px; }
  .muted { color: #6b7480; }
  .badge { display: inline-block; margin-right: 6px; padding: 2px 8px; border-radius: 999px; background: #e2e8f0; font-size: 11px; font-weight: 600; }
  .badge.fixture { background: #fef3c7; color: #92400e; }
  .summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
  .summary div { background: #fff; border: 1px solid #d9dee5; border-radius: 8px; padding: 10px 14px; min-width: 100px; }
  .summary strong { display: block; font-size: 20px; }
  .graph { background: #fff; border: 1px solid #d9dee5; border-radius: 10px; overflow: hidden; }
  .graph img { display: block; width: 100%; height: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9dee5; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #e7ebf0; font-size: 12px; }
  th { background: #eef2f7; font-weight: 600; color: #4b5563; }
  tr:last-child td { border-bottom: 0; }
  code { font: 12px/1.4 Consolas, monospace; word-break: break-word; }
  .unused { color: #b45309; font-weight: 600; }
  .diagnostic { border-left: 3px solid #d97706; background: #fff; padding: 8px 10px; margin: 6px 0; }
  .diagnostic.error { border-color: #dc2626; }
  .diagnostic.info { border-color: #2563eb; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(graph.rootId)}</h1>
      <div class="muted">CDS dependency graph export · ${escapeHtml(new Date().toISOString())}</div>
    </div>
    <div>
      ${fixtureMode ? '<span class="badge fixture">Fixture mode (no SAP)</span>' : ""}
      ${systemKey ? `<span class="badge">${escapeHtml(systemKey)}</span>` : ""}
      <span class="badge">max depth ${graph.maxDepth}</span>
    </div>
  </header>

  <div class="summary">
    <div><strong>${graph.nodes.length}</strong><span class="muted">objects</span></div>
    <div><strong>${graph.edges.length}</strong><span class="muted">relationships</span></div>
    <div><strong>${diagnostics.length}</strong><span class="muted">issues</span></div>
    <div><strong>${graph.warnings.length}</strong><span class="muted">warnings</span></div>
  </div>

  <div class="graph"><img src="${image}" alt="Dependency graph for ${escapeHtml(graph.rootId)}"></div>

  <h2>Objects</h2>
  ${renderNodeTable(graph.nodes)}

  <h2>Relationships</h2>
  ${renderEdgeTable(graph.edges)}

  <h2>Diagnostics</h2>
  ${diagnostics.length > 0 ? renderDiagnostics(diagnostics) : '<p class="muted">No structured diagnostics.</p>'}
</main>
</body>
</html>`;
}

function renderNodeTable(nodes: DependencyNode[]): string {
  const rows = nodes
    .map(
      (node) => `<tr>
        <td><strong>${escapeHtml(node.name)}</strong></td>
        <td>${escapeHtml(KIND_LABEL[node.kind])}</td>
        <td>${escapeHtml(STATUS_LABEL[node.status])}</td>
        <td>${node.depth}</td>
        <td>${node.columns?.length ?? 0}</td>
        <td>${node.associations?.length ?? 0}</td>
        <td>${node.usedInProjection === false ? '<span class="unused">unused</span>' : "used"}</td>
      </tr>`,
    )
    .join("");
  return `<table>
    <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>Depth</th><th>Columns</th><th>Associations</th><th>Projection</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderEdgeTable(edges: DependencyEdge[]): string {
  const rows = edges
    .map((edge) => {
      const kind = edge.sourceRole ?? edge.relationship?.kind ?? "primary";
      const details =
        kind === "join"
          ? joinTypeLabel(edge.joinType ?? edge.relationship?.joinType)
          : kind === "association"
            ? `${relationshipKindLabel(kind)}${edge.relationship?.cardinality ? ` ${edge.relationship.cardinality}` : ""}`
            : relationshipKindLabel(kind);
      return `<tr>
        <td><strong>${escapeHtml(edge.from)}</strong></td>
        <td><strong>${escapeHtml(edge.to)}</strong></td>
        <td>${escapeHtml(details)}</td>
        <td>${escapeHtml(edge.relationship?.alias ?? "—")}</td>
        <td>${edge.relationship?.usedInProjection === false ? '<span class="unused">unused</span>' : "used"}</td>
        <td>${edge.relationship?.condition ? `<code>${escapeHtml(edge.relationship.condition)}</code>` : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr><th>From</th><th>To</th><th>Relationship</th><th>Alias</th><th>Projection</th><th>Condition</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderDiagnostics(diagnostics: NonNullable<DependencyGraph["diagnostics"]>): string {
  return diagnostics
    .map(
      (diagnostic) => `<div class="diagnostic ${escapeHtml(diagnostic.severity)}">
        <strong>${escapeHtml(diagnostic.severity)} · ${escapeHtml(diagnostic.category)}</strong>
        ${diagnostic.objectId ? ` · ${escapeHtml(diagnostic.objectId)}` : ""}
        ${diagnostic.line !== undefined ? ` · line ${diagnostic.line}${diagnostic.column !== undefined ? `:${diagnostic.column}` : ""}` : ""}
        <div>${escapeHtml(diagnostic.message)}</div>
      </div>`,
    )
    .join("");
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "cds-graph";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
