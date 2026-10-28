import Dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { DependencyEdge, DependencyGraph, DependencyNode } from "@cds-visualiser/shared";
import { joinTypeLabel, relationshipKindLabel } from "./format";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 108;
const COLUMN_GAP = 52;
const ROW_GAP = 52;
const RANK_GAP = 88;
/** Keep a rank from stretching into one unreadable horizontal line. */
const MAX_COLUMNS = 14;

export interface PortSpec {
  id: string;
  /** Percentage from the left edge of the node. */
  left: number;
}

export interface FlowNodeData extends DependencyNode {
  sourcePorts: PortSpec[];
  targetPorts: PortSpec[];
  highlighted?: boolean;
}

export interface BuildFlowOptions {
  showAssociations?: boolean;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
}

/**
 * Convert the application-owned graph into React Flow nodes/edges laid out
 * top-to-bottom. Core edges already mean "dependent → dependency"; with dagre
 * `rankdir: TB`, `source` (the dependent) sits above `target` (the dependency),
 * so no direction inversion is required here.
 *
 * Each edge gets its own source/target handle. This is what keeps two joins
 * between the same pair of tables visually separate instead of collapsing onto
 * one line. The dagre graph is a multigraph for the same reason.
 */
export function buildFlow(
  graph: DependencyGraph,
  options: BuildFlowOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const showAssociations = options.showAssociations ?? true;
  const visibleEdges = showAssociations
    ? graph.edges
    : graph.edges.filter((edge) => edge.sourceRole !== "association");

  const connected = new Set<string>([graph.rootId]);
  for (const edge of visibleEdges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const visibleNodes = showAssociations
    ? graph.nodes
    : graph.nodes.filter((node) => connected.has(node.id));

  const outgoing = groupEdges(visibleEdges, "from");
  const incoming = groupEdges(visibleEdges, "to");
  const sourcePorts = buildPorts(outgoing, "out");
  const targetPorts = buildPorts(incoming, "in");

  const g = new Dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 52, ranksep: 88, marginx: 20, marginy: 20 });

  for (const node of visibleNodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of visibleEdges) {
    // The fourth argument keeps parallel edges distinct in dagre's multigraph.
    g.setEdge(edge.from, edge.to, {}, edge.id);
  }

  Dagre.layout(g);

  // Dagre places every node in a rank on one horizontal line. Wide dependency
  // graphs (a cube with hundreds of max-depth leaves) then become a 40k-pixel
  // line that is unreadable both on screen and in the exported image. Group by
  // dependency depth instead, use dagre's horizontal order inside each depth,
  // and wrap each depth into a compact grid. This keeps the graph balanced while
  // preserving the top-to-bottom dependent → dependency direction.
  const positions = layoutDepths(visibleNodes, (id) => {
    const pos = g.node(id) as { x: number; y: number } | undefined;
    return pos;
  });

  const selectedEdge = options.selectedEdgeId
    ? graph.edges.find((edge) => edge.id === options.selectedEdgeId)
    : undefined;
  const highlightedNodeIds = new Set<string>();
  if (selectedEdge) {
    highlightedNodeIds.add(selectedEdge.from);
    highlightedNodeIds.add(selectedEdge.to);
  }

  const nodes: Node[] = visibleNodes.map((node) => {
    const pos = positions.get(node.id);
    const data: FlowNodeData = {
      ...node,
      sourcePorts: (outgoing.get(node.id) ?? []).map((edge) => sourcePorts.get(edge.id)!),
      targetPorts: (incoming.get(node.id) ?? []).map((edge) => targetPorts.get(edge.id)!),
      highlighted: highlightedNodeIds.has(node.id),
    };
    return {
      id: node.id,
      type: "dependency",
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      selected: node.id === options.selectedNodeId,
      data: data as unknown as Record<string, unknown>,
    };
  });

  const edges: Edge[] = visibleEdges.map((edge) => {
    const kind = edge.sourceRole ?? edge.relationship?.kind ?? "primary";
    const unused = edge.relationship?.usedInProjection === false;
    const selected = edge.id === options.selectedEdgeId;
    const stroke = edgeStroke(kind, unused);
    const dash = edgeDash(kind, unused);

    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: sourcePorts.get(edge.id)?.id,
      targetHandle: targetPorts.get(edge.id)?.id,
      type: "relationship",
      data: {
        label: edgeLabel(edge),
        kind,
        unused,
      },
      style: {
        stroke,
        strokeWidth: selected ? 2.6 : 1.5,
        strokeDasharray: dash,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: 16,
        height: 16,
      },
      selected,
      zIndex: selected ? 10 : 0,
    };
  });

  return { nodes, edges };
}

function layoutDepths(
  nodes: DependencyNode[],
  dagrePosition: (id: string) => { x: number; y: number } | undefined,
): Map<string, { x: number; y: number }> {
  const depths = new Map<number, DependencyNode[]>();
  for (const node of nodes) {
    const depthNodes = depths.get(node.depth) ?? [];
    depthNodes.push(node);
    depths.set(node.depth, depthNodes);
  }

  const orderedDepths = [...depths.entries()].sort(([left], [right]) => left - right);
  const positions = new Map<string, { x: number; y: number }>();
  let depthTop = 0;

  for (const [, depthNodes] of orderedDepths) {
    const ordered = [...depthNodes].sort(
      (left, right) => (dagrePosition(left.id)?.x ?? 0) - (dagrePosition(right.id)?.x ?? 0),
    );
    const columns = Math.max(
      1,
      Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(ordered.length))),
    );
    const rows = Math.ceil(ordered.length / columns);

    ordered.forEach((node, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const nodesInRow = Math.min(columns, ordered.length - row * columns);
      const rowWidth = nodesInRow * NODE_WIDTH + (nodesInRow - 1) * COLUMN_GAP;
      const x = -rowWidth / 2 + column * (NODE_WIDTH + COLUMN_GAP) + NODE_WIDTH / 2;
      const y = depthTop + row * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;
      positions.set(node.id, { x, y });
    });

    depthTop += rows * (NODE_HEIGHT + ROW_GAP) - ROW_GAP + RANK_GAP;
  }

  return positions;
}

function groupEdges(
  edges: DependencyEdge[],
  direction: "from" | "to",
): Map<string, DependencyEdge[]> {
  const grouped = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const key = edge[direction];
    const list = grouped.get(key) ?? [];
    list.push(edge);
    grouped.set(key, list);
  }
  return grouped;
}

function buildPorts(
  grouped: Map<string, DependencyEdge[]>,
  prefix: "out" | "in",
): Map<string, PortSpec> {
  const ports = new Map<string, PortSpec>();
  for (const list of grouped.values()) {
    list.forEach((edge, index) => {
      ports.set(edge.id, {
        id: `${prefix}-${edge.id}`,
        left: ((index + 1) / (list.length + 1)) * 100,
      });
    });
  }
  return ports;
}

function edgeLabel(edge: DependencyEdge): string {
  const relationship = edge.relationship;
  const kind = edge.sourceRole ?? relationship?.kind ?? "primary";
  const parts: string[] = [];

  if (kind === "join") {
    parts.push(joinTypeLabel(edge.joinType ?? relationship?.joinType));
  } else if (kind === "association") {
    parts.push(relationshipKindLabel(kind));
    if (relationship?.associationKind === "composition") parts.push("composition");
    if (relationship?.cardinality) parts.push(relationship.cardinality);
  } else {
    parts.push(relationshipKindLabel(kind));
  }

  if (relationship?.alias) parts.push(relationship.alias);
  if (relationship?.usedInProjection === false) parts.push("unused");
  return parts.join(" · ");
}

function edgeStroke(kind: string, unused: boolean): string {
  if (unused) return "#94a3b8";
  if (kind === "association") return "#7c3aed";
  if (kind === "join") return "#2563eb";
  if (kind === "set-operation") return "#0f766e";
  return "#64748b";
}

function edgeDash(kind: string, unused: boolean): string | undefined {
  if (kind === "association") return unused ? "2 4" : "6 4";
  if (unused) return "3 4";
  return undefined;
}
