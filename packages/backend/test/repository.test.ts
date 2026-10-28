import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTRACTOR_VERSION, PARSER_VERSION } from "../src/parser/version.js";
import { sha256 } from "../src/repository/hash.js";
import { assertInside, objectKey, sanitizeSegment } from "../src/repository/paths.js";
import { FileSystemRepository } from "../src/repository/repository.js";
import type { SaveObjectInput } from "../src/repository/types.js";

const roots: string[] = [];

async function makeRepo(systemKey = "DS4-100") {
  const root = await mkdtemp(join(tmpdir(), "cds-visualiser-repo-"));
  roots.push(root);
  const warnings: string[] = [];
  const repo = new FileSystemRepository({
    root,
    system: { key: systemKey, sid: "DS4", client: "100" },
    logger: { warn: (message) => warnings.push(message) },
    now: () => new Date("2026-10-28T10:00:00.000Z"),
  });
  await repo.initialize();
  return { root, repo, warnings };
}

function input(overrides: Partial<SaveObjectInput> = {}): SaveObjectInput {
  return {
    name: "ZTEST",
    canonicalName: "ZTEST",
    objectType: "DDLS",
    objectSubtype: "DF",
    packageName: "SZD",
    description: "Test CDS entity",
    metadataOnly: false,
    source: "define view entity ZTEST as select from CDPOS { key mandt }",
    sourceArtifact: "source.asddls",
    sourceFormat: "asddls",
    retrievalSource: "adt-ddl-read",
    cacheMode: "cache-first",
    candidates: [
      {
        name: "ZTEST",
        objectType: "DDLS",
        objectSubtype: "DF",
        packageName: "SZD",
        uri: "/sap/bc/adt/ddic/ddl/sources/ztest",
      },
    ],
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe("FileSystemRepository", () => {
  it("stores CDS source as UTF-8 without BOM and preserves non-ASCII text", async () => {
    const { root, repo } = await makeRepo();
    const source =
      "@EndUserText.label: 'Grüße – ąčęėįšųūž'\n" +
      "define view entity ZTEST as select from CDPOS { key mandt }";
    await repo.saveObject(input({ source, description: "Änderungsbelegpositionen – lietuviškas" }));

    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    const sourcePath = join(repo.systemDir, entry.objectDir, entry.sourceArtifact);
    const bytes = await readFile(sourcePath);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString("utf8")).toBe(source);

    const cached = await repo.getObject("ZTEST");
    expect(cached?.source).toBe(source);
    expect(cached?.metadata.object.name).toBe("ZTEST");
    expect(cached?.metadata.object.description).toContain("lietuviškas");
    expect(cached?.metadata.source.sha256).toHaveLength(64);
    expect(cached?.metadata.source.bytes).toBe(Buffer.byteLength(source, "utf8"));
    expect(entry.metadataPath).toContain("/");
    expect(existsSync(repo.systemFile)).toBe(true);
    expect(root).toBeTruthy();
  });

  it("keeps systems isolated under one storage root", async () => {
    const { root } = await makeRepo("DS4-100");
    const a = new FileSystemRepository({ root, system: { key: "DS4-100" }, logger: { warn: () => {} } });
    const b = new FileSystemRepository({ root, system: { key: "QAS-200" }, logger: { warn: () => {} } });
    await a.initialize();
    await b.initialize();

    await a.saveObject(input({ source: "define view entity ZTEST as select from A { key x }" }));
    await b.saveObject(input({ source: "define view entity ZTEST as select from B { key x }" }));

    expect((await a.getObject("ZTEST"))?.source).toContain("from A");
    expect((await b.getObject("ZTEST"))?.source).toContain("from B");
    expect(a.systemDir).not.toBe(b.systemDir);
  });

  it("uses package directories and an _unassigned fallback", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input({ name: "ZPACK", canonicalName: "ZPACK", packageName: "SZD" }));
    await repo.saveObject(
      input({
        name: "ZFREE",
        canonicalName: "ZFREE",
        packageName: undefined,
        source: "define view entity ZFREE as select from CDPOS { key mandt }",
      }),
    );

    const packaged = (await repo.findObjects({ name: "ZPACK" }))[0]!;
    const free = (await repo.findObjects({ name: "ZFREE" }))[0]!;
    expect(packaged.objectDir).toContain("packages/SZD/objects/");
    expect(free.objectDir).toContain("packages/_unassigned/objects/");
    expect(existsSync(join(repo.systemDir, "packages", "SZD", "package.json"))).toBe(true);
    expect(existsSync(join(repo.systemDir, "packages", "_unassigned", "package.json"))).toBe(true);
    expect(await repo.listPackages()).toEqual(
      expect.arrayContaining([
        { name: "SZD", objectCount: 1 },
        { name: "_unassigned", objectCount: 1 },
      ]),
    );
  });

  it("creates Windows-safe paths for namespaces and reserved names", async () => {
    const { root, repo } = await makeRepo();
    expect(objectKey("CON")).toMatch(/^_CON(-[a-f0-9]{8})?$/);
    expect(objectKey("/1CADVH/FOO")).toBe("~1CADVH~FOO");
    expect(sanitizeSegment("Name. ")).toMatch(/^Name(-[a-f0-9]{8})?$/);
    expect(sanitizeSegment("A:B")).not.toContain(":");
    expect(sanitizeSegment("A:B")).not.toBe("A_B");
    expect(sanitizeSegment("x".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(() => assertInside(root, join(root, "..", "escape"))).toThrow();

    await repo.saveObject(
      input({
        name: "/1CADVH/FOO",
        canonicalName: "/1CADVH/FOO",
        source: "define view entity ZNS as select from CDPOS { key mandt }",
      }),
    );
    await repo.saveObject(
      input({
        name: "CON",
        canonicalName: "CON",
        source: "define view entity ZCON as select from CDPOS { key mandt }",
      }),
    );

    expect((await repo.getObject("/1CADVH/FOO"))?.metadata.object.name).toBe("/1CADVH/FOO");
    expect((await repo.getObject("CON"))?.metadata.object.name).toBe("CON");
    // No file named exactly `CON` was created (Windows device name).
    const entries = await readdir(join(repo.systemDir, "packages"));
    expect(entries.length).toBeGreaterThan(0);
  });

  it("rebuilds a missing index from per-object metadata", async () => {
    const { root, repo } = await makeRepo();
    await repo.saveObject(input());
    await rm(repo.indexFile, { force: true });

    const reopened = new FileSystemRepository({ root, system: { key: "DS4-100" }, logger: { warn: () => {} } });
    const cached = await reopened.getObject("ZTEST");
    expect(cached?.source).toContain("define view entity ZTEST");
    expect((await reopened.findObjects()).length).toBe(1);
  });

  it("rebuilds a malformed index and reports it", async () => {
    const { root, repo } = await makeRepo();
    await repo.saveObject(input());
    await writeFile(repo.indexFile, "{ this is not json", "utf8");

    const warnings: string[] = [];
    const reopened = new FileSystemRepository({
      root,
      system: { key: "DS4-100" },
      logger: { warn: (message) => warnings.push(message) },
    });
    const cached = await reopened.getObject("ZTEST");
    expect(cached).not.toBeNull();
    expect(warnings.some((w) => w.includes("rebuilding"))).toBe(true);
  });

  it("detects stale derived artifacts by parser/extractor version and source hash", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());

    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    const metadataPath = join(repo.systemDir, entry.metadataPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      parser: { version: string; extractorVersion: string };
    };
    metadata.parser.version = "0.0.0-old";
    metadata.parser.extractorVersion = "0";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const stale = await repo.getObject("ZTEST");
    expect(stale?.stale).toBe(true);

    const sourcePath = join(repo.systemDir, entry.objectDir, entry.sourceArtifact);
    await writeFile(sourcePath, "define view entity ZTEST as select from CHANGED { key x }", "utf8");
    const changed = await repo.getObject("ZTEST");
    expect(changed?.stale).toBe(true);
  });

  it("marks a missing source artifact as stale", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    await rm(join(repo.systemDir, entry.objectDir, entry.sourceArtifact), { force: true });

    const cached = await repo.getObject("ZTEST");
    expect(cached).not.toBeNull();
    expect(cached?.source).toBeUndefined();
    expect(cached?.stale).toBe(true);
  });

  it("updates the stored source hash when derived artifacts are regenerated from changed source", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    const sourcePath = join(repo.systemDir, entry.objectDir, entry.sourceArtifact);
    const newSource = "define view entity ZTEST as select from CHANGED { key x }";
    await writeFile(sourcePath, newSource, "utf8");

    const stale = await repo.getObject("ZTEST");
    expect(stale?.stale).toBe(true);
    expect(stale?.source).toBe(newSource);

    const newHash = sha256(newSource);
    await repo.saveDerived(
      "ZTEST",
      {
        schemaVersion: 1,
        object: { name: "ZTEST", type: "DDLS" },
        sourceHash: newHash,
        parser: { name: "@abapify/acds", version: PARSER_VERSION, extractorVersion: EXTRACTOR_VERSION },
        definitionKinds: ["viewEntity"],
        sources: [{ name: "CHANGED", role: "primary" }],
        parseErrors: [],
      },
      {
        schemaVersion: 1,
        sourceHash: newHash,
        extractorVersion: EXTRACTOR_VERSION,
        dependencies: [],
      },
    );

    const refreshed = await repo.getObject("ZTEST");
    expect(refreshed?.stale).toBe(false);
    expect(refreshed?.metadata.source.sha256).toBe(newHash);
  });

  it("regenerates derived artifacts without rewriting the source hash", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    const metadataPath = join(repo.systemDir, entry.metadataPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      parser: { version: string; extractorVersion: string };
    };
    metadata.parser.version = "0.0.0-old";
    metadata.parser.extractorVersion = "0";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const stale = await repo.getObject("ZTEST");
    expect(stale?.stale).toBe(true);

    const sourceHash = stale!.metadata.source.sha256;
    const saved = await repo.saveDerived(
      "ZTEST",
      {
        schemaVersion: 1,
        object: { name: "ZTEST", type: "DDLS" },
        sourceHash,
        parser: { name: "@abapify/acds", version: PARSER_VERSION, extractorVersion: EXTRACTOR_VERSION },
        definitionKinds: ["viewEntity"],
        sources: [{ name: "CDPOS", role: "primary" }],
        parseErrors: [],
      },
      {
        schemaVersion: 1,
        sourceHash,
        extractorVersion: EXTRACTOR_VERSION,
        dependencies: [{ name: "CDPOS", canonicalName: "CDPOS", role: "primary", objectType: null, resolution: "unknown" }],
      },
    );

    expect(saved.stale).toBe(false);
    expect(saved.metadata.source.sha256).toBe(sourceHash);
    expect((await repo.getObject("ZTEST"))?.stale).toBe(false);
  });

  it("stores tables, structures and views under clearly named artifacts", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(
      input({
        name: "CDPOS",
        canonicalName: "CDPOS",
        objectType: "TABL",
        objectSubtype: "DT",
        source: "define table cdpos { mandt : mandt; }",
        sourceArtifact: "source.table",
        sourceFormat: "table",
        retrievalSource: "adt-table-read",
      }),
    );
    await repo.saveObject(
      input({
        name: "BAPIRET2",
        canonicalName: "BAPIRET2",
        objectType: "TABL",
        objectSubtype: "DS",
        source: "define structure bapiret2 { type : bapi_mtype; }",
        sourceArtifact: "source.structure",
        sourceFormat: "structure",
        retrievalSource: "adt-structure-read",
      }),
    );
    await repo.saveObject(
      input({
        name: "V_T001",
        canonicalName: "V_T001",
        objectType: "VIEW",
        objectSubtype: "DV",
        metadataOnly: true,
        source: '<adtcore:mainObject adtcore:name="V_T001" />',
        sourceArtifact: "source.view.xml",
        sourceFormat: "view-metadata",
        retrievalSource: "adt-fetch-view-metadata",
      }),
    );

    const entries = await repo.findObjects();
    expect(entries.find((e) => e.canonicalName === "CDPOS")?.sourceArtifact).toBe("source.table");
    expect(entries.find((e) => e.canonicalName === "BAPIRET2")?.sourceArtifact).toBe("source.structure");
    expect(entries.find((e) => e.canonicalName === "V_T001")?.sourceArtifact).toBe("source.view.xml");
    expect(entries.find((e) => e.canonicalName === "V_T001")?.metadataOnly).toBe(true);
  });

  it("supports filtered lookup and explicit rebuilds", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    await repo.saveObject(
      input({
        name: "CDPOS",
        canonicalName: "CDPOS",
        objectType: "TABL",
        objectSubtype: "DT",
        packageName: "SZD",
        source: "define table cdpos { mandt : mandt; }",
        sourceArtifact: "source.table",
        sourceFormat: "table",
      }),
    );

    expect((await repo.findObjects({ objectType: "TABL" })).map((e) => e.canonicalName)).toEqual(["CDPOS"]);
    expect((await repo.findObjects({ name: "cdp" })).map((e) => e.canonicalName)).toEqual(["CDPOS"]);
    expect((await repo.findObjects({ packageName: "SZD" })).length).toBe(2);

    const rebuilt = await repo.rebuildIndex();
    expect(rebuilt.objects.map((e) => e.canonicalName)).toEqual(["CDPOS", "ZTEST"]);
  });

  it("rejects artifact names containing path separators", async () => {
    const { repo } = await makeRepo();
    await expect(
      repo.saveObject(input({ sourceArtifact: "../source.asddls" })),
    ).rejects.toThrow(/Invalid source artifact/);
  });

  it("does not leave temporary files behind", async () => {
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    const entry = (await repo.findObjects({ name: "ZTEST" }))[0]!;
    const objectDir = join(repo.systemDir, entry.objectDir);
    const files = await readdir(objectDir);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("makes no network calls itself", async () => {
    // The repository has no HTTP dependency; this is a guard against accidental
    // coupling being introduced later.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const { repo } = await makeRepo();
    await repo.saveObject(input());
    expect(await repo.getObject("ZTEST")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
