import Dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { DependencyGraph } from "@cds-visualiser/shared";

const NODE_WIDTH = 230;
const NODE_HEIGHT = 96;

/**
 * Convert the application-owned graph into React Flow nodes/edges laid out
 * top-to-bottom. Core edges already mean "dependent → dependency"; with dagre
 * `rankdir: TB`, `source` (the dependent) sits above `target` (the dependency),
 * so no direction inversion is required here.
 */
export function buildFlow(graph: DependencyGraph): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 64, marginx: 20, marginy: 20 });

  for (const n of graph.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of graph.edges) {
    g.setEdge(e.from, e.to);
  }

  Dagre.layout(g);

  const nodes: Node[] = graph.nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number };
    return {
      id: n.id,
      type: "dependency",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: n as unknown as Record<string, unknown>,
    };
  });

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: "smoothstep",
    label: e.sourceRole === "join" ? e.joinType ?? "join" : e.sourceRole,
    data: { sourceRole: e.sourceRole, joinType: e.joinType },
    style: { stroke: "#9aa4b2", strokeWidth: 1.5 },
    labelStyle: { fontSize: 10, fill: "#6b7480" },
    labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
  }));

  return { nodes, edges };
}
