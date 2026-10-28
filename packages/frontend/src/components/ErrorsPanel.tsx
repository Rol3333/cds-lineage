import type { DependencyGraph, GraphDiagnostic } from "@cds-visualiser/shared";

interface ErrorsPanelProps {
  graph: DependencyGraph | null;
  requestError?: string | null;
}

const PARSE_WARNING = /parsed with \d+ error/;

export default function ErrorsPanel({ graph, requestError }: ErrorsPanelProps) {
  const diagnostics = graph?.diagnostics ?? [];
  const parseDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category === "parse");
  const otherDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category !== "parse");
  const diagnosticMessages = diagnostics.map((diagnostic) => diagnostic.message.toLowerCase());
  const otherWarnings =
    graph?.warnings.filter((warning) => {
      if (PARSE_WARNING.test(warning)) return false;
      const lower = warning.toLowerCase();
      return !diagnosticMessages.some(
        (message) => message.includes(lower) || lower.includes(message),
      );
    }) ?? [];

  const empty =
    !requestError &&
    parseDiagnostics.length === 0 &&
    otherDiagnostics.length === 0 &&
    otherWarnings.length === 0;

  return (
    <div className="errors-panel">
      <div className="details-heading">
        <h2>Errors &amp; warnings</h2>
        {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
      </div>

      {requestError && <div className="error-banner">{requestError}</div>}

      {empty && <p className="hint">No parser errors or analysis warnings.</p>}

      {parseDiagnostics.length > 0 && (
        <section className="details-section">
          <h3>Parser errors ({parseDiagnostics.length})</h3>
          <div className="diagnostic-list">
            {parseDiagnostics.map((diagnostic) => (
              <DiagnosticItem key={diagnostic.id} diagnostic={diagnostic} />
            ))}
          </div>
        </section>
      )}

      {otherDiagnostics.length > 0 && (
        <section className="details-section">
          <h3>Analysis issues ({otherDiagnostics.length})</h3>
          <div className="diagnostic-list">
            {otherDiagnostics.map((diagnostic) => (
              <DiagnosticItem key={diagnostic.id} diagnostic={diagnostic} />
            ))}
          </div>
        </section>
      )}

      {otherWarnings.length > 0 && (
        <section className="details-section">
          <h3>Warnings ({otherWarnings.length})</h3>
          <div className="diagnostic-list">
            {otherWarnings.map((warning, index) => (
              <div key={`${warning}-${index}`} className="diagnostic warning">
                <div className="diagnostic-message">{warning}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DiagnosticItem({ diagnostic }: { diagnostic: GraphDiagnostic }) {
  return (
    <div className={`diagnostic ${diagnostic.severity}`}>
      <div className="diagnostic-header">
        <span className={`tag severity-${diagnostic.severity}`}>{diagnostic.severity}</span>
        <span className="tag unknown">{diagnostic.category}</span>
        {diagnostic.objectId && <span className="diagnostic-object">{diagnostic.objectId}</span>}
        {diagnostic.line !== undefined && (
          <span className="muted">
            line {diagnostic.line}
            {diagnostic.column !== undefined ? `:${diagnostic.column}` : ""}
          </span>
        )}
      </div>
      <div className="diagnostic-message">{diagnostic.message}</div>
    </div>
  );
}
