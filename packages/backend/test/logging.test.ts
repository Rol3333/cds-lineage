import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdtObjectProvider } from "../src/adt/adt-resolver.js";
import type { ProcessAdapter } from "../src/adt/types.js";
import { runWithLogContext } from "../src/logging/context.js";
import { createLogging, pruneOldLogs, type Logging } from "../src/logging/logger.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cds-visualiser-logs-"));
  roots.push(dir);
  return dir;
}

async function createTestLogging(overrides: Partial<Parameters<typeof createLogging>[0]> = {}): Promise<{
  logging: Logging;
  dir: string;
}> {
  const dir = await tempDir();
  const logging = createLogging({
    dir,
    level: "debug",
    pretty: false,
    retentionDays: 30,
    ...overrides,
  });
  return { logging, dir };
}

async function readEvents(dir: string, channel: string): Promise<Array<Record<string, unknown>>> {
  const files = (await readdir(dir)).filter((name) => name.startsWith(`${channel}-`) && name.endsWith(".jsonl"));
  const events: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) events.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return events;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("structured logging", () => {
  it("routes events to per-channel files and mirrors errors", async () => {
    const { logging, dir } = await createTestLogging();

    logging.app.info("app event", { event: "test.app" });
    logging.sap.info("sap event", { event: "test.sap" });
    logging.parse.warn("parse event", { event: "test.parse" });
    logging.app.error("boom", { event: "test.error", err: new Error("boom") });

    await logging.close();

    const app = await readEvents(dir, "app");
    const sap = await readEvents(dir, "sap");
    const parse = await readEvents(dir, "parse");
    const error = await readEvents(dir, "error");

    expect(app.map((e) => e.event)).toContain("test.app");
    expect(app.map((e) => e.event)).toContain("test.error");
    expect(app.map((e) => e.event)).not.toContain("test.sap");

    expect(sap.map((e) => e.event)).toEqual(["test.sap"]);
    expect(parse.map((e) => e.event)).toEqual(["test.parse"]);

    expect(error.map((e) => e.event)).toEqual(["test.error"]);
    expect(error[0]?.err).toMatchObject({ message: "boom" });
  });

  it("adds request, analysis and object context to every line", async () => {
    const { logging, dir } = await createTestLogging();

    runWithLogContext(
      { requestId: "req-1", analysisId: "ana-1", rootObject: "ROOT", object: "DEP", depth: 2 },
      () => logging.app.info("context", { event: "test.context" }),
    );

    await logging.close();

    const [event] = await readEvents(dir, "app");
    expect(event).toMatchObject({
      event: "test.context",
      requestId: "req-1",
      analysisId: "ana-1",
      rootObject: "ROOT",
      object: "DEP",
      depth: 2,
    });
  });

  it("does not leak fields between log calls with ambient context", async () => {
    const { logging, dir } = await createTestLogging();

    runWithLogContext({ requestId: "req-1" }, () => {
      logging.app.info("first", { event: "test.first", root: "ROOT", requestedDepth: 2 });
      logging.app.info("second", { event: "test.second" });
    });

    await logging.close();

    const events = await readEvents(dir, "app");
    const second = events.find((event) => event.event === "test.second");
    expect(second).toMatchObject({ requestId: "req-1" });
    expect(second).not.toHaveProperty("root");
    expect(second).not.toHaveProperty("requestedDepth");
  });

  it("routes parse events while ambient context is active", async () => {
    const { logging, dir } = await createTestLogging();

    runWithLogContext({ requestId: "req-1", analysisId: "ana-1", object: "A", depth: 1 }, () => {
      logging.parse.info("CDS parsed", {
        event: "parse.ok",
        sourceBytes: 42,
        definitionKinds: ["viewEntity"],
        dependencyCount: 1,
      });
      logging.app.info("finished", { event: "test.after-parse" });
    });

    await logging.close();

    const parseEvents = await readEvents(dir, "parse");
    expect(parseEvents).toHaveLength(1);
    expect(parseEvents[0]).toMatchObject({
      event: "parse.ok",
      object: "A",
      depth: 1,
      sourceBytes: 42,
    });
    const appEvents = await readEvents(dir, "app");
    expect(appEvents.find((event) => event.event === "test.after-parse")).not.toHaveProperty("sourceBytes");
  });

  it("redacts credentials and tokens", async () => {
    const { logging, dir } = await createTestLogging();

    logging.app.info("redact", {
      event: "test.redact",
      authorization: "Bearer top-secret",
      password: "hunter2",
      cookie: "session=abc",
      nested: { password: "nested-secret", token: "tok" },
    });

    await logging.close();

    const text = JSON.stringify(await readEvents(dir, "app"));
    expect(text).not.toContain("top-secret");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("session=abc");
    expect(text).not.toContain("nested-secret");
    expect(text).not.toContain('"token":"tok"');
    expect(text).toContain("[REDACTED]");
  });

  it("prunes log files older than the retention window", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "app-2000-01-01.jsonl"), "{}\n");
    await writeFile(join(dir, "app-2026-10-28.jsonl"), "{}\n");

    pruneOldLogs(dir, 30, new Date(2026, 9, 28));

    const files = await readdir(dir);
    expect(files).not.toContain("app-2000-01-01.jsonl");
    expect(files).toContain("app-2026-10-28.jsonl");
  });

  it("falls back to console logging when the directory cannot be created", async () => {
    const dir = await tempDir();
    const file = join(dir, "not-a-directory");
    await writeFile(file, "x");

    const logging = createLogging({
      dir: join(file, "logs"),
      level: "info",
      pretty: false,
      retentionDays: 30,
    });

    expect(logging.fallbackReason).toBeDefined();
    await logging.close();
  });

  it("never writes SAP source payloads to logs", async () => {
    const { logging, dir } = await createTestLogging();
    const marker = "SECRET_SOURCE_MARKER_9f3c";
    const source = `define view entity ZCDS as select from ${marker} { key x }`;

    const process: ProcessAdapter = {
      async run(_command, args) {
        if (args[0] === "search") {
          return {
            exitCode: 0,
            stdout: Buffer.from(
              `Searching...\n[{"name":"ZCDS","type":"DDLS/DF","packageName":"$TMP"}]\nSearch complete!`,
            ),
            stderr: "",
            timedOut: false,
          };
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(source, "utf8"),
          stderr: "🔍 Loading...\r\u001b[K",
          timedOut: false,
        };
      },
    };

    const provider = new AdtObjectProvider(process, {
      command: "adt",
      logger: logging.sap,
      stderrPreview: 100,
    });

    const result = await provider.resolve("ZCDS");
    expect(result.resolution).toBe("resolved");
    expect(result.source).toContain(marker);

    await logging.close();

    const events = await readEvents(dir, "sap");
    const text = JSON.stringify(events);
    expect(text).not.toContain(marker);
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["sap.search.ok", "sap.candidate.selected", "sap.read.ok"]),
    );

    const read = events.find((e) => e.event === "sap.read.ok");
    expect(read).toMatchObject({ object: "ZCDS", operation: "ddl", sourceFormat: "asddls" });
    expect(read?.sourceBytes).toBe(Buffer.byteLength(source, "utf8"));
  });

  it("records classified SAP failures without writing payloads", async () => {
    const { logging, dir } = await createTestLogging();

    const process: ProcessAdapter = {
      async run(_command, args) {
        if (args[0] === "search") {
          return {
            exitCode: 0,
            stdout: Buffer.from(`[{"name":"ZCDS","type":"DDLS/DF"}]`),
            stderr: "",
            timedOut: false,
          };
        }
        return {
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: "HTTP 401 unauthorized: logon failed",
          timedOut: false,
        };
      },
    };

    const provider = new AdtObjectProvider(process, {
      command: "adt",
      logger: logging.sap,
      stderrPreview: 1_000,
    });

    const result = await provider.resolve("ZCDS");
    expect(result.resolution).toBe("read-failed");
    expect(result.errorCode).toBe("auth");

    await logging.close();

    const failed = (await readEvents(dir, "sap")).find((e) => e.event === "sap.read.failed");
    expect(failed).toMatchObject({
      object: "ZCDS",
      operation: "ddl",
      errorCode: "auth",
      exitCode: 1,
    });
    expect(String(failed?.stderrPreview)).toContain("unauthorized");
  });

  it("handles concurrent analyses without leaking correlation context", async () => {
    const { logging, dir } = await createTestLogging();

    await Promise.all([
      runWithLogContext({ requestId: "req-a", analysisId: "ana-a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        logging.app.info("a", { event: "test.a" });
      }),
      runWithLogContext({ requestId: "req-b", analysisId: "ana-b" }, async () => {
        logging.app.info("b", { event: "test.b" });
      }),
    ]);

    await logging.close();

    const events = await readEvents(dir, "app");
    expect(events.find((e) => e.event === "test.a")).toMatchObject({
      requestId: "req-a",
      analysisId: "ana-a",
    });
    expect(events.find((e) => e.event === "test.b")).toMatchObject({
      requestId: "req-b",
      analysisId: "ana-b",
    });
  });

  it("creates the log directory on demand and uses the current local date", async () => {
    const dir = join(await tempDir(), "nested", "logs");
    const logging = createLogging({ dir, level: "info", pretty: false, retentionDays: 30 });
    logging.app.info("created", { event: "test.created" });
    await logging.close();

    const now = new Date();
    const expected = `app-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}.jsonl`;
    const files = await readdir(dir);
    expect(files).toContain(expected);

    const events = await readEvents(dir, "app");
    expect(events[0]).toMatchObject({ event: "test.created", channel: "app" });
  });
});
