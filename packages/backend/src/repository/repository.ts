import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CacheMode } from "@cds-visualiser/shared";
import { normalizeLogger, type Logger } from "../logging/logger.js";
import { decodeSource } from "../adt/decode.js";
import { EXTRACTOR_VERSION, PARSER_NAME, PARSER_VERSION } from "../parser/version.js";
import { writeFileAtomic, writeJsonAtomic } from "./atomic.js";
import { sha256 } from "./hash.js";
import { assertInside, objectKey, packageKey, sanitizeSegment } from "./paths.js";
import type {
  CachedObject,
  CachedObjectMetadata,
  DependenciesArtifact,
  FindObjectsFilter,
  PackageSummary,
  ParsedArtifact,
  RepositoryIndex,
  RepositoryIndexEntry,
  SaveObjectInput,
  SystemIdentity,
} from "./types.js";

export type RepositoryLogger = Partial<Logger>;

export interface RepositoryOptions {
  root: string;
  system: SystemIdentity;
  logger?: Partial<Logger>;
  now?: () => Date;
}

const SCHEMA_VERSION = 1;
const METADATA_FILE = "metadata.json";
const PARSED_FILE = "parsed.json";
const DEPENDENCIES_FILE = "dependencies.json";

/**
 * Ordinary-file cache of SAP objects plus a versioned JSON lookup index.
 *
 * Layout (under `<root>/sap/<systemKey>/`):
 *
 *   system.json
 *   index.json
 *   packages/<package>/objects/<object>/
 *     metadata.json
 *     parsed.json
 *     dependencies.json
 *     source.asddls | source.table | source.structure | source.view.xml
 *
 * - `metadata.json` is the per-object source of truth.
 * - `index.json` is only an optimisation; it is rebuilt from metadata when it
 *   is missing, malformed or refers to missing files.
 * - Source and metadata are written via temp-file + atomic rename.
 * - The original SAP spelling is preserved in metadata; directory names are
 *   sanitised, case-stable and Windows-safe.
 */
export class FileSystemRepository {
  private readonly root: string;
  private readonly system: SystemIdentity;
  private readonly logger: Logger;
  private readonly now: () => Date;

  private indexCache: RepositoryIndex | null = null;
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RepositoryOptions) {
    this.root = options.root;
    this.system = options.system;
    this.logger = normalizeLogger(options.logger);
    this.now = options.now ?? (() => new Date());
  }

  get systemKey(): string {
    return this.system.key;
  }

  /** Absolute system directory (`<root>/sap/<systemKey>`). */
  get systemDir(): string {
    return assertInside(this.root, join(this.root, "sap", sanitizeSegment(this.system.key)));
  }

  get indexFile(): string {
    return join(this.systemDir, "index.json");
  }

  get systemFile(): string {
    return join(this.systemDir, "system.json");
  }

  async initialize(): Promise<void> {
    await this.ensureSystemFile();
    await this.ensureIndex();
  }

  // --- Public cache API -----------------------------------------------------

  /** Load one cached object. Returns `null` on a miss or unreadable metadata. */
  async getObject(name: string): Promise<CachedObject | null> {
    const canonical = name.trim().toUpperCase();
    if (!canonical) return null;

    const index = await this.ensureIndex();
    const entry = index.objects.find((candidate) => candidate.canonicalName === canonical);
    if (!entry) {
      this.logger.debug("Cached object not found", {
        event: "cache.miss",
        object: canonical,
        systemKey: this.system.key,
      });
      return null;
    }

    const objectDir = this.objectDirFromIndexEntry(entry);
    const metadataPath = join(objectDir, METADATA_FILE);

    let metadata: CachedObjectMetadata;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8")) as CachedObjectMetadata;
    } catch (err) {
      this.logger.warn(
        `Cached metadata for ${canonical} is unreadable (${errorMessage(err)}); treating it as a cache miss. ` +
          `Run the repository index rebuild to recover the index.`,
        { event: "cache.unreadable", object: canonical, systemKey: this.system.key, err },
      );
      return null;
    }

    if (
      metadata.schemaVersion !== SCHEMA_VERSION ||
      metadata.object.canonicalName !== canonical ||
      metadata.system.key !== this.system.key
    ) {
      this.logger.warn(
        `Cached metadata for ${canonical} is inconsistent with this repository/system; treating it as a cache miss.`,
        { event: "cache.unreadable", object: canonical, systemKey: this.system.key, reason: "inconsistent-metadata" },
      );
      return null;
    }

    let source: string | undefined;
    const sourcePath = join(objectDir, metadata.source.artifact);
    if (existsSync(sourcePath)) {
      try {
        source = decodeSource(await readFile(sourcePath));
      } catch (err) {
        this.logger.warn(`Cached source for ${canonical} is unreadable (${errorMessage(err)}); using metadata only.`, {
          event: "cache.unreadable",
          object: canonical,
          systemKey: this.system.key,
          reason: "source",
          err,
        });
        source = undefined;
      }
    }

    const parsed = await this.readArtifact<ParsedArtifact>(objectDir, metadata.derived.parsed);
    const dependencies = await this.readArtifact<DependenciesArtifact>(objectDir, metadata.derived.dependencies);
    const stale = this.computeStale(metadata, source, parsed, dependencies);

    this.logger.debug("Cached object served", {
      event: "cache.hit",
      object: canonical,
      systemKey: this.system.key,
      stale,
      sourceBytes: metadata.source.bytes,
    });

    return { metadata, source, parsed, dependencies, cacheHit: true, stale };
  }

  /** Persist one successfully retrieved object and update the index. */
  async saveObject(input: SaveObjectInput): Promise<CachedObject> {
    if (!/^source\.[a-z0-9.]+$/i.test(input.sourceArtifact)) {
      throw new Error(`Invalid source artifact name: ${input.sourceArtifact}`);
    }

    const canonical = input.canonicalName.trim().toUpperCase();
    const objectDir = this.objectDirFor(input.packageName, canonical);
    const sourceHash = sha256(input.source);
    const retrievedAt = this.now().toISOString();
    const generatedAt = retrievedAt;

    const parsed = input.parsed ?? this.emptyParsed(input, canonical, sourceHash);
    const dependencies = input.dependencies ?? this.emptyDependencies(sourceHash);
    const sourceBytes = Buffer.byteLength(input.source, "utf8");

    const metadata: CachedObjectMetadata = {
      schemaVersion: SCHEMA_VERSION,
      system: { key: this.system.key, sid: this.system.sid, client: this.system.client },
      object: {
        name: input.name,
        canonicalName: canonical,
        type: input.objectType,
        subtype: input.objectSubtype,
        packageName: input.packageName,
        description: input.description,
        uri: input.uri,
        metadataOnly: input.metadataOnly,
      },
      source: {
        artifact: input.sourceArtifact,
        format: input.sourceFormat,
        encoding: "utf-8",
        sha256: sourceHash,
        bytes: sourceBytes,
      },
      retrieval: {
        retrievedAt,
        source: input.retrievalSource,
        cacheMode: input.cacheMode,
      },
      parser: {
        name: input.objectType.toUpperCase() === "DDLS" ? PARSER_NAME : "none",
        version: input.objectType.toUpperCase() === "DDLS" ? PARSER_VERSION : "0",
        extractorVersion: EXTRACTOR_VERSION,
      },
      classification: {
        confidence: input.candidates.length > 0 ? "confirmed" : "unknown",
        candidates: input.candidates,
      },
      derived: {
        parsed: PARSED_FILE,
        dependencies: DEPENDENCIES_FILE,
        generatedAt,
      },
    };

    await this.ensurePackageFile(input.packageName);
    await writeFileAtomic(join(objectDir, input.sourceArtifact), input.source);
    await writeJsonAtomic(join(objectDir, METADATA_FILE), metadata);
    await writeJsonAtomic(join(objectDir, PARSED_FILE), parsed);
    await writeJsonAtomic(join(objectDir, DEPENDENCIES_FILE), dependencies);

    await this.upsertIndexEntry(objectDir, metadata);

    this.logger.debug("Cached object saved", {
      event: "repo.object.saved",
      object: canonical,
      objectType: input.objectType,
      sourceBytes,
      sourceHash,
      systemKey: this.system.key,
    });

    return {
      metadata,
      source: input.source,
      parsed,
      dependencies,
      cacheHit: false,
      stale: false,
    };
  }

  /**
   * Regenerate `parsed.json` / `dependencies.json` from cached source without
   * contacting SAP. Used when the extractor/parser version changes.
   */
  async saveDerived(
    name: string,
    parsed: ParsedArtifact,
    dependencies: DependenciesArtifact,
  ): Promise<CachedObject> {
    const cached = await this.getObject(name);
    if (!cached) throw new Error(`Cannot save derived artifacts: ${name} is not cached.`);

    const objectDir = this.objectDirFor(cached.metadata.object.packageName, cached.metadata.object.canonicalName);
    const currentSourceHash =
      cached.source !== undefined ? sha256(cached.source) : cached.metadata.source.sha256;
    const currentSourceBytes =
      cached.source !== undefined
        ? Buffer.byteLength(cached.source, "utf8")
        : cached.metadata.source.bytes;
    const metadata: CachedObjectMetadata = {
      ...cached.metadata,
      source: {
        ...cached.metadata.source,
        sha256: currentSourceHash,
        bytes: currentSourceBytes,
      },
      parser: {
        name: PARSER_NAME,
        version: PARSER_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
      },
      derived: {
        ...cached.metadata.derived,
        generatedAt: this.now().toISOString(),
      },
    };

    await writeJsonAtomic(join(objectDir, METADATA_FILE), metadata);
    await writeJsonAtomic(join(objectDir, PARSED_FILE), parsed);
    await writeJsonAtomic(join(objectDir, DEPENDENCIES_FILE), dependencies);

    await this.upsertIndexEntry(objectDir, metadata);

    this.logger.info("Derived cache artifacts regenerated", {
      event: "repo.derived.regenerated",
      object: cached.metadata.object.canonicalName,
      systemKey: this.system.key,
      sourceHash: currentSourceHash,
    });

    return {
      metadata,
      source: cached.source,
      parsed,
      dependencies,
      cacheHit: true,
      stale: false,
    };
  }

  async findObjects(filter: FindObjectsFilter = {}): Promise<RepositoryIndexEntry[]> {
    const index = await this.ensureIndex();
    const name = filter.name?.trim().toUpperCase();
    const objectType = filter.objectType?.trim().toUpperCase();
    const packageName = filter.packageName?.trim().toUpperCase();

    return index.objects.filter((entry) => {
      if (name && !entry.canonicalName.includes(name)) return false;
      if (objectType && entry.objectType.toUpperCase() !== objectType) return false;
      if (packageName && (entry.packageName ?? "").toUpperCase() !== packageName) return false;
      return true;
    });
  }

  async listPackages(): Promise<PackageSummary[]> {
    const index = await this.ensureIndex();
    const counts = new Map<string, number>();
    for (const entry of index.objects) {
      const name = entry.packageName?.trim() || "_unassigned";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, objectCount]) => ({ name, objectCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Rebuild the JSON index from per-object metadata files. */
  async rebuildIndex(): Promise<RepositoryIndex> {
    return this.withIndexLock(() => this.scanAndWriteIndex());
  }

  /** Load the index, rebuilding it if missing/malformed/stale. */
  async ensureIndex(): Promise<RepositoryIndex> {
    if (this.indexCache) return this.indexCache;
    return this.withIndexLock(async () => {
      if (this.indexCache) return this.indexCache;
      const index = await this.loadOrRebuildIndex();
      // Keep the identity file present even if the caller skipped initialize().
      await this.ensureSystemFile();
      this.indexCache = index;
      return index;
    });
  }

  /** True when cached source exists but derived artifacts are not current. */
  isStale(record: CachedObject): boolean {
    return this.computeStale(record.metadata, record.source, record.parsed, record.dependencies);
  }

  // --- Internals ------------------------------------------------------------

  private objectDirFor(packageName: string | undefined, canonicalName: string): string {
    return assertInside(
      this.root,
      join(
        this.systemDir,
        "packages",
        packageKey(packageName),
        "objects",
        objectKey(canonicalName),
      ),
    );
  }

  private objectDirFromIndexEntry(entry: RepositoryIndexEntry): string {
    return assertInside(this.root, join(this.systemDir, entry.objectDir));
  }

  private async upsertIndexEntry(objectDir: string, metadata: CachedObjectMetadata): Promise<void> {
    await this.withIndexLock(async () => {
      const index = (await this.loadOrRebuildIndexUnlocked()) ?? this.emptyIndex();
      const entry = this.entryFor(objectDir, metadata);
      const objects = index.objects.filter((candidate) => candidate.canonicalName !== entry.canonicalName);
      objects.push(entry);
      objects.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

      const updated: RepositoryIndex = {
        ...index,
        generatedAt: this.now().toISOString(),
        objects,
      };
      await writeJsonAtomic(this.indexFile, updated);
      this.indexCache = updated;
    });
  }

  private entryFor(objectDir: string, metadata: CachedObjectMetadata): RepositoryIndexEntry {
    return {
      canonicalName: metadata.object.canonicalName,
      name: metadata.object.name,
      objectType: metadata.object.type,
      objectSubtype: metadata.object.subtype,
      packageName: metadata.object.packageName,
      metadataPath: toPosix(relative(this.systemDir, join(objectDir, METADATA_FILE))),
      objectDir: toPosix(relative(this.systemDir, objectDir)),
      sourceArtifact: metadata.source.artifact,
      sourceFormat: metadata.source.format,
      sourceHash: metadata.source.sha256,
      updatedAt: metadata.retrieval.retrievedAt,
      derivedAt: metadata.derived.generatedAt,
      metadataOnly: metadata.object.metadataOnly,
    };
  }

  private async loadOrRebuildIndex(): Promise<RepositoryIndex> {
    try {
      const raw = await readFile(this.indexFile, "utf8");
      const parsed = JSON.parse(raw) as RepositoryIndex;
      if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.system?.key !== this.system.key) {
        throw new Error("index schema or system key does not match");
      }
      if (!Array.isArray(parsed.objects)) throw new Error("index objects is not an array");

      const stale = await this.indexRefersToMissingFiles(parsed);
      if (stale) {
        this.logger.warn(
          `Repository index for ${this.system.key} refers to missing object files; rebuilding from metadata.`,
          { event: "repo.index.recovery", systemKey: this.system.key, reason: "missing-object-files" },
        );
        return this.scanAndWriteIndex();
      }
      this.logger.debug("Repository index loaded", {
        event: "repo.index.loaded",
        systemKey: this.system.key,
        objectCount: parsed.objects.length,
      });
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !(await this.hasAnyMetadata())) {
        const empty = this.emptyIndex();
        await writeJsonAtomic(this.indexFile, empty);
        return empty;
      }
      this.logger.warn(
        `Repository index for ${this.system.key} is ${code === "ENOENT" ? "missing" : "unreadable"} ` +
          `(${errorMessage(err)}); rebuilding from per-object metadata files.`,
        {
          event: "repo.index.recovery",
          systemKey: this.system.key,
          reason: code === "ENOENT" ? "missing-index" : "unreadable-index",
          err,
        },
      );
      return this.scanAndWriteIndex();
    }
  }

  private async loadOrRebuildIndexUnlocked(): Promise<RepositoryIndex | null> {
    // Reuse the in-memory copy when possible; the caller already holds the lock.
    if (this.indexCache) return this.indexCache;
    return this.loadOrRebuildIndex();
  }

  private async indexRefersToMissingFiles(index: RepositoryIndex): Promise<boolean> {
    for (const entry of index.objects) {
      const metadataPath = join(this.systemDir, entry.metadataPath);
      try {
        await stat(metadataPath);
      } catch {
        return true;
      }
    }
    return false;
  }

  private async hasAnyMetadata(): Promise<boolean> {
    const packagesDir = join(this.systemDir, "packages");
    if (!existsSync(packagesDir)) return false;
    try {
      const packages = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of packages) {
        if (!pkg.isDirectory()) continue;
        const objectsDir = join(packagesDir, pkg.name, "objects");
        if (!existsSync(objectsDir)) continue;
        const objects = await readdir(objectsDir, { withFileTypes: true });
        for (const object of objects) {
          if (object.isDirectory() && existsSync(join(objectsDir, object.name, METADATA_FILE))) return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private async scanAndWriteIndex(): Promise<RepositoryIndex> {
    const objects: RepositoryIndexEntry[] = [];
    const packagesDir = join(this.systemDir, "packages");

    if (existsSync(packagesDir)) {
      const packages = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of packages) {
        if (!pkg.isDirectory()) continue;
        const objectsDir = join(packagesDir, pkg.name, "objects");
        if (!existsSync(objectsDir)) continue;

        const objectEntries = await readdir(objectsDir, { withFileTypes: true });
        for (const objectEntry of objectEntries) {
          if (!objectEntry.isDirectory()) continue;
          const objectDir = join(objectsDir, objectEntry.name);
          const metadataPath = join(objectDir, METADATA_FILE);
          try {
            const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as CachedObjectMetadata;
            if (metadata.schemaVersion !== SCHEMA_VERSION) {
              this.logger.warn(`Skipping ${metadataPath}: unsupported schema version.`, {
                event: "repo.index.skip",
                reason: "schema-version",
                metadataPath,
              });
              continue;
            }
            if (metadata.system.key !== this.system.key) {
              this.logger.warn(`Skipping ${metadataPath}: belongs to system ${metadata.system.key}.`, {
                event: "repo.index.skip",
                reason: "system-mismatch",
                metadataPath,
                objectSystemKey: metadata.system.key,
              });
              continue;
            }
            objects.push(this.entryFor(objectDir, metadata));
          } catch (err) {
            this.logger.warn(`Skipping unreadable cached metadata ${metadataPath}: ${errorMessage(err)}`, {
              event: "repo.index.skip",
              reason: "unreadable-metadata",
              metadataPath,
              err,
            });
          }
        }
      }
    }

    objects.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
    const index: RepositoryIndex = {
      schemaVersion: SCHEMA_VERSION,
      system: { key: this.system.key, sid: this.system.sid, client: this.system.client },
      generatedAt: this.now().toISOString(),
      objects,
    };
    await writeJsonAtomic(this.indexFile, index);
    await this.ensureSystemFile();
    this.indexCache = index;
    this.logger.debug("Repository index rebuilt", {
      event: "repo.index.rebuilt",
      systemKey: this.system.key,
      objectCount: objects.length,
    });
    return index;
  }

  private emptyIndex(): RepositoryIndex {
    return {
      schemaVersion: SCHEMA_VERSION,
      system: { key: this.system.key, sid: this.system.sid, client: this.system.client },
      generatedAt: this.now().toISOString(),
      objects: [],
    };
  }

  private async ensureSystemFile(): Promise<void> {
    if (existsSync(this.systemFile)) return;
    await writeJsonAtomic(this.systemFile, {
      schemaVersion: SCHEMA_VERSION,
      system: { key: this.system.key, sid: this.system.sid, client: this.system.client },
      updatedAt: this.now().toISOString(),
    });
  }

  private async ensurePackageFile(packageName?: string): Promise<void> {
    const dir = join(this.systemDir, "packages", packageKey(packageName));
    const file = join(dir, "package.json");
    if (existsSync(file)) return;
    await writeJsonAtomic(file, {
      schemaVersion: SCHEMA_VERSION,
      name: packageName?.trim() || "_unassigned",
      systemKey: this.system.key,
      updatedAt: this.now().toISOString(),
    });
  }

  private async readArtifact<T>(objectDir: string, filename: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(objectDir, filename), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private computeStale(
    metadata: CachedObjectMetadata,
    source: string | undefined,
    parsed: ParsedArtifact | undefined,
    dependencies: DependenciesArtifact | undefined,
  ): boolean {
    if (metadata.object.type.toUpperCase() === "DDLS") {
      if (metadata.parser.extractorVersion !== EXTRACTOR_VERSION) return true;
      if (metadata.parser.version !== PARSER_VERSION) return true;
      if (!parsed || !dependencies) return true;
    }
    if (source !== undefined && sha256(source) !== metadata.source.sha256) return true;
    if (!source && metadata.source.bytes > 0 && !metadata.object.metadataOnly) return true;
    return false;
  }

  private emptyParsed(input: SaveObjectInput, canonical: string, sourceHash: string): ParsedArtifact {
    return {
      schemaVersion: SCHEMA_VERSION,
      object: { name: canonical, type: input.objectType },
      sourceHash,
      parser: { name: "none", version: "0", extractorVersion: EXTRACTOR_VERSION },
      definitionKinds: [],
      sources: [],
      parseErrors: [],
      note: input.metadataOnly
        ? "Metadata-only object; no parseable source is available."
        : "Not parsed (non-CDS artifact).",
    };
  }

  private emptyDependencies(sourceHash: string): DependenciesArtifact {
    return {
      schemaVersion: SCHEMA_VERSION,
      sourceHash,
      extractorVersion: EXTRACTOR_VERSION,
      dependencies: [],
    };
  }

  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.indexQueue.then(fn, fn);
    this.indexQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
