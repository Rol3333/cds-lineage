import type { DependencyNode } from "@cds-visualiser/shared";
import { ERROR_CODE_LABEL, KIND_LABEL, STATUS_LABEL } from "../format";

interface DetailsPanelProps {
  node?: DependencyNode | null;
}

export default function DetailsPanel({ node }: DetailsPanelProps) {
  if (!node) {
    return (
      <div className="details">
        <h2>Details</h2>
        <p className="hint">Select a node in the graph to inspect it.</p>
      </div>
    );
  }

  return (
    <div className="details">
      <h2>Details</h2>
      <dl>
        <dt>Name</dt>
        <dd>{node.name}</dd>
        <dt>Kind</dt>
        <dd>{KIND_LABEL[node.kind]}</dd>
        {node.objectType && (
          <>
            <dt>Repository type</dt>
            <dd>
              {node.objectType}
              {node.objectSubtype ? `/${node.objectSubtype}` : ""}
            </dd>
          </>
        )}
        <dt>Depth</dt>
        <dd>{node.depth}</dd>
        <dt>Status</dt>
        <dd>{STATUS_LABEL[node.status]}</dd>
        {node.resolution && (
          <>
            <dt>Resolution</dt>
            <dd>{node.resolution}</dd>
          </>
        )}
        {node.cacheHit !== undefined && (
          <>
            <dt>Source</dt>
            <dd>{node.cacheHit ? "Local repository (cache hit)" : "SAP (retrieved)"}</dd>
          </>
        )}
        {node.stale && (
          <>
            <dt>Cache</dt>
            <dd>Stale cached copy — check the graph warnings</dd>
          </>
        )}
        {node.errorCode && (
          <>
            <dt>Error</dt>
            <dd>{ERROR_CODE_LABEL[node.errorCode]}</dd>
          </>
        )}
        {node.errorMessage && (
          <>
            <dt>Message</dt>
            <dd>{node.errorMessage}</dd>
          </>
        )}
        {node.dependencies.length > 0 && (
          <>
            <dt>Depends on</dt>
            <dd className="deps">
              {node.dependencies.map((dep) => (
                <span key={dep} className="dep-chip">
                  {dep}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
