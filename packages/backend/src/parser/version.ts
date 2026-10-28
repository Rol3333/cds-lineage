import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Versioning for derived artifacts.
 *
 * `parsed.json` / `dependencies.json` record these values. When the extractor
 * logic or the underlying parser changes, cached source does **not** need to be
 * fetched again from SAP: the collector re-derives the artifacts from the
 * cached source and marks them current.
 *
 * Bump `EXTRACTOR_VERSION` whenever the structural extraction semantics change
 * (e.g. new source roles, new traversal rules).
 */
export const EXTRACTOR_VERSION = "3";

export const PARSER_NAME = "@abapify/acds";

function readInstalledParserVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("@abapify/acds"));
    for (let i = 0; i < 5; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === PARSER_NAME && typeof pkg.version === "string") return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

/**
 * Resolved at module load from the installed package so the value cannot drift
 * silently from the actual parser version. Falls back to `"unknown"` when the
 * package layout is unusual; a version change still invalidates derived data.
 */
export const PARSER_VERSION = readInstalledParserVersion();
