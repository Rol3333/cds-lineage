import { useCallback, useEffect, useState } from "react";
import type { AnalyzeResult } from "@cds-visualiser/shared";
import { analyzeCds, fetchHealth, type Health } from "./api";
import Controls from "./components/Controls";
import DetailsPanel from "./components/DetailsPanel";
import GraphCanvas from "./components/GraphCanvas";

export default function App() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const handleAnalyze = useCallback(async (name: string, maxDepth: number) => {
    setLoading(true);
    setError(null);
    setSelectedId(null);
    try {
      const res = await analyzeCds({ name, maxDepth });
      setResult(res);
      if (res.graph.nodes.length > 0) setSelectedId(res.graph.rootId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectedNode = result?.graph.nodes.find((n) => n.id === selectedId) ?? null;
  const hasGraph = result != null && result.graph.nodes.length > 0;

  return (
    <div className="app">
      <header className="header">
        <h1>Abapify CDS Visualiser</h1>
        {health?.fixtureMode && <span className="badge fixture">Fixture mode (no SAP)</span>}
        {health && !health.fixtureMode && health.cacheMode && (
          <span className="badge cache-mode">
            cache: {health.cacheMode}
            {health.systemKey ? ` · ${health.systemKey}` : ""}
          </span>
        )}
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <Controls loading={loading} onAnalyze={handleAnalyze} />
          {error && <div className="error-banner">{error}</div>}
          {result && result.graph.warnings.length > 0 && (
            <div className="warnings">
              {result.graph.warnings.map((w, i) => (
                <div key={i} className="warning-item">
                  {w}
                </div>
              ))}
            </div>
          )}
          <DetailsPanel node={selectedNode} />
        </aside>

        <main className="canvas">
          {!hasGraph && !loading && (
            <div className="empty-state">
              <div>
                <p style={{ fontSize: 18, marginBottom: 4 }}>No graph yet</p>
                <p style={{ margin: 0 }}>
                  Enter a CDS entity name and run an analysis to see its dependencies.
                </p>
              </div>
            </div>
          )}
          {loading && hasGraph === false && (
            <div className="empty-state">
              <div>Analysing…</div>
            </div>
          )}
          {hasGraph && result && <GraphCanvas graph={result.graph} onSelect={setSelectedId} />}
        </main>
      </div>
    </div>
  );
}
