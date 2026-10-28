import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SystemIdentity } from "./types.js";

export interface ResolvedSystemIdentity extends SystemIdentity {
  source: "env" | "adt-config" | "fallback";
}

/**
 * Resolve a stable system key **without contacting SAP** (cache-only mode must
 * work offline).
 *
 * Priority:
 *   1. `CDS_REPO_SYSTEM_KEY` / `SAP_SYSTEM_KEY` (explicit; recommended).
 *   2. The local ADT CLI config `~/.adt/config.json` (`defaultSid` + client).
 *   3. `"default"`.
 *
 * Deliberately excludes usernames, passwords, tokens and URLs from the key;
 * SID alone is not assumed to uniquely identify an environment, so the client
 * is appended when known.
 */
export function resolveSystemIdentity(env: NodeJS.ProcessEnv = process.env): ResolvedSystemIdentity {
  const explicit = (env.CDS_REPO_SYSTEM_KEY ?? env.SAP_SYSTEM_KEY ?? "").trim();
  if (explicit) {
    return {
      key: sanitizeSystemKey(explicit),
      sid: env.SAP_SID?.trim() || undefined,
      client: env.SAP_CLIENT?.trim() || undefined,
      source: "env",
    };
  }

  try {
    const raw = readFileSync(join(homedir(), ".adt", "config.json"), "utf8");
    const config = JSON.parse(raw) as {
      defaultSid?: string;
      destinations?: Record<string, { options?: { client?: string } }>;
    };
    const sid = config.defaultSid?.trim();
    if (sid) {
      const client = config.destinations?.[sid]?.options?.client?.trim();
      return {
        key: sanitizeSystemKey(client ? `${sid}-${client}` : sid),
        sid,
        client: client || undefined,
        source: "adt-config",
      };
    }
  } catch {
    /* no readable ADT config — fall through */
  }

  return { key: "default", source: "fallback" };
}

export function sanitizeSystemKey(raw: string): string {
  const key = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || "default";
}
