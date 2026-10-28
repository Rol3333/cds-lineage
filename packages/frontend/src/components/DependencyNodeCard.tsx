import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { isErrorStatus, isWarnStatus, KIND_LABEL, STATUS_LABEL } from "../format";
import type { FlowNodeData } from "../graph-layout";

function DependencyNodeCard({ data, selected }: NodeProps) {
  const node = data as unknown as FlowNodeData;
  const error = isErrorStatus(node.status);
  const warn = isWarnStatus(node.status);
  const unused = node.usedInProjection === false;
  const parseErrorCount = node.parseErrors?.length ?? 0;

  return (
    <div
      className={[
        "node-card",
        selected ? "selected" : "",
        node.highlighted ? "highlighted" : "",
        unused ? "unused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={node.name}
    >
      {(node.targetPorts ?? []).map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Top}
          isConnectable={false}
          style={{ left: `${port.left}%` }}
        />
      ))}

      <div className="title">{node.name}</div>
      <div className="meta">
        <span className={`tag ${node.kind}`}>{KIND_LABEL[node.kind]}</span>
        <span className={`tag ${error ? "status-error" : warn ? "status-warn" : ""}`}>
          {STATUS_LABEL[node.status]}
        </span>
        <span className="tag unknown">depth {node.depth}</span>
        {node.cacheHit && <span className="tag cache">cached</span>}
        {unused && <span className="tag unused">unused</span>}
        {(node.columns?.length ?? 0) > 0 && (
          <span className="tag info">{node.columns!.length} cols</span>
        )}
        {(node.associations?.length ?? 0) > 0 && (
          <span className="tag association">{node.associations!.length} assoc</span>
        )}
        {parseErrorCount > 0 && (
          <span className="tag status-warn">{parseErrorCount} parse issue{parseErrorCount === 1 ? "" : "s"}</span>
        )}
      </div>

      {node.errorMessage && node.status !== "parse-error" && (
        <div className="error">{node.errorMessage}</div>
      )}
      {node.status === "parse-error" && (
        <div className="error-hint">See the Errors tab for parser details.</div>
      )}

      {(node.sourcePorts ?? []).map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          style={{ left: `${port.left}%` }}
        />
      ))}
    </div>
  );
}

export default memo(DependencyNodeCard);
