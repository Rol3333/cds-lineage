import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFormat } from "@cds-visualiser/shared";
import { decodeSource } from "../adt/decode.js";

/** Absolute path to `packages/backend`, used to resolve relative fixture dirs. */
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface LoadedFixtures {
  sources: Record<string, string>;
  objectTypes: Record<string, string>;
  formats: Record<string, SourceFormat>;
}

interface FixtureFileKind {
  suffix: string;
  type: string;
  format: SourceFormat;
}

const FIXTURE_KINDS: FixtureFileKind[] = [
  { suffix: ".asddls", type: "DDLS/DF", format: "asddls" },
  { suffix: ".structure", type: "TABL/DS", format: "structure" },
  { suffix: ".table", type: "TABL/DT", format: "table" },
  { suffix: ".view.xml", type: "VIEW/DV", format: "view-metadata" },
];

/**
 * Load bundled fixtures from a directory:
 *   - `*.asddls`     → CDS DDL source
 *   - `*.table`      → DDIC transparent-table DDL
 *   - `*.structure`  → DDIC structure DDL
 *   - `*.view.xml`   → DDIC view metadata XML
 *   - `objectTypes.json` → name → ADT type (e.g. `TABL`, `TABL/DS`, `VIEW/DV`)
 *
 * The object name is the file stem (without the known suffix). Encoding is
 * auto-detected per file, so UTF-8 and UTF-16 fixtures both work.
 */
export function loadFixtureDir(dir: string): LoadedFixtures {
  const absoluteDir = resolve(BACKEND_ROOT, dir);
  const sources: Record<string, string> = {};
  const objectTypes: Record<string, string> = {};
  const formats: Record<string, SourceFormat> = {};

  for (const entry of readdirSync(absoluteDir)) {
    const kind = FIXTURE_KINDS.find((k) => entry.toLowerCase().endsWith(k.suffix));
    if (!kind) continue;

    const name = entry.slice(0, -kind.suffix.length).toUpperCase();
    if (!name) continue;
    const buffer = readFileSync(join(absoluteDir, entry));
    sources[name] = decodeSource(buffer);
    objectTypes[name] = kind.type;
    formats[name] = kind.format;
  }

  const typesPath = join(absoluteDir, "objectTypes.json");
  if (existsSync(typesPath)) {
    const parsed = JSON.parse(readFileSync(typesPath, "utf8")) as Record<string, string>;
    for (const [name, type] of Object.entries(parsed)) {
      const key = name.toUpperCase();
      objectTypes[key] = type;
      if (!formats[key]) {
        const normalized = type.toUpperCase();
        const base = normalized.split("/")[0];
        formats[key] =
          base === "VIEW"
            ? "view-metadata"
            : base === "TABL" && normalized.includes("/DS")
              ? "structure"
              : base === "TABL"
                ? "table"
                : "asddls";
      }
    }
  }

  return { sources, objectTypes, formats };
}
