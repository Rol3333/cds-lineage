import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { DependencyNode } from "@cds-visualiser/shared";
import { isErrorStatus, isWarnStatus, KIND_LABEL, STATUS_LABEL } from "../format";

function DependencyNodeCard({ data, selected }: NodeProps) {
  const node = data as unknown as DependencyNode;
  const error = isErrorStatus(node.status);
  const warn = isWarnStatus(node.status);

  return (
    <div className={`node-card${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Top} style={{ background: "#9aa4b2" }} />
      <div className="title">{node.name}</div>
      <div className="meta">
        <span className={`tag ${node.kind}`}>{KIND_LABEL[node.kind]}</span>
        <span
          className={`tag ${error ? "status-error" : warn ? "status-warn" : ""}`}
        >
          {STATUS_LABEL[node.status]}
        </span>
        <span className="tag unknown">depth {node.depth}</span>
        {node.cacheHit && <span className="tag cache">cached</span>}
      </div>
      {node.errorMessage && <div className="error">{node.errorMessage}</div>}
      <Handle type="source" position={Position.Bottom} style={{ background: "#9aa4b2" }} />
    </div>
  );
}

export default memo(DependencyNodeCard);
