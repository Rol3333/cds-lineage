import { useCallback, useEffect, useState } from "react";
import type { AnalyzeResult } from "@cds-visualiser/shared";
import { analyzeCds, fetchHealth, type Health } from "./api";
import DetailsPanel from "./components/DetailsPanel";
import ErrorsPanel from "./components/ErrorsPanel";
import GraphCanvas from "./components/GraphCanvas";
import MainPanel from "./components/MainPanel";
import { exportGraphHtml } from "./export-html";

type SidebarTab = "main" | "details" | "errors";
type Selection = { type: "node" | "edge"; id: string } | null;

export default function App() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>("main");
  const [showAssociations, setShowAssociations] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const handleAnalyze = useCallback(async (name: string, maxDepth: number) => {
    setLoading(true);
    setError(null);
    setSelection(null);
    try {
      const res = await analyzeCds({ name, maxDepth });
      setResult(res);
      if (res.graph.nodes.length > 0) {
        setSelection({ type: "node", id: res.graph.rootId });
        setActiveTab("details");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelectNode = useCallback((id: string) => {
    setSelection({ type: "node", id });
    setActiveTab("details");
  }, []);

  const handleSelectEdge = useCallback((id: string) => {
    setSelection({ type: "edge", id });
    setActiveTab("details");
  }, []);

  const handleClearSelection = useCallback(() => setSelection(null), []);

  const selectedNode =
    result && selection?.type === "node"
      ? result.graph.nodes.find((node) => node.id === selection.id) ?? null
      : null;
  const selectedEdge =
    result && selection?.type === "edge"
      ? result.graph.edges.find((edge) => edge.id === selection.id) ?? null
      : null;
  const hasGraph = result != null && result.graph.nodes.length > 0;
  const issueCount = result?.graph.diagnostics?.length ?? 0;

  const handleSaveHtml = useCallback(async () => {
    if (!result || !hasGraph || exporting) return;
    const element = document.querySelector(".react-flow") as HTMLElement | null;
    if (!element) {
      setError("The graph is not ready to export yet.");
      return;
    }

    setExporting(true);
    setError(null);
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await exportGraphHtml({
        graph: result.graph,
        element,
        showAssociations,
        systemKey: health?.systemKey,
        fixtureMode: health?.fixtureMode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [result, hasGraph, exporting, health, showAssociations]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <h1>Abapify CDS Visualiser</h1>
          {health?.fixtureMode && <span className="badge fixture">Fixture mode (no SAP)</span>}
          {health && !health.fixtureMode && health.cacheMode && (
            <span className="badge cache-mode">
              cache: {health.cacheMode}
              {health.systemKey ? ` · ${health.systemKey}` : ""}
            </span>
          )}
        </div>
        <button
          type="button"
          className="secondary"
          onClick={handleSaveHtml}
          disabled={!hasGraph || exporting}
          title={hasGraph ? "Save a self-contained HTML report" : "Run an analysis first"}
        >
          {exporting ? "Saving…" : "Save HTML"}
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-tabs" role="tablist" aria-label="Inspector">
            <TabButton
              tab="main"
              activeTab={activeTab}
              label="Main"
              onClick={setActiveTab}
            />
            <TabButton
              tab="details"
              activeTab={activeTab}
              label="Details"
              onClick={setActiveTab}
            />
            <TabButton
              tab="errors"
              activeTab={activeTab}
              label="Errors"
              count={issueCount}
              onClick={setActiveTab}
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="tab-content">
            {activeTab === "main" && (
              <MainPanel
                result={result}
                loading={loading}
                showAssociations={showAssociations}
                onToggleAssociations={setShowAssociations}
                onAnalyze={handleAnalyze}
              />
            )}
            {activeTab === "details" && (
              <DetailsPanel
                node={selectedNode}
                edge={selectedEdge}
                graph={result?.graph ?? null}
                onSelectNode={handleSelectNode}
              />
            )}
            {activeTab === "errors" && <ErrorsPanel graph={result?.graph ?? null} />}
          </div>
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
          {hasGraph && result && (
            <GraphCanvas
              graph={result.graph}
              showAssociations={showAssociations}
              selectedNodeId={selection?.type === "node" ? selection.id : null}
              selectedEdgeId={selection?.type === "edge" ? selection.id : null}
              onSelectNode={handleSelectNode}
              onSelectEdge={handleSelectEdge}
              onClearSelection={handleClearSelection}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function TabButton({
  tab,
  activeTab,
  label,
  count,
  onClick,
}: {
  tab: SidebarTab;
  activeTab: SidebarTab;
  label: string;
  count?: number;
  onClick: (tab: SidebarTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === tab}
      className={`tab-button${activeTab === tab ? " active" : ""}`}
      onClick={() => onClick(tab)}
    >
      {label}
      {count !== undefined && count > 0 && <span className="tab-count">{count}</span>}
    </button>
  );
}
