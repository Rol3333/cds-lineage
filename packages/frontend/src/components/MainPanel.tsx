import type { AnalyzeResult } from "@cds-visualiser/shared";
import Controls from "./Controls";

interface MainPanelProps {
  result: AnalyzeResult | null;
  loading: boolean;
  showAssociations: boolean;
  onToggleAssociations: (value: boolean) => void;
  onAnalyze: (name: string, maxDepth: number) => void;
}

export default function MainPanel({
  result,
  loading,
  showAssociations,
  onToggleAssociations,
  onAnalyze,
}: MainPanelProps) {
  const graph = result?.graph;
  const errorCount = graph?.diagnostics?.length ?? 0;
  const unusedCount =
    graph?.edges.filter((edge) => edge.relationship?.usedInProjection === false).length ?? 0;

  return (
    <div className="main-panel">
      <Controls
        loading={loading}
        showAssociations={showAssociations}
        onToggleAssociations={onToggleAssociations}
        onAnalyze={onAnalyze}
      />

      {graph && (
        <section className="details-section">
          <h3>Analysis summary</h3>
          <div className="summary-grid">
            <div>
              <span className="summary-value">{graph.nodes.length}</span>
              <span className="summary-label">objects</span>
            </div>
            <div>
              <span className="summary-value">{graph.edges.length}</span>
              <span className="summary-label">relationships</span>
            </div>
            <div>
              <span className="summary-value">{errorCount}</span>
              <span className="summary-label">issues</span>
            </div>
            <div>
              <span className="summary-value">{unusedCount}</span>
              <span className="summary-label">unused</span>
            </div>
          </div>
          <p className="hint">
            Root: <strong>{graph.rootId}</strong>. Unused joins and associations remain visible but
            are marked as unused when no projection column references their alias.
          </p>
        </section>
      )}

      <section className="details-section">
        <h3>Legend</h3>
        <div className="legend">
          <span className="legend-item"><span className="legend-line primary" /> Primary</span>
          <span className="legend-item"><span className="legend-line join" /> Join</span>
          <span className="legend-item"><span className="legend-line association" /> Association</span>
          <span className="legend-item"><span className="legend-line unused" /> Unused</span>
        </div>
      </section>
    </div>
  );
}
