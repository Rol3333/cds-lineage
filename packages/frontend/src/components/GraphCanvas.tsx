import { useMemo } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import type { DependencyGraph } from "@cds-visualiser/shared";
import { buildFlow } from "../graph-layout";
import DependencyNodeCard from "./DependencyNodeCard";
import RelationshipEdge from "./RelationshipEdge";

const nodeTypes: NodeTypes = { dependency: DependencyNodeCard };
const edgeTypes: EdgeTypes = { relationship: RelationshipEdge };

interface GraphCanvasProps {
  graph: DependencyGraph;
  showAssociations: boolean;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
}

export default function GraphCanvas({
  graph,
  showAssociations,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
}: GraphCanvasProps) {
  const { nodes, edges } = useMemo(
    () => buildFlow(graph, { showAssociations, selectedNodeId, selectedEdgeId }),
    [graph, showAssociations, selectedNodeId, selectedEdgeId],
  );

  return (
    <ReactFlow
      key={`${graph.rootId}-${graph.maxDepth}-${graph.nodes.length}-${graph.edges.length}-${showAssociations}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.02}
      maxZoom={2}
      onNodeClick={(_, node) => onSelectNode(node.id)}
      onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
      onPaneClick={onClearSelection}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
