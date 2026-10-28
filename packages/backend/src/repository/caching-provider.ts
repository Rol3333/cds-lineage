import type { CacheMode, SourceFormat } from "@cds-visualiser/shared";
import type { ObjectProvider, ObjectReadResult } from "../adt/types.js";
import { normalizeLogger, redactText, type Logger } from "../logging/logger.js";
import { extractSources } from "../parser/extract-sources.js";
import { EXTRACTOR_VERSION, PARSER_NAME, PARSER_VERSION } from "../parser/version.js";
import { sha256 } from "./hash.js";
import type { FileSystemRepository } from "./repository.js";
import type {
  CachedObject,
  DependenciesArtifact,
  ParsedArtifact,
} from "./types.js";

export interface CachingProviderOptions {
  repository: FileSystemRepository;
  upstream: ObjectProvider;
  mode: CacheMode;
  logger?: Partial<Logger>;
}

/**
 * Cache-aware object provider.
 *
 * - `cache-first` — serve a valid cached copy; on a miss (or unusable cache)
 *   contact SAP and persist the result. Stale derived artifacts are regenerated
 *   from cached source without a SAP round-trip.
 * - `cache-only`  — never contact SAP. A miss is reported as `cache-miss` and
 *   preserved as an unresolved node by the collector.
 * - `refresh`     — always contact SAP. If the refresh fails, a previously
 *   valid cached copy is served instead of losing the graph branch.
 */
export class CachingObjectProvider implements ObjectProvider {
  private readonly repository: FileSystemRepository;
  private readonly upstream: ObjectProvider;
  private readonly mode: CacheMode;
  private readonly logger: Logger;

  constructor(options: CachingProviderOptions) {
    this.repository = options.repository;
    this.upstream = options.upstream;
    this.mode = options.mode;
    this.logger = normalizeLogger(options.logger);
  }

  async resolve(name: string): Promise<ObjectReadResult> {
    const requested = name.trim();
    const canonical = requested.toUpperCase();

    const cached = await this.repository.getObject(requested);

    if (this.mode !== "refresh" && cached) {
      const missingSource =
        !cached.source &&
        !cached.metadata.object.metadataOnly &&
        cached.metadata.source.bytes > 0;

      if (!missingSource) {
        if (cached.stale && cached.source && cached.metadata.object.type.toUpperCase() === "DDLS") {
          try {
            const regenerated = await this.regenerate(cached);
            return this.toResult(regenerated, true);
          } catch (err) {
            this.logger.warn(
              `Could not regenerate derived artifacts for cached ${cached.metadata.object.canonicalName}: ${errorMessage(err)}`,
              {
                event: "cache.regeneration.failed",
                object: cached.metadata.object.canonicalName,
                systemKey: this.repository.systemKey,
                err,
              },
            );
            return { ...this.toResult(cached, true), stale: true };
          }
        }
        this.logger.debug("Serving cached object", {
          event: "cache.served",
          object: cached.metadata.object.canonicalName,
          systemKey: this.repository.systemKey,
          cacheMode: this.mode,
          stale: cached.stale,
          sourceBytes: cached.metadata.source.bytes,
        });
        return this.toResult(cached, true);
      }

      if (this.mode === "cache-only") {
        this.logger.info("Cached source is missing; cache-only mode will not contact SAP", {
          event: "cache.miss",
          object: canonical,
          systemKey: this.repository.systemKey,
          cacheMode: this.mode,
          reason: "missing-source",
        });
        return {
          resolution: "cache-miss",
          name: requested,
          canonicalName: canonical,
          message:
            `Cached source for ${requested} is missing for system ${this.repository.systemKey}; ` +
            `cache-only mode does not contact SAP.`,
        };
      }
      // cache-first: fall through and refetch the missing source.
    }

    if (this.mode === "cache-only") {
      if (cached) {
        this.logger.debug("Serving cached object without source", {
          event: "cache.served",
          object: cached.metadata.object.canonicalName,
          systemKey: this.repository.systemKey,
          cacheMode: this.mode,
          stale: cached.stale,
        });
        return this.toResult(cached, true);
      }
      this.logger.info("Object is not cached; cache-only mode will not contact SAP", {
        event: "cache.miss",
        object: canonical,
        systemKey: this.repository.systemKey,
        cacheMode: this.mode,
        reason: "no-cached-object",
      });
      return {
        resolution: "cache-miss",
        name: requested,
        canonicalName: canonical,
        message:
          `No cached copy of ${requested} exists for system ${this.repository.systemKey}; ` +
          `cache-only mode does not contact SAP.`,
      };
    }

    const upstream = await this.upstream.resolve(requested);
    if (upstream.resolution === "resolved") {
      try {
        await this.persist(upstream);
      } catch (err) {
        this.logger.warn(
          `Object ${upstream.canonicalName} was retrieved but could not be written to the cache: ${errorMessage(err)}`,
          {
            event: "cache.persist.failed",
            object: upstream.canonicalName,
            systemKey: this.repository.systemKey,
            cacheMode: this.mode,
            err,
          },
        );
        return {
          ...upstream,
          cacheHit: false,
          stale: false,
          message: `Object retrieved but not cached: ${errorMessage(err)}`,
        };
      }
      this.logger.debug("Object retrieved from SAP and cached", {
        event: "cache.populated",
        object: upstream.canonicalName,
        objectType: upstream.objectType,
        systemKey: this.repository.systemKey,
        cacheMode: this.mode,
      });
      return { ...upstream, cacheHit: false, stale: false };
    }

    if (this.mode === "refresh" && cached) {
      this.logger.warn("Refresh failed; serving the previously cached copy", {
        event: "cache.refresh.fallback",
        object: cached.metadata.object.canonicalName,
        systemKey: this.repository.systemKey,
        cacheMode: this.mode,
        upstreamResolution: upstream.resolution,
        upstreamErrorCode: upstream.errorCode,
        message: preview(upstream.message),
      });
      return {
        ...this.toResult(cached, true),
        refreshFailed: true,
        message:
          `Refresh failed (${upstream.resolution}). Serving the previously cached copy.` +
          (upstream.message ? ` ${upstream.message}` : ""),
      };
    }

    return upstream;
  }

  private async persist(result: ObjectReadResult): Promise<CachedObject> {
    const source = result.source ?? "";
    const sourceHash = sha256(source);
    const { artifact, format } = resolveArtifact(result);

    let parsed: ParsedArtifact | undefined;
    let dependencies: DependenciesArtifact | undefined;

    if ((result.objectType ?? "").toUpperCase() === "DDLS") {
      const extracted = extractSources(source);
      parsed = {
        schemaVersion: 1,
        object: { name: result.canonicalName, type: "DDLS" },
        sourceHash,
        parser: { name: PARSER_NAME, version: PARSER_VERSION, extractorVersion: EXTRACTOR_VERSION },
        definitionKinds: extracted.definitionKinds,
        sources: extracted.sources,
        columns: extracted.columns,
        associations: extracted.associations,
        parseErrors: extracted.parseErrors,
      };
      dependencies = this.dependenciesFrom(extracted.sources, sourceHash);
    }

    return this.repository.saveObject({
      name: result.name,
      canonicalName: result.canonicalName,
      objectType: result.objectType ?? "UNKNOWN",
      objectSubtype: result.objectSubtype,
      packageName: result.packageName,
      description: result.description,
      uri: result.uri,
      metadataOnly: result.metadataOnly ?? false,
      source,
      sourceArtifact: artifact,
      sourceFormat: format,
      retrievalSource: retrievalSourceFor(format),
      cacheMode: this.mode,
      candidates: result.candidates ?? [],
      parsed,
      dependencies,
    });
  }

  private async regenerate(cached: CachedObject): Promise<CachedObject> {
    if (!cached.source) return cached;
    const extracted = extractSources(cached.source);
    const sourceHash = sha256(cached.source);
    const parsed: ParsedArtifact = {
      schemaVersion: 1,
      object: { name: cached.metadata.object.canonicalName, type: "DDLS" },
      sourceHash,
      parser: { name: PARSER_NAME, version: PARSER_VERSION, extractorVersion: EXTRACTOR_VERSION },
      definitionKinds: extracted.definitionKinds,
      sources: extracted.sources,
      columns: extracted.columns,
      associations: extracted.associations,
      parseErrors: extracted.parseErrors,
    };
    const dependencies = this.dependenciesFrom(extracted.sources, sourceHash);
    return this.repository.saveDerived(cached.metadata.object.canonicalName, parsed, dependencies);
  }

  private dependenciesFrom(
    sources: Array<{
      name: string;
      role: string;
      joinType?: string;
      alias?: string;
      relationship?: { usedInProjection?: boolean };
    }>,
    sourceHash: string,
  ): DependenciesArtifact {
    return {
      schemaVersion: 1,
      sourceHash,
      extractorVersion: EXTRACTOR_VERSION,
      dependencies: sources.map((source) => ({
        name: source.name,
        canonicalName: source.name.toUpperCase(),
        role: source.role,
        joinType: source.joinType,
        alias: source.alias,
        usedInProjection: source.relationship?.usedInProjection,
        // Types are confirmed later by the resolver; the graph carries them.
        objectType: null,
        resolution: "unknown" as const,
      })),
    };
  }

  private toResult(cached: CachedObject, cacheHit: boolean): ObjectReadResult {
    return {
      resolution: "resolved",
      name: cached.metadata.object.name,
      canonicalName: cached.metadata.object.canonicalName,
      objectType: cached.metadata.object.type,
      objectSubtype: cached.metadata.object.subtype,
      packageName: cached.metadata.object.packageName,
      description: cached.metadata.object.description,
      uri: cached.metadata.object.uri,
      source: cached.source,
      sourceFormat: cached.metadata.source.format,
      metadataOnly: cached.metadata.object.metadataOnly,
      candidates: cached.metadata.classification.candidates,
      cacheHit,
      stale: cached.stale,
    };
  }
}

function resolveArtifact(result: ObjectReadResult): { artifact: string; format: SourceFormat } {
  const format =
    result.sourceFormat ??
    ((result.objectType ?? "").toUpperCase() === "DDLS"
      ? "asddls"
      : (result.objectSubtype ?? "").toUpperCase() === "DS"
        ? "structure"
        : (result.objectType ?? "").toUpperCase() === "VIEW"
          ? "view-metadata"
          : "table");

  switch (format) {
    case "asddls":
      return { artifact: "source.asddls", format };
    case "table":
      return { artifact: "source.table", format };
    case "structure":
      return { artifact: "source.structure", format };
    case "view-metadata":
      return { artifact: "source.view.xml", format };
  }
}

function retrievalSourceFor(format: SourceFormat): string {
  switch (format) {
    case "asddls":
      return "adt-ddl-read";
    case "table":
      return "adt-table-read";
    case "structure":
      return "adt-structure-read";
    case "view-metadata":
      return "adt-fetch-view-metadata";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Collapse and cap untrusted diagnostic text before it reaches a log field. */
function preview(value: string | undefined, max = 1_000): string | undefined {
  if (value === undefined) return undefined;
  const clean = redactText(value).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
