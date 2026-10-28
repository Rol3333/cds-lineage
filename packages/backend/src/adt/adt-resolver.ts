import type { RepositoryCandidate, SourceFormat } from "@cds-visualiser/shared";
import { redactText, type Logger } from "../logging/logger.js";
import { decodeSource } from "./decode.js";
import { validateObjectName } from "./validate.js";
import type {
  AdtErrorCode,
  ObjectProvider,
  ObjectReadResult,
  ProcessAdapter,
} from "./types.js";

/**
 * Read-only resolver for SAP repository objects.
 *
 * The installed ADT CLI cannot use `adt get <name>` as a resolver (it exits 0
 * with "Object '<name>' not found" for both CDS entities and DDIC tables in the
 * target environment). The reliable flow is:
 *
 *   1. `adt search --json <name>` to discover the object's real type/subtype.
 *   2. Dispatch to the matching typed reader:
 *        DDLS/DF  -> `adt ddl read`        (CDS DDL source)
 *        TABL/DT  -> `adt table read`      (transparent table DDL)
 *        TABL/DS  -> `adt structure read`  (structure DDL)
 *        VIEW/DV  -> `adt fetch <vit-uri>` (metadata only; see README)
 *   3. Never infer a type from a reader failure, and never fall back to a
 *      different reader after a typed read fails.
 *
 * Only read operations are invoked; this class never writes to SAP.
 */
export class AdtObjectProvider implements ObjectProvider {
  private readonly command: string;
  private readonly timeoutMs?: number;
  private readonly logger?: Logger;
  private readonly stderrPreview: number;
  private readonly slowSapMs: number;

  constructor(
    private readonly process: ProcessAdapter,
    options: {
      command?: string;
      timeoutMs?: number;
      logger?: Logger;
      stderrPreview?: number;
      slowSapMs?: number;
    } = {},
  ) {
    this.command = options.command?.trim() || "adt";
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
    this.stderrPreview = options.stderrPreview ?? 2_000;
    this.slowSapMs = options.slowSapMs ?? 10_000;
  }

  async resolve(name: string): Promise<ObjectReadResult> {
    const requested = name.trim();
    const canonical = requested.toUpperCase();

    const validation = validateObjectName(requested);
    if (!validation.ok) {
      this.logger?.warn("Object name rejected before repository access", {
        event: "security.name.rejected",
        input: this.preview(requested),
        errorCode: "invalid-name",
        message: this.preview(validation.error!.message),
      });
      return {
        resolution: "read-failed",
        name: requested,
        canonicalName: canonical,
        errorCode: "invalid-name",
        message: validation.error!.message,
      };
    }

    const search = await this.search(requested);
    if (search.status === "failed") {
      return {
        resolution: "search-failed",
        name: requested,
        canonicalName: canonical,
        errorCode: search.errorCode,
        message: search.message,
        candidates: search.candidates,
      };
    }
    if (search.status === "not-found") {
      return {
        resolution: "not-found",
        name: requested,
        canonicalName: canonical,
        candidates: [],
        message: `No repository object named ${requested} was found.`,
      };
    }

    const selection = selectCandidate(canonical, search.candidates);
    switch (selection.status) {
      case "not-found":
        this.logger?.info("Repository search had no exact match", {
          event: "sap.candidate.refused",
          object: requested,
          resolution: "not-found",
          candidateCount: search.candidates.length,
        });
        return {
          resolution: "not-found",
          name: requested,
          canonicalName: canonical,
          candidates: search.candidates,
          message: `Repository search returned no exact match for ${requested}.`,
        };
      case "unsupported-type":
        this.logger?.warn("Resolved object type is not supported", {
          event: "sap.candidate.refused",
          object: requested,
          resolution: "unsupported-type",
          candidates: summarizeCandidates(selection.candidates),
        });
        return {
          resolution: "unsupported-type",
          name: requested,
          canonicalName: canonical,
          candidates: search.candidates,
          message:
            `Object ${requested} was found, but its repository type is not supported ` +
            `(${describeTypes(selection.candidates)}). Supported: DDLS, TABL/DT, TABL/DS, VIEW.`,
        };
      case "ambiguous":
        this.logger?.warn("Object matched multiple supported repository objects", {
          event: "sap.candidate.refused",
          object: requested,
          resolution: "ambiguous",
          candidates: summarizeCandidates(selection.candidates),
        });
        return {
          resolution: "ambiguous",
          name: requested,
          canonicalName: canonical,
          candidates: search.candidates,
          message:
            `Object ${requested} matched multiple supported repository objects ` +
            `(${describeCandidates(selection.candidates)}); refusing to guess.`,
        };
      case "ok":
        this.logger?.info("Repository candidate selected", {
          event: "sap.candidate.selected",
          object: selection.candidate.name,
          objectType: selection.candidate.objectType,
          objectSubtype: selection.candidate.objectSubtype,
          packageName: selection.candidate.packageName,
          resolution: "resolved",
        });
        return this.readSelected(requested, canonical, selection.candidate, selection.kind, search.candidates);
    }
  }

  private async search(name: string): Promise<SearchOutcome> {
    const startedAt = performance.now();
    const duration = (): number => Math.round(performance.now() - startedAt);
    this.logger?.debug("SAP repository search started", {
      event: "sap.search.start",
      object: name,
      timeoutMs: this.timeoutMs,
    });

    let result;
    try {
      result = await this.process.run(this.command, ["search", "--json", name], {
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      this.logger?.error("SAP repository search could not start", {
        event: "sap.spawn.failed",
        object: name,
        durationMs: duration(),
        err,
      });
      return { status: "failed", errorCode: "other", message: errorMessage(err) };
    }

    if (result.timedOut) {
      this.logger?.warn("SAP repository search timed out", {
        event: "sap.timeout",
        object: name,
        durationMs: duration(),
        timeoutMs: this.timeoutMs,
        errorCode: "timeout",
      });
      return { status: "failed", errorCode: "timeout", message: `Timed out searching for ${name}.` };
    }
    if (result.exitCode !== 0) {
      const failure = classifyFailure(result.stderr, result.exitCode);
      this.logger?.warn("SAP repository search failed", {
        event: "sap.search.failed",
        object: name,
        durationMs: duration(),
        exitCode: result.exitCode,
        errorCode: failure.errorCode,
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      });
      this.logStderrPreview(name, "search", result.stderr);
      return { status: "failed", ...failure };
    }

    const text = result.stdout.toString("utf8");
    const json = extractJsonArray(text);
    if (json) {
      try {
        const parsed: unknown = JSON.parse(json);
        if (!Array.isArray(parsed)) {
          this.logger?.warn("SAP repository search returned non-array JSON", {
            event: "sap.search.failed",
            object: name,
            durationMs: duration(),
            errorCode: "other",
          });
          return { status: "failed", errorCode: "other", message: "Search output JSON was not an array." };
        }
        const candidates = parsed
          .map(toCandidate)
          .filter((candidate): candidate is RepositoryCandidate => candidate !== undefined);
        if (candidates.length === 0) {
          this.logger?.info("SAP repository search found no objects", {
            event: "sap.search.not-found",
            object: name,
            durationMs: duration(),
          });
          return { status: "not-found", candidates: [] };
        }
        const durationMs = duration();
        this.logger?.info("SAP repository search completed", {
          event: "sap.search.ok",
          object: name,
          durationMs,
          candidateCount: candidates.length,
        });
        this.logSlowSearch(name, durationMs);
        return { status: "ok", candidates };
      } catch (err) {
        this.logger?.warn("SAP repository search output could not be parsed", {
          event: "sap.search.failed",
          object: name,
          durationMs: duration(),
          errorCode: "other",
          err,
        });
        return {
          status: "failed",
          errorCode: "other",
          message: `Could not parse search output: ${errorMessage(err)}`,
        };
      }
    }

    // `adt search --json` exits 0 with this text when nothing matches.
    if (/No objects found/i.test(text)) {
      this.logger?.info("SAP repository search found no objects", {
        event: "sap.search.not-found",
        object: name,
        durationMs: duration(),
      });
      return { status: "not-found", candidates: [] };
    }

    this.logger?.warn("SAP repository search returned unexpected output", {
      event: "sap.search.failed",
      object: name,
      durationMs: duration(),
      errorCode: "other",
    });
    return {
      status: "failed",
      errorCode: "other",
      message: `Unexpected search output for ${name}: ${text.trim().slice(0, 200)}`,
    };
  }

  private async readSelected(
    name: string,
    canonical: string,
    candidate: RepositoryCandidate,
    kind: ResolvedKind,
    allCandidates: RepositoryCandidate[],
  ): Promise<ObjectReadResult> {
    const base = {
      // Preserve the spelling returned by the SAP repository, not the caller's
      // casing/wildcard-free input.
      name: candidate.name,
      canonicalName: canonical,
      objectType: candidate.objectType,
      objectSubtype: candidate.objectSubtype,
      packageName: candidate.packageName,
      description: candidate.description,
      uri: candidate.uri,
      candidates: allCandidates,
    };

    if (kind === "view") {
      // The installed CLI has no `view read`. Its DDIC-view structure endpoint
      // returns HTTP 500 in the target system; the VIT metadata endpoint is the
      // only working read, so views are captured as metadata-only objects.
      const uri =
        candidate.uri ??
        `/sap/bc/adt/vit/wb/object_type/viewdv/object_name/${encodeURIComponent(candidate.name)}`;
      const read = await this.readPayload(["fetch", uri], {
        object: candidate.name,
        operation: "view-fetch",
        sourceFormat: "view-metadata",
      });
      if (!read.ok) {
        return { resolution: "read-failed", ...base, errorCode: read.errorCode, message: read.message };
      }
      // `adt fetch` prints a human "GET …" banner and "✅ Done!" footer on
      // stdout around the payload. Store canonical XML only.
      const xml = extractXmlPayload(read.source);
      if (!xml) {
        this.logger?.warn("View metadata did not contain an XML payload", {
          event: "sap.read.failed",
          object: candidate.name,
          operation: "view-fetch",
          errorCode: "other",
        });
        return {
          resolution: "read-failed",
          ...base,
          errorCode: "other",
          message: `View metadata for ${name} did not contain an XML payload.`,
        };
      }
      return {
        resolution: "resolved",
        ...base,
        source: xml,
        sourceFormat: "view-metadata",
        metadataOnly: true,
      };
    }

    const { args, format } = readerFor(kind, canonical);
    const read = await this.readPayload(args, {
      object: candidate.name,
      operation: kind === "cds" ? "ddl" : kind,
      sourceFormat: format,
    });
    if (!read.ok) {
      return { resolution: "read-failed", ...base, errorCode: read.errorCode, message: read.message };
    }
    return { resolution: "resolved", ...base, source: read.source, sourceFormat: format };
  }

  private async readPayload(
    args: string[],
    context: { object: string; operation: string; sourceFormat?: SourceFormat },
  ): Promise<{ ok: true; source: string } | { ok: false; errorCode: AdtErrorCode; message: string }> {
    const startedAt = performance.now();
    const duration = (): number => Math.round(performance.now() - startedAt);
    this.logger?.debug("SAP read started", {
      event: "sap.read.start",
      object: context.object,
      operation: context.operation,
      timeoutMs: this.timeoutMs,
    });

    let result;
    try {
      result = await this.process.run(this.command, args, { timeoutMs: this.timeoutMs });
    } catch (err) {
      this.logger?.error("SAP read could not start", {
        event: "sap.spawn.failed",
        object: context.object,
        operation: context.operation,
        durationMs: duration(),
        err,
      });
      return { ok: false, errorCode: "other", message: errorMessage(err) };
    }

    if (result.timedOut) {
      this.logger?.warn("SAP read timed out", {
        event: "sap.timeout",
        object: context.object,
        operation: context.operation,
        durationMs: duration(),
        timeoutMs: this.timeoutMs,
        errorCode: "timeout",
      });
      return { ok: false, errorCode: "timeout", message: `Timed out running: adt ${args.join(" ")}` };
    }
    if (result.exitCode !== 0) {
      const failure = classifyFailure(result.stderr, result.exitCode);
      this.logger?.warn("SAP read failed", {
        event: "sap.read.failed",
        object: context.object,
        operation: context.operation,
        durationMs: duration(),
        exitCode: result.exitCode,
        errorCode: failure.errorCode,
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
        stderrPreview: this.preview(result.stderr),
      });
      return { ok: false, ...failure };
    }

    const source = decodeSource(result.stdout);
    if (source.trim().length === 0) {
      this.logger?.warn("SAP read returned an empty payload", {
        event: "sap.read.failed",
        object: context.object,
        operation: context.operation,
        durationMs: duration(),
        errorCode: "empty-source",
        stdoutBytes: result.stdout.byteLength,
      });
      return {
        ok: false,
        errorCode: "empty-source",
        message: `adt ${args.join(" ")} returned an empty payload.`,
      };
    }

    const durationMs = duration();
    this.logger?.info("SAP read completed", {
      event: "sap.read.ok",
      object: context.object,
      operation: context.operation,
      durationMs,
      stdoutBytes: result.stdout.byteLength,
      sourceBytes: Buffer.byteLength(source, "utf8"),
      sourceFormat: context.sourceFormat,
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    });
    if (result.stderr.trim().length > 0) {
      this.logger?.debug("SAP read progress output", {
        event: "sap.stderr.preview",
        object: context.object,
        operation: context.operation,
        preview: this.preview(result.stderr),
      });
    }
    if (durationMs > this.slowSapMs) {
      this.logger?.warn("SAP read exceeded the slow-operation threshold", {
        event: "perf.slow.sap",
        object: context.object,
        operation: context.operation,
        durationMs,
        thresholdMs: this.slowSapMs,
      });
    }
    return { ok: true, source };
  }

  private logStderrPreview(object: string, operation: string, stderr: string): void {
    if (stderr.trim().length === 0) return;
    this.logger?.debug("SAP stderr preview", {
      event: "sap.stderr.preview",
      object,
      operation,
      preview: this.preview(stderr),
    });
  }

  private preview(value: string): string {
    // Strip ANSI control sequences and carriage-return progress overwrites.
    const clean = redactText(
      value
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, ""),
    );
    const max = Math.max(0, this.stderrPreview);
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  private logSlowSearch(object: string, durationMs: number): void {
    if (durationMs <= this.slowSapMs) return;
    this.logger?.warn("SAP search exceeded the slow-operation threshold", {
      event: "perf.slow.sap",
      object,
      operation: "search",
      durationMs,
      thresholdMs: this.slowSapMs,
    });
  }
}

type ResolvedKind = "cds" | "table" | "structure" | "view";
type CandidateKind = ResolvedKind | "unsupported";

type SearchOutcome =
  | { status: "ok"; candidates: RepositoryCandidate[] }
  | { status: "not-found"; candidates: RepositoryCandidate[] }
  | { status: "failed"; errorCode: AdtErrorCode; message: string; candidates?: RepositoryCandidate[] };

type Selection =
  | { status: "ok"; candidate: RepositoryCandidate; kind: ResolvedKind }
  | { status: "not-found" }
  | { status: "unsupported-type"; candidates: RepositoryCandidate[] }
  | { status: "ambiguous"; candidates: RepositoryCandidate[] };

function readerFor(kind: ResolvedKind, name: string): { args: string[]; format: SourceFormat } {
  switch (kind) {
    case "cds":
      return { args: ["ddl", "read", name], format: "asddls" };
    case "table":
      return { args: ["table", "read", name], format: "table" };
    case "structure":
      return { args: ["structure", "read", name], format: "structure" };
    case "view":
      // Handled separately (metadata fetch).
      return { args: ["fetch", name], format: "view-metadata" };
  }
}

function selectCandidate(canonical: string, candidates: RepositoryCandidate[]): Selection {
  const exact = candidates.filter((candidate) => candidate.name.toUpperCase() === canonical);
  if (exact.length === 0) return { status: "not-found" };

  const supported = exact
    .map((candidate) => ({ candidate, kind: classifyCandidate(candidate) }))
    .filter(
      (entry): entry is { candidate: RepositoryCandidate; kind: ResolvedKind } =>
        entry.kind !== "unsupported",
    );

  if (supported.length === 0) return { status: "unsupported-type", candidates: exact };
  if (supported.length > 1) return { status: "ambiguous", candidates: supported.map((s) => s.candidate) };

  const only = supported[0]!;
  return { status: "ok", candidate: only.candidate, kind: only.kind };
}

/**
 * Classify a search candidate structurally.
 *
 * Important real-world detail: DDIC structures are reported by `adt search` as
 * `TABL/DS` (not `STRU`), and transparent tables as `TABL/DT`. The URI path is
 * used as a fallback when the subtype is missing.
 */
function classifyCandidate(candidate: RepositoryCandidate): CandidateKind {
  const type = candidate.objectType.toUpperCase();
  const subtype = (candidate.objectSubtype ?? "").toUpperCase();
  const uri = (candidate.uri ?? "").toLowerCase();

  if (type === "DDLS") return "cds";
  if (type === "TABL") {
    if (subtype === "DS" || uri.includes("/ddic/structures/")) return "structure";
    if (subtype === "DT" || uri.includes("/ddic/tables/")) return "table";
    return "unsupported";
  }
  if (type === "VIEW") return "view";
  return "unsupported";
}

function toCandidate(raw: unknown): RepositoryCandidate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  if (!name || !type) return undefined;

  const [objectType, objectSubtype] = splitType(type);
  return {
    name,
    objectType,
    objectSubtype,
    packageName: typeof obj.packageName === "string" ? obj.packageName : undefined,
    uri: typeof obj.uri === "string" ? obj.uri : undefined,
    description: typeof obj.description === "string" ? obj.description : undefined,
  };
}

function splitType(type: string): [string, string?] {
  const idx = type.indexOf("/");
  if (idx < 0) return [type.toUpperCase(), undefined];
  const subtype = type.slice(idx + 1).trim().toUpperCase();
  return [type.slice(0, idx).trim().toUpperCase(), subtype || undefined];
}

/**
 * Extract the first complete JSON array from CLI output.
 *
 * `adt search --json` writes a human banner and a `✅ Search complete!` footer
 * to **stdout** around the JSON array (stderr stays empty). This scanner is
 * string-aware so `]` inside a description cannot truncate the payload.
 */
/** Extract the first `<…>` XML document from CLI banner/footer output. */
export function extractXmlPayload(text: string): string | undefined {
  const start = text.indexOf("<");
  const end = text.lastIndexOf(">");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

export function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function classifyFailure(
  stderr: string,
  exitCode: number | null,
): { errorCode: AdtErrorCode; message: string } {
  const message = stderr.trim() || `adt exited with code ${exitCode ?? "unknown"}.`;
  const s = message.toLowerCase();

  if (/not found|does not exist|doesn't exist|not exist|no such|404/i.test(s)) {
    return { errorCode: "not-found", message };
  }
  if (/auth|unauthori|forbidden|403|401|logon|cookie|token|not authenticated|permission/i.test(s)) {
    return { errorCode: "auth", message };
  }
  if (/timeout|etimedout|timed out/i.test(s)) {
    return { errorCode: "timeout", message };
  }
  if (/connection|econnrefused|econnreset|enotfound|network|unreachable|proxy|dns|eai_again/i.test(s)) {
    return { errorCode: "connection", message };
  }
  return { errorCode: "other", message };
}

function describeCandidate(candidate: RepositoryCandidate): Record<string, unknown> {
  return {
    name: candidate.name,
    objectType: candidate.objectType,
    objectSubtype: candidate.objectSubtype,
    packageName: candidate.packageName,
  };
}

function summarizeCandidates(candidates: RepositoryCandidate[]): Array<Record<string, unknown>> {
  return candidates.map(describeCandidate);
}

function describeTypes(candidates: RepositoryCandidate[]): string {
  return candidates.map((c) => `${c.name} (${c.objectType}${c.objectSubtype ? `/${c.objectSubtype}` : ""})`).join(", ");
}

function describeCandidates(candidates: RepositoryCandidate[]): string {
  return candidates
    .map((c) => `${c.objectType}${c.objectSubtype ? `/${c.objectSubtype}` : ""} ${c.packageName ?? "?"}`)
    .join(", ");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
