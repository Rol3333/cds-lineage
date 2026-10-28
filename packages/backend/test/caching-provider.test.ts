import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyze } from "../src/collector/collector.js";
import { validateObjectName } from "../src/adt/validate.js";
import type { ObjectProvider, ObjectReadResult } from "../src/adt/types.js";
import { CachingObjectProvider } from "../src/repository/caching-provider.js";
import { FileSystemRepository } from "../src/repository/repository.js";
import type { SaveObjectInput } from "../src/repository/types.js";

const roots: string[] = [];

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "cds-visualiser-cache-"));
  roots.push(root);
  const repo = new FileSystemRepository({
    root,
    system: { key: "DS4-100", sid: "DS4", client: "100" },
    logger: { warn: () => {} },
  });
  await repo.initialize();
  return repo;
}

function saveInput(overrides: Partial<SaveObjectInput> = {}): SaveObjectInput {
  const name = overrides.name ?? "ZTEST";
  const canonical = overrides.canonicalName ?? name.toUpperCase();
  return {
    name,
    canonicalName: canonical,
    objectType: "DDLS",
    objectSubtype: "DF",
    packageName: "SZD",
    metadataOnly: false,
    source: "define view entity ZTEST as select from CDPOS { key mandt }",
    sourceArtifact: "source.asddls",
    sourceFormat: "asddls",
    retrievalSource: "adt-ddl-read",
    cacheMode: "cache-first",
    candidates: [{ name, objectType: "DDLS", objectSubtype: "DF", packageName: "SZD" }],
    ...overrides,
  };
}

async function seed(repo: FileSystemRepository, overrides: Partial<SaveObjectInput> = {}): Promise<void> {
  await repo.saveObject(saveInput(overrides));
}

function resolvedDdls(name: string, source: string, extra: Partial<ObjectReadResult> = {}): ObjectReadResult {
  const canonical = name.toUpperCase();
  return {
    resolution: "resolved",
    name,
    canonicalName: canonical,
    objectType: "DDLS",
    objectSubtype: "DF",
    packageName: "SZD",
    source,
    sourceFormat: "asddls",
    candidates: [{ name, objectType: "DDLS", objectSubtype: "DF", packageName: "SZD" }],
    ...extra,
  };
}

function fakeUpstream(handler: (name: string) => ObjectReadResult | Promise<ObjectReadResult>) {
  const calls: string[] = [];
  const upstream: ObjectProvider = {
    resolve: vi.fn(async (name: string) => {
      calls.push(name);
      return handler(name);
    }),
  };
  return { upstream, calls };
}

async function ageMetadata(repo: FileSystemRepository, name: string): Promise<void> {
  const entry = (await repo.findObjects({ name }))[0]!;
  const path = join(repo.systemDir, entry.metadataPath);
  const metadata = JSON.parse(await readFile(path, "utf8")) as {
    parser: { version: string; extractorVersion: string };
  };
  metadata.parser.version = "0.0.0-old";
  metadata.parser.extractorVersion = "0";
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("CachingObjectProvider", () => {
  it("serves a valid cache hit without contacting SAP", async () => {
    const repo = await makeRepo();
    const source = "define view entity ZTEST as select from CDPOS { key mandt }";
    await seed(repo, { source });

    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-first" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.cacheHit).toBe(true);
    expect(result.source).toBe(source);
    expect(result.objectType).toBe("DDLS");
    expect(calls).toHaveLength(0);
  });

  it("fetches on a cache miss and persists the result", async () => {
    const repo = await makeRepo();
    const source = "define view entity ZTEST as select from CDPOS { key mandt }";
    const { upstream, calls } = fakeUpstream(() => resolvedDdls("ZTEST", source));
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-first" });

    const first = await provider.resolve("ZTEST");
    expect(first.cacheHit).toBe(false);
    expect(first.source).toBe(source);

    const second = await provider.resolve("ZTEST");
    expect(second.cacheHit).toBe(true);
    expect(calls).toEqual(["ZTEST"]);

    const cached = await repo.getObject("ZTEST");
    expect(cached?.source).toBe(source);
    expect(cached?.metadata.retrieval.source).toBe("adt-ddl-read");
    expect(cached?.parsed?.definitionKinds.length).toBeGreaterThan(0);
    expect(cached?.dependencies?.dependencies.map((d) => d.name)).toContain("CDPOS");
  });

  it("reports cache-miss in cache-only mode without contacting SAP", async () => {
    const repo = await makeRepo();
    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-only" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("cache-miss");
    expect(result.message).toContain("cache-only");
    expect(calls).toHaveLength(0);
  });

  it("serves cache-only hits without contacting SAP", async () => {
    const repo = await makeRepo();
    await seed(repo);
    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-only" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.cacheHit).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refresh overwrites a valid cache entry", async () => {
    const repo = await makeRepo();
    await seed(repo, { source: "define view entity ZTEST as select from OLD { key x }" });

    const newSource = "define view entity ZTEST as select from NEW { key x }";
    const { upstream, calls } = fakeUpstream(() => resolvedDdls("ZTEST", newSource));
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "refresh" });

    const result = await provider.resolve("ZTEST");
    expect(result.cacheHit).toBe(false);
    expect(result.source).toBe(newSource);
    expect(calls).toEqual(["ZTEST"]);
    expect((await repo.getObject("ZTEST"))?.source).toBe(newSource);
  });

  it("preserves the previous cache when a refresh fails", async () => {
    const repo = await makeRepo();
    const oldSource = "define view entity ZTEST as select from OLD { key x }";
    await seed(repo, { source: oldSource });

    const { upstream } = fakeUpstream(() => ({
      resolution: "not-found",
      name: "ZTEST",
      canonicalName: "ZTEST",
      message: "SAP is unavailable",
    }));
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "refresh" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.cacheHit).toBe(true);
    expect(result.refreshFailed).toBe(true);
    expect(result.source).toBe(oldSource);
    expect(result.message).toContain("previously cached");
    expect((await repo.getObject("ZTEST"))?.source).toBe(oldSource);
  });

  it("regenerates stale derived artifacts from cached source without SAP", async () => {
    const repo = await makeRepo();
    const source = "define view entity ZTEST as select from CDPOS { key mandt }";
    await seed(repo, { source });
    await ageMetadata(repo, "ZTEST");
    expect((await repo.getObject("ZTEST"))?.stale).toBe(true);

    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-first" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.stale).toBe(false);
    expect(result.source).toBe(source);
    expect(calls).toHaveLength(0);
    expect((await repo.getObject("ZTEST"))?.stale).toBe(false);
  });

  it("resolves a whole cached branch in cache-only mode", async () => {
    const repo = await makeRepo();
    await seed(repo, { name: "A", source: "define view entity A as select from B { key x }" });
    await seed(repo, { name: "B", source: "define view entity B as select from C { key x }" });
    await seed(repo, { name: "C", source: "define view entity C as select from CDPOS { key mandt }" });
    await seed(repo, {
      name: "CDPOS",
      objectType: "TABL",
      objectSubtype: "DT",
      source: "define table cdpos { mandt : mandt; }",
      sourceArtifact: "source.table",
      sourceFormat: "table",
      retrievalSource: "adt-table-read",
      candidates: [{ name: "CDPOS", objectType: "TABL", objectSubtype: "DT", packageName: "SZD" }],
    });

    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-only" });
    const result = await analyze("A", {
      provider,
      options: { maxDepth: 4, maxObjects: 100, concurrency: 2 },
      validate: validateObjectName,
      cache: { mode: "cache-only", systemKey: "DS4-100" },
    });

    expect(calls).toHaveLength(0);
    expect(result.graph.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C", "CDPOS"]);
    expect(result.graph.nodes.find((n) => n.id === "CDPOS")?.kind).toBe("table");
    expect(result.graph.nodes.every((n) => n.status === "loaded")).toBe(true);
    expect(result.cache?.hits).toBe(4);
    expect(result.cache?.misses).toBe(0);
  });

  it("keeps independent branches when one cache-only dependency is missing", async () => {
    const repo = await makeRepo();
    await seed(repo, {
      name: "A",
      source: "define view entity A as select from B left outer join MISSING on B.x = MISSING.x { key B.x }",
    });
    await seed(repo, { name: "B", source: "define view entity B as select from CDPOS { key mandt }" });
    await seed(repo, {
      name: "CDPOS",
      objectType: "TABL",
      objectSubtype: "DT",
      source: "define table cdpos { mandt : mandt; }",
      sourceArtifact: "source.table",
      sourceFormat: "table",
      retrievalSource: "adt-table-read",
      candidates: [{ name: "CDPOS", objectType: "TABL", objectSubtype: "DT", packageName: "SZD" }],
    });

    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-only" });
    const result = await analyze("A", {
      provider,
      options: { maxDepth: 4, maxObjects: 100, concurrency: 2 },
      validate: validateObjectName,
      cache: { mode: "cache-only", systemKey: "DS4-100" },
    });

    expect(calls).toHaveLength(0);
    expect(result.graph.nodes.find((n) => n.id === "B")?.status).toBe("loaded");
    const missing = result.graph.nodes.find((n) => n.id === "MISSING");
    expect(missing?.status).toBe("read-error");
    expect(missing?.errorCode).toBe("cache-miss");
    expect(result.graph.warnings.some((w) => w.includes("cache-miss"))).toBe(true);
  });

  it("refetches a cached object whose source artifact is missing", async () => {
    const repo = await makeRepo();
    await seed(repo, { source: "define view entity ZTEST as select from OLD { key x }" });
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    await rm(join(repo.systemDir, entry.objectDir, entry.sourceArtifact), { force: true });

    const newSource = "define view entity ZTEST as select from NEW { key x }";
    const { upstream, calls } = fakeUpstream(() => resolvedDdls("ZTEST", newSource));
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-first" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.cacheHit).toBe(false);
    expect(result.source).toBe(newSource);
    expect(calls).toEqual(["ZTEST"]);
  });

  it("reports cache-miss for a missing source in cache-only mode", async () => {
    const repo = await makeRepo();
    await seed(repo);
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    await rm(join(repo.systemDir, entry.objectDir, entry.sourceArtifact), { force: true });

    const { upstream, calls } = fakeUpstream(() => {
      throw new Error("upstream must not be called");
    });
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-only" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("cache-miss");
    expect(result.message).toContain("missing");
    expect(calls).toHaveLength(0);
  });

  it("returns the upstream failure when refresh has no previous cache", async () => {
    const repo = await makeRepo();
    const { upstream } = fakeUpstream(() => ({
      resolution: "not-found",
      name: "ZTEST",
      canonicalName: "ZTEST",
      message: "missing",
    }));
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "refresh" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("not-found");
    expect(result.refreshFailed).toBeUndefined();
  });

  it("still returns a fetched object if persisting it fails", async () => {
    const repo = await makeRepo();
    const saveSpy = vi.spyOn(repo, "saveObject").mockRejectedValue(new Error("disk full"));
    const { upstream } = fakeUpstream(() =>
      resolvedDdls("ZTEST", "define view entity ZTEST as select from CDPOS { key mandt }"),
    );
    const provider = new CachingObjectProvider({ repository: repo, upstream, mode: "cache-first" });

    const result = await provider.resolve("ZTEST");
    expect(result.resolution).toBe("resolved");
    expect(result.source).toContain("define view entity ZTEST");
    expect(result.message).toContain("not cached");
    saveSpy.mockRestore();
  });
});
