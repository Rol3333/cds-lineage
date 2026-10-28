import { useMemo } from "react";
import { Background, Controls, MiniMap, ReactFlow, type NodeTypes } from "@xyflow/react";
import type { DependencyGraph } from "@cds-visualiser/shared";
import { buildFlow } from "../graph-layout";
import DependencyNodeCard from "./DependencyNodeCard";

const nodeTypes: NodeTypes = { dependency: DependencyNodeCard };

interface GraphCanvasProps {
  graph: DependencyGraph;
  onSelect: (id: string) => void;
}

export default function GraphCanvas({ graph, onSelect }: GraphCanvasProps) {
  const { nodes, edges } = useMemo(() => buildFlow(graph), [graph]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.25 }}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.15}
      maxZoom={2}
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background gap={20} />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
