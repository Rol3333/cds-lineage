import { createHash, randomUUID } from "node:crypto";
import type {
  AnalyzeResult,
  CacheMode,
  DependencyEdge,
  DependencyNode,
  ErrorCode,
  GraphDiagnostic,
  SourceKind,
} from "@cds-visualiser/shared";
import {
  canonicalName,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_OBJECTS,
  MAX_DEPTH_LIMIT,
} from "@cds-visualiser/shared";
import type { ObjectProvider, ObjectReadResult } from "../adt/types.js";
import { runWithLogContext } from "../logging/context.js";
import { redactText, type Logger } from "../logging/logger.js";
import { classifyDefinitionKinds, extractSources } from "../parser/extract-sources.js";

export interface CollectorOptions {
  maxDepth: number;
  maxObjects: number;
  concurrency: number;
}

export interface NameValidator {
  (name: string): { ok: boolean; error?: { errorCode: ErrorCode; message: string } };
}

export interface CollectorDeps {
  provider: ObjectProvider;
  options: CollectorOptions;
  validate: NameValidator;
  /** Optional cache-mode context for the response summary. */
  cache?: { mode: CacheMode; systemKey?: string };
  logger?: Logger;
  parseLogger?: Logger;
  slowParseMs?: number;
  slowAnalysisMs?: number;
}

interface Task {
  id: string;
  name: string;
  depth: number;
}

/**
 * Bounded dependency collector: resolves and parses objects up to `maxDepth`
 * levels below the root, deduplicating repeated references and terminating on
 * cycles. Partial results (failed branches) are preserved.
 *
 * CDS sources are expanded structurally. DDIC tables/structures/views are
 * captured as loaded leaf nodes. Unresolved or unsupported dependencies are
 * preserved as explicit `unknown` nodes rather than guessed or dropped.
 */
export async function analyze(rootName: string, deps: CollectorDeps): Promise<AnalyzeResult> {
  const analysisId = randomUUID();
  const rootId = canonicalName(rootName);

  return runWithLogContext(
    {
      analysisId,
      rootObject: rootId,
      systemKey: deps.cache?.systemKey,
      cacheMode: deps.cache?.mode,
    },
    () => analyzeInternal(rootName, deps),
  );
}

async function analyzeInternal(rootName: string, deps: CollectorDeps): Promise<AnalyzeResult> {
  const { provider, options, validate } = deps;
  const log = deps.logger;
  const parseLog = deps.parseLogger ?? log;
  const startedAt = performance.now();

  // Hard cap: never crawl deeper than the shared limit, even if a caller asks.
  const requestedDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxDepth = Math.min(MAX_DEPTH_LIMIT, Math.max(0, Math.floor(requestedDepth)));
  const maxObjects = Number.isFinite(options.maxObjects)
    ? Math.max(1, Math.floor(options.maxObjects))
    : DEFAULT_MAX_OBJECTS;
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency))
    : DEFAULT_CONCURRENCY;

  log?.info("Analysis started", {
    event: "analysis.start",
    root: preview(rootName.trim(), 200),
    requestedDepth: requestedDepth,
    effectiveDepth: maxDepth,
    maxObjects,
    concurrency,
    cacheMode: deps.cache?.mode,
  });

  const rootId = canonicalName(rootName);
  const nodes = new Map<string, DependencyNode>();
  const edges: DependencyEdge[] = [];
  const warnings: string[] = [];
  const diagnostics: GraphDiagnostic[] = [];
  const parent = new Map<string, string | null>();
  const edgeCount = new Map<string, number>();

  const addDiagnostic = (diagnostic: Omit<GraphDiagnostic, "id">): void => {
    diagnostics.push({ id: `diag-${diagnostics.length + 1}`, ...diagnostic });
  };

  let truncated = false;
  let limitReached: AnalyzeResult["limitReached"];

  const complete = (result: AnalyzeResult): AnalyzeResult => {
    const durationMs = Math.round(performance.now() - startedAt);
    const nodeList = result.graph.nodes;
    const loaded = nodeList.filter((node) => node.status === "loaded").length;
    const unknown = nodeList.filter((node) => node.kind === "unknown").length;
    const notExpanded = nodeList.filter((node) => node.status === "not-expanded").length;

    log?.info("Analysis finished", {
      event: "analysis.finish",
      durationMs,
      nodes: nodeList.length,
      edges: result.graph.edges.length,
      loaded,
      unknown,
      notExpanded,
      truncated: result.truncated,
      limitReached: result.limitReached,
      warningCount: result.graph.warnings.length,
      cacheHits: result.cache?.hits,
      cacheMisses: result.cache?.misses,
    });

    for (const warning of result.graph.warnings) {
      log?.debug("Analysis warning", { event: "analysis.warning", warning: preview(warning) });
    }

    const slowAnalysisMs = deps.slowAnalysisMs ?? 30_000;
    if (durationMs > slowAnalysisMs) {
      log?.warn("Analysis exceeded the slow-operation threshold", {
        event: "perf.slow.analysis",
        root: rootId,
        durationMs,
        thresholdMs: slowAnalysisMs,
      });
    }
    return result;
  };

  const ensureNode = (id: string, depth: number): DependencyNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, name: id, kind: "unknown", depth, status: "unknown", expandable: false, dependencies: [] };
      nodes.set(id, node);
    }
    return node;
  };

  const addEdge = (from: string, to: string, relationship?: DependencyEdge["relationship"]): void => {
    const key = `${from}->${to}`;
    const n = (edgeCount.get(key) ?? 0) + 1;
    edgeCount.set(key, n);
    edges.push({
      id: n === 1 ? key : `${key}#${n}`,
      from,
      to,
      sourceRole: relationship?.kind,
      joinType: relationship?.joinType,
      relationship,
    });
  };

  const isAncestor = (maybeAncestor: string, nodeId: string): boolean => {
    let current: string | null = nodeId;
    const visited = new Set<string>();
    while (current !== null && !visited.has(current)) {
      if (current === maybeAncestor) return true;
      visited.add(current);
      current = parent.get(current) ?? null;
    }
    return false;
  };

  // --- Root validation -------------------------------------------------------
  const validation = validate(rootName);
  if (!validation.ok) {
    const node = ensureNode(rootId, 0);
    node.status = "read-error";
    node.errorCode = validation.error!.errorCode;
    node.errorMessage = validation.error!.message;

    log?.warn("Root object name rejected", {
      event: "security.name.rejected",
      input: preview(rootName, 200),
      errorCode: validation.error!.errorCode,
      message: preview(validation.error!.message, 500),
    });
    addDiagnostic({
      severity: "error",
      category: "request",
      message: validation.error!.message,
      objectId: rootId,
    });

    return complete({
      graph: { rootId, maxDepth, nodes: [...nodes.values()], edges: [], warnings, diagnostics },
      truncated: false,
      ...(deps.cache ? { cache: { ...deps.cache, hits: 0, misses: 0 } } : {}),
    });
  }

  const root = ensureNode(rootId, 0);
  parent.set(rootId, null);

  const pending: Task[] = [{ id: rootId, name: rootName.trim(), depth: 0 }];

  const processNode = async (task: Task): Promise<void> =>
    runWithLogContext({ object: task.id, depth: task.depth }, async () => {
      const node = nodes.get(task.id);
      if (!node) return;

      let result: ObjectReadResult;
      try {
        result = await provider.resolve(task.name);
      } catch (err) {
        result = {
          resolution: "read-failed",
          name: task.name,
          canonicalName: task.id,
          errorCode: "other",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      node.objectType = result.objectType;
      node.objectSubtype = result.objectSubtype;
      node.resolution = result.resolution;
      if (result.cacheHit !== undefined) node.cacheHit = result.cacheHit;
      if (result.stale) node.stale = true;

      if (result.refreshFailed) {
        const message = result.message ?? "Refresh failed; serving the previously cached copy.";
        warnings.push(`${node.id}: ${message}`);
        addDiagnostic({
          severity: "warning",
          category: "cache",
          message,
          objectId: node.id,
        });
      }
      if (result.stale) {
        const message = "cached copy is stale and could not be fully regenerated.";
        warnings.push(`${node.id}: ${message}`);
        addDiagnostic({
          severity: "warning",
          category: "cache",
          message,
          objectId: node.id,
        });
      }

      if (result.resolution !== "resolved") {
        applyResolutionFailure(node, result, warnings);
        addDiagnostic({
          severity: "error",
          category: "resolution",
          message: node.errorMessage ?? `Resolution failed: ${result.resolution}.`,
          objectId: node.id,
        });
        log?.warn("Dependency could not be resolved", {
          event: "analysis.node.failed",
          resolution: result.resolution,
          errorCode: node.errorCode,
          message: preview(node.errorMessage),
        });
        if (result.resolution === "ambiguous" || result.resolution === "unsupported-type") {
          log?.warn("Resolution refused rather than guessed", {
            event: "security.resolution.refused",
            resolution: result.resolution,
            candidates: result.candidates?.map((candidate) => ({
              name: candidate.name,
              objectType: candidate.objectType,
              objectSubtype: candidate.objectSubtype,
              packageName: candidate.packageName,
            })),
          });
        }
        return;
      }

      const type = (result.objectType ?? "").toUpperCase();

      // --- Non-CDS objects: captured leaf nodes ---------------------------------
      if (type !== "DDLS") {
        node.kind = kindFromType(type, result.objectSubtype);
        node.status = "loaded";
        node.expandable = false;

        if (
          result.source &&
          (result.sourceFormat === "table" || result.sourceFormat === "structure")
        ) {
          const tableStructure = extractSources(result.source);
          if (tableStructure.columns.length > 0) node.columns = tableStructure.columns;
        }

        parseLog?.info("Object classified", {
          event: "object.classified",
          objectType: type,
          objectSubtype: result.objectSubtype,
          kind: node.kind,
          metadataOnly: result.metadataOnly ?? false,
          sourceFormat: result.sourceFormat,
        });

        if (node.kind === "unknown") {
          warnings.push(
            `${node.id}: resolved as type ${type || "(unknown)"}, which has no explicit handler; kept as an unknown leaf.`,
          );
          parseLog?.warn("Object type has no explicit handler", {
            event: "object.unknown-leaf",
            objectType: type,
            objectSubtype: result.objectSubtype,
          });
        }
        if (type === "VIEW") {
          warnings.push(
            `${node.id}: DDIC view captured as metadata only; the installed ADT CLI exposes no view source/structure reader.`,
          );
        }
        return;
      }

      // --- CDS source: parse and expand -----------------------------------------
      if (!result.source || result.source.trim().length === 0) {
        node.kind = "cds";
        node.status = "empty-source";
        node.errorCode = "empty-source";
        node.errorMessage = "CDS source was empty.";
        parseLog?.warn("CDS source was empty", {
          event: "object.empty-source",
          objectType: type,
        });
        return;
      }

      const sourceBytes = Buffer.byteLength(result.source, "utf8");
      const sourceHash = createHash("sha256").update(result.source, "utf8").digest("hex");
      const parseStartedAt = performance.now();
      const extracted = extractSources(result.source);
      const parseDurationMs = Math.round(performance.now() - parseStartedAt);
      const slowParseMs = deps.slowParseMs ?? 1_000;

      node.columns = extracted.columns;
      node.associations = extracted.associations;
      node.parseErrors = extracted.parseErrors;
      for (const error of extracted.parseErrors) {
        addDiagnostic({
          severity: "error",
          category: "parse",
          message: preview(error.message, 1_000) ?? "Parser error",
          objectId: node.id,
          line: error.line,
          column: error.column,
        });
      }

      // Genuine parse failure: no usable definition could be parsed at all.
      if (extracted.definitionKinds.length === 0) {
        node.status = "parse-error";
        node.errorCode = "parse-failure";
        node.errorMessage = extracted.parseErrors
          .map((e) => `line ${e.line}: ${e.message}`)
          .join("; ");
        node.kind = "unknown";

        parseLog?.error("CDS parse failed", {
          event: "parse.failed",
          sourceBytes,
          sourceHash,
          durationMs: parseDurationMs,
          parseErrorCount: extracted.parseErrors.length,
          errors: safeParseErrors(extracted.parseErrors),
        });
        return;
      }

      const classified = classifyDefinitionKinds(extracted.definitionKinds);
      node.kind = classified.kind;
      node.expandable = classified.expandable;
      node.status = "loaded";

      const parseErrors = safeParseErrors(extracted.parseErrors);
      parseLog?.info("CDS parsed", {
        event: extracted.parseErrors.length > 0 ? "parse.partial" : "parse.ok",
        sourceBytes,
        sourceHash,
        durationMs: parseDurationMs,
        definitionKinds: extracted.definitionKinds,
        dependencyCount: extracted.sources.length,
        parseErrorCount: extracted.parseErrors.length,
        ...(parseErrors.length > 0
          ? { firstError: parseErrors[0], errors: parseErrors }
          : {}),
      });

      if (parseDurationMs > slowParseMs) {
        parseLog?.warn("CDS parse exceeded the slow-operation threshold", {
          event: "perf.slow.parse",
          durationMs: parseDurationMs,
          thresholdMs: slowParseMs,
        });
      }

      // Non-fatal parse errors (e.g. projection-only named-argument syntax):
      // keep the dependencies extracted from the partial AST but surface the gap.
      if (extracted.parseErrors.length > 0) {
        const first = extracted.parseErrors[0];
        warnings.push(
          `${node.id}: parsed with ${extracted.parseErrors.length} error(s) ` +
            `(first at line ${first?.line}: ${first?.message}); ` +
            `FROM/JOIN dependencies extracted from the partial AST.`,
        );
      }

      // --- Expand dependencies (synchronous block — no awaits) -----------------
      const atMaxDepth = node.depth >= maxDepth;

      for (const dep of extracted.sources) {
        const depId = canonicalName(dep.name);
        if (depId.length === 0) continue;
        const relationship = dep.relationship ?? { kind: dep.role };

        // Self-reference is a (trivial) cycle. A declared self-association is a
        // legitimate relationship, so keep it without reporting a dependency cycle.
        if (depId === node.id) {
          addEdge(node.id, depId, relationship);
          if (!node.dependencies.includes(depId)) node.dependencies.push(depId);
          if (dep.role === "association") continue;
          const message = `Cycle detected: ${node.id} references itself.`;
          warnings.push(message);
          addDiagnostic({
            severity: "warning",
            category: "cycle",
            message,
            objectId: node.id,
            edgeId: edges[edges.length - 1]?.id,
          });
          log?.warn("Cycle detected", { event: "analysis.cycle", from: node.id, to: depId, depth: node.depth });
          continue;
        }

        // Enforce object-count limit before creating a new node.
        if (!nodes.has(depId) && nodes.size >= maxObjects) {
          truncated = true;
          limitReached = "max-objects";
          const message = `Maximum object count (${maxObjects}) reached; remaining dependencies after ${node.id} were not added.`;
          warnings.push(message);
          addDiagnostic({
            severity: "warning",
            category: "limit",
            message,
            objectId: node.id,
          });
          log?.warn("Maximum object count reached", {
            event: "analysis.limit.objects",
            object: node.id,
            maxObjects,
            nodeCount: nodes.size,
          });
          break;
        }

        const exists = nodes.has(depId);
        const child = ensureNode(depId, exists ? nodes.get(depId)!.depth : node.depth + 1);

        addEdge(node.id, depId, relationship);
        if (!node.dependencies.includes(depId)) node.dependencies.push(depId);

        if (!exists) {
          parent.set(depId, node.id);
        } else if (isAncestor(depId, node.id)) {
          const message = `Cycle detected: ${node.id} -> ${depId}.`;
          warnings.push(message);
          addDiagnostic({
            severity: "warning",
            category: "cycle",
            message,
            objectId: node.id,
            edgeId: edges[edges.length - 1]?.id,
          });
          log?.warn("Cycle detected", { event: "analysis.cycle", from: node.id, to: depId, depth: node.depth });
          continue; // do not re-read an ancestor
        } else {
          // Shared dependency (diamond): add the edge, do not refetch.
          continue;
        }

        if (atMaxDepth) {
          child.status = "not-expanded";
          child.errorCode = "max-depth";
          child.errorMessage = `Not expanded (maximum depth ${maxDepth} reached).`;
          child.expandable = false;
          log?.info("Dependency not expanded at maximum depth", {
            event: "analysis.limit.depth",
            object: depId,
            depth: child.depth,
            maxDepth,
          });
        } else {
          pending.push({ id: depId, name: dep.name, depth: node.depth + 1 });
        }
      }
    });

  // --- Bounded-concurrency work queue ---------------------------------------
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const task = pending[cursor++];
      if (!task) break;
      await processNode(task);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const notExpandedCount = [...nodes.values()].filter(
    (node) => node.status === "not-expanded",
  ).length;
  if (notExpandedCount > 0) {
    addDiagnostic({
      severity: "info",
      category: "limit",
      message: `${notExpandedCount} dependencies were not expanded at maximum depth ${maxDepth}.`,
      objectId: rootId,
    });
  }

  // --- Deterministic output --------------------------------------------------
  for (const node of nodes.values()) {
    node.dependencies = [...new Set(node.dependencies)];
  }
  const sortedNodes = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
  );
  const sortedEdges = edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id),
  );

  // A node contributes output columns when at least one incoming relationship is
  // used by the projection. Primary/set-operation edges are always considered
  // used; unused joins/associations remain visible but are marked as unused.
  for (const node of sortedNodes) {
    if (node.id === rootId) {
      node.usedInProjection = true;
      continue;
    }
    const incoming = sortedEdges.filter((edge) => edge.to === node.id);
    if (incoming.length === 0) continue;
    node.usedInProjection = incoming.some((edge) => edge.relationship?.usedInProjection !== false);
  }

  const graph = {
    rootId,
    maxDepth,
    nodes: sortedNodes,
    edges: sortedEdges,
    warnings,
    diagnostics,
  };

  const result: AnalyzeResult = { graph, truncated, limitReached };
  if (deps.cache) {
    result.cache = {
      mode: deps.cache.mode,
      systemKey: deps.cache.systemKey,
      hits: sortedNodes.filter((node) => node.cacheHit === true).length,
      misses: sortedNodes.filter((node) => node.cacheHit === false).length,
    };
  }
  return complete(result);
}

function applyResolutionFailure(node: DependencyNode, result: ObjectReadResult, warnings: string[]): void {
  node.kind = "unknown";
  node.expandable = false;
  node.status = "read-error";
  node.errorCode = "read-failed";

  switch (result.resolution) {
    case "not-found":
      node.errorCode = "object-not-found";
      break;
    case "cache-miss":
      node.errorCode = "cache-miss";
      break;
    case "ambiguous":
      node.errorCode = "ambiguous";
      break;
    case "unsupported-type":
      node.errorCode = "unsupported-type";
      break;
    case "search-failed":
      // Search failures stay distinct from typed-read failures.
      node.errorCode = "search-failed";
      break;
    case "read-failed":
      if (result.errorCode === "empty-source") {
        node.status = "empty-source";
        node.errorCode = "empty-source";
      } else if (result.errorCode === "invalid-name") {
        node.errorCode = "invalid-name";
      } else if (
        result.errorCode === "timeout" ||
        result.errorCode === "auth" ||
        result.errorCode === "connection"
      ) {
        node.errorCode = "adt-connection";
      } else {
        // A typed-reader 404/error is a read failure, not a classification hint.
        node.errorCode = "read-failed";
      }
      break;
    default:
      node.errorCode = "read-failed";
  }

  node.errorMessage = result.message ?? `Resolution failed: ${result.resolution}.`;
  warnings.push(`${node.id}: ${node.errorCode} — ${node.errorMessage}`);
}

function kindFromType(type: string, subtype?: string): SourceKind {
  const t = type.toUpperCase();
  const s = (subtype ?? "").toUpperCase();
  if (t === "DDLS") return "cds";
  if (t === "TABL") return s === "DS" ? "structure" : "table";
  if (t === "VIEW") return "view";
  return "unknown";
}

/** Collapse and cap untrusted diagnostic text before it reaches a log field. */
function preview(value: string | undefined, max = 1_000): string | undefined {
  if (value === undefined) return undefined;
  const clean = redactText(value).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function safeParseErrors(
  errors: ReadonlyArray<{ line: number; message: string }>,
): Array<{ line: number; message: string }> {
  return errors.slice(0, 10).map((error) => ({
    line: error.line,
    message: preview(error.message, 500) ?? "",
  }));
}

export type { SourceKind };
