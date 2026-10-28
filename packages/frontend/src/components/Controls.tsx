import { useState, type FormEvent } from "react";
import { DEFAULT_MAX_DEPTH } from "@cds-visualiser/shared";

interface ControlsProps {
  loading: boolean;
  onAnalyze: (name: string, maxDepth: number) => void;
}

export default function Controls({ loading, onAnalyze }: ControlsProps) {
  const [name, setName] = useState("");
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || loading) return;
    onAnalyze(name.trim(), maxDepth);
  };

  return (
    <form className="form" onSubmit={submit}>
      <label>
        CDS/DDIC object name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ZC_PurReqItemQRY001"
          autoFocus
          spellCheck={false}
        />
      </label>
      <label>
        Maximum dependency depth
        <select value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))}>
          {[1, 2, 3, 4].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="primary" disabled={loading || !name.trim()}>
        {loading ? "Analysing…" : "Analyse dependencies"}
      </button>
      <p className="hint">
        Resolves objects through SAP repository search, reads the typed source, and renders the
        dependency graph. Results are cached in the local repository; depth is capped at 4 to keep
        SAP load bounded. Root sits at the top; dependencies appear below.
      </p>
    </form>
  );
}
