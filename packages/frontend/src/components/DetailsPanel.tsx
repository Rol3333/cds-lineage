import type {
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  ObjectAssociation,
  ObjectColumn,
  SourceRef,
} from "@cds-visualiser/shared";
import {
  ASSOCIATION_KIND_LABEL,
  ERROR_CODE_LABEL,
  joinTypeLabel,
  KIND_LABEL,
  relationshipKindLabel,
  STATUS_LABEL,
} from "../format";

interface DetailsPanelProps {
  node?: DependencyNode | null;
  edge?: DependencyEdge | null;
  graph?: DependencyGraph | null;
  onSelectNode?: (id: string) => void;
}

export default function DetailsPanel({ node, edge, graph, onSelectNode }: DetailsPanelProps) {
  if (edge) {
    return <EdgeDetails edge={edge} graph={graph ?? null} onSelectNode={onSelectNode} />;
  }
  if (node) {
    return <NodeDetails node={node} graph={graph ?? null} onSelectNode={onSelectNode} />;
  }
  return (
    <div className="details">
      <h2>Details</h2>
      <p className="hint">Select a node or relationship in the graph to inspect it.</p>
    </div>
  );
}

function NodeDetails({
  node,
  graph,
  onSelectNode,
}: {
  node: DependencyNode;
  graph: DependencyGraph | null;
  onSelectNode?: (id: string) => void;
}) {
  return (
    <div className="details">
      <div className="details-heading">
        <h2>Object details</h2>
        {node.usedInProjection === false && <span className="tag unused">unused</span>}
      </div>
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
            <dd>Stale cached copy — check the Errors tab</dd>
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
      </dl>

      <ColumnTable columns={node.columns ?? []} />
      <AssociationList
        associations={node.associations ?? []}
        graph={graph}
        onSelectNode={onSelectNode}
      />

      {node.dependencies.length > 0 && (
        <section className="details-section">
          <h3>Depends on ({node.dependencies.length})</h3>
          <div className="deps">
            {node.dependencies.map((dep) => {
              const exists = graph?.nodes.some((candidate) => candidate.id === dep) ?? false;
              return (
                <button
                  key={dep}
                  type="button"
                  className="dep-chip"
                  disabled={!exists || !onSelectNode}
                  onClick={() => onSelectNode?.(dep)}
                >
                  {dep}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function ColumnTable({ columns }: { columns: ObjectColumn[] }) {
  if (columns.length === 0) {
    return (
      <section className="details-section">
        <h3>Columns</h3>
        <p className="hint">No columns are available for this object.</p>
      </section>
    );
  }

  return (
    <section className="details-section">
      <h3>Columns ({columns.length})</h3>
      <div className="table-scroll">
        <table className="details-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Source / expression</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column, index) => (
              <tr key={`${column.kind}-${column.name}-${index}`}>
                <td>
                  <span className="column-name">{column.name}</span>
                  <span className="column-flags">
                    {column.isKey && <span className="tag key">key</span>}
                    {column.kind === "field" && <span className="tag field">DDIC</span>}
                    {column.localized && <span className="tag info">localized</span>}
                    {column.isVirtual && <span className="tag info">virtual</span>}
                    {column.notNull && <span className="tag info">not null</span>}
                  </span>
                </td>
                <td>{column.type ?? "—"}</td>
                <td className="expression">
                  {column.expression ?? "—"}
                  {column.redirectedTo && (
                    <div className="sub-expression">redirected to {column.redirectedTo}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AssociationList({
  associations,
  graph,
  onSelectNode,
}: {
  associations: ObjectAssociation[];
  graph: DependencyGraph | null;
  onSelectNode?: (id: string) => void;
}) {
  if (associations.length === 0) return null;

  return (
    <section className="details-section">
      <h3>Associations ({associations.length})</h3>
      <div className="association-list">
        {associations.map((association) => {
          const targetId = association.target.toUpperCase();
          const targetExists = graph?.nodes.some((node) => node.id === targetId) ?? false;
          return (
            <div key={`${association.name}-${association.target}`} className="association-item">
              <div className="association-title">
                <button
                  type="button"
                  className="link-button"
                  disabled={!targetExists || !onSelectNode}
                  onClick={() => onSelectNode?.(targetId)}
                >
                  {association.name}
                </button>
                <span className="muted">→ {association.target}</span>
                <span className={`tag ${association.usedInProjection ? "used" : "unused"}`}>
                  {association.usedInProjection ? "used" : "unused"}
                </span>
              </div>
              <div className="association-meta">
                {association.cardinality && <span>{association.cardinality}</span>}
                {association.associationKind === "composition" && <span>composition</span>}
                {association.toParent && <span>to parent</span>}
                {association.redirected && <span>redirected</span>}
              </div>
              {association.condition && (
                <code className="condition">{association.condition}</code>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EdgeDetails({
  edge,
  graph,
  onSelectNode,
}: {
  edge: DependencyEdge;
  graph: DependencyGraph | null;
  onSelectNode?: (id: string) => void;
}) {
  const relationship = edge.relationship;
  const kind = edge.sourceRole ?? relationship?.kind ?? "primary";
  const fromNode = graph?.nodes.find((node) => node.id === edge.from);
  const toNode = graph?.nodes.find((node) => node.id === edge.to);
  const unused = relationship?.usedInProjection === false;
  const right = relationship?.right ?? (toNode ? { name: toNode.name } : undefined);

  return (
    <div className="details">
      <div className="details-heading">
        <h2>{relationshipKindLabel(kind)} details</h2>
        {unused && <span className="tag unused">unused in projection</span>}
      </div>

      <section className="details-section">
        <h3>Participating objects</h3>
        <div className="endpoint-list">
          <EndpointButton label="From" node={fromNode} id={edge.from} onSelectNode={onSelectNode} />
          <EndpointButton label="To" node={toNode} id={edge.to} onSelectNode={onSelectNode} />
        </div>
      </section>

      <dl>
        <dt>Relationship</dt>
        <dd>{relationshipKindLabel(kind)}</dd>
        {kind === "join" && (
          <>
            <dt>Join type</dt>
            <dd>{joinTypeLabel(edge.joinType ?? relationship?.joinType)}</dd>
          </>
        )}
        {relationship?.alias && (
          <>
            <dt>Alias</dt>
            <dd>{relationship.alias}</dd>
          </>
        )}
        {relationship?.cardinality && (
          <>
            <dt>Cardinality</dt>
            <dd>{relationship.cardinality}</dd>
          </>
        )}
        {relationship?.associationKind && (
          <>
            <dt>Association kind</dt>
            <dd>
              {ASSOCIATION_KIND_LABEL[relationship.associationKind] ??
                relationship.associationKind}
            </dd>
          </>
        )}
        <dt>Used in projection</dt>
        <dd>{unused ? "No" : "Yes"}</dd>
        {relationship?.toParent && (
          <>
            <dt>To parent</dt>
            <dd>Yes</dd>
          </>
        )}
        {relationship?.redirected && (
          <>
            <dt>Redirected</dt>
            <dd>Yes</dd>
          </>
        )}
        {relationship?.self && (
          <>
            <dt>Self reference</dt>
            <dd>Yes</dd>
          </>
        )}
        {edge.relationship?.condition && (
          <>
            <dt>Condition</dt>
            <dd>
              <code className="condition">{edge.relationship.condition}</code>
            </dd>
          </>
        )}
      </dl>

      <section className="details-section">
        <h3>Condition operands</h3>
        <dl>
          <dt>Left</dt>
          <dd>
            <SourceRefList refs={relationship?.left ?? []} />
          </dd>
          <dt>Right</dt>
          <dd>
            <SourceRefList refs={right ? [right] : []} />
          </dd>
        </dl>
      </section>

      {(relationship?.predicates?.length ?? 0) > 0 && (
        <section className="details-section">
          <h3>Predicates ({relationship!.predicates!.length})</h3>
          <div className="table-scroll">
            <table className="details-table">
              <thead>
                <tr>
                  <th>Left</th>
                  <th>Op</th>
                  <th>Right</th>
                </tr>
              </thead>
              <tbody>
                {relationship!.predicates!.map((predicate, index) => (
                  <tr key={`${predicate.text}-${index}`}>
                    <td>{predicate.left ?? "—"}</td>
                    <td>{predicate.operator ?? "—"}</td>
                    <td>{predicate.right ?? predicate.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function EndpointButton({
  label,
  node,
  id,
  onSelectNode,
}: {
  label: string;
  node?: DependencyNode;
  id: string;
  onSelectNode?: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="endpoint"
      disabled={!node || !onSelectNode}
      onClick={() => onSelectNode?.(id)}
    >
      <span className="endpoint-label">{label}</span>
      <span className="endpoint-name">{node?.name ?? id}</span>
      {node && <span className="muted">{KIND_LABEL[node.kind]} · depth {node.depth}</span>}
    </button>
  );
}

function SourceRefList({ refs }: { refs: SourceRef[] }) {
  if (refs.length === 0) return <span className="muted">—</span>;
  return (
    <span className="source-ref-list">
      {refs.map((ref) => (
        <span key={`${ref.alias ?? ""}-${ref.name}`} className="dep-chip static">
          {ref.alias ? `${ref.alias} (${ref.name})` : ref.name}
        </span>
      ))}
    </span>
  );
}
