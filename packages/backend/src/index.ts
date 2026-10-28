import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { AdtObjectProvider } from "./adt/adt-resolver.js";
import { NodeProcessAdapter } from "./adt/process-adapter.js";
import { createFixtureProvider } from "./adt/fixture-service.js";
import { loadFixtureDir } from "./fixtures/load.js";
import { createLogging } from "./logging/logger.js";
import { EXTRACTOR_VERSION, PARSER_NAME, PARSER_VERSION } from "./parser/version.js";
import { CachingObjectProvider } from "./repository/caching-provider.js";
import { FileSystemRepository } from "./repository/repository.js";
import type { ObjectProvider } from "./adt/types.js";

const config = loadConfig();
const logging = createLogging({
  dir: config.logDir,
  level: config.logLevel,
  pretty: config.logPretty,
  retentionDays: config.logRetentionDays,
});
const log = logging.app;

if (logging.fallbackReason) {
  log.warn("File logging unavailable; falling back to console output.", {
    event: "app.logging.fallback",
    logDir: config.logDir,
    reason: logging.fallbackReason,
  });
}

async function buildProvider(): Promise<{ provider: ObjectProvider; fixtureMode: boolean }> {
  if (config.fixtureDir) {
    const { sources, objectTypes, formats } = loadFixtureDir(config.fixtureDir);
    return { provider: createFixtureProvider(sources, objectTypes, formats), fixtureMode: true };
  }

  const repository = new FileSystemRepository({
    root: config.storageRoot,
    system: config.system,
    logger: logging.app,
  });
  await repository.initialize();

  const upstream = new AdtObjectProvider(new NodeProcessAdapter(), {
    command: config.adtCommand,
    timeoutMs: config.readTimeoutMs,
    logger: logging.sap,
    stderrPreview: config.logStderrPreview,
    slowSapMs: config.logSlowSapMs,
  });

  return {
    provider: new CachingObjectProvider({
      repository,
      upstream,
      mode: config.cacheMode,
      logger: logging.app,
    }),
    fixtureMode: false,
  };
}

const { provider, fixtureMode } = await buildProvider().catch(async (err: unknown) => {
  log.fatal("Backend startup failed", { event: "app.startup.failed", err });
  await closeLogging();
  process.exit(1);
});

const app = createApp({
  provider,
  fixtureMode,
  cacheMode: fixtureMode ? undefined : config.cacheMode,
  systemKey: fixtureMode ? undefined : config.system.key,
  maxDepth: config.maxDepth,
  maxObjects: config.maxObjects,
  concurrency: config.concurrency,
  logger: logging.app,
  parseLogger: logging.parse,
});

log.info("CDS lineage backend starting", {
  event: "app.startup",
  mode: fixtureMode ? "fixture" : "adt",
  fixtureDir: config.fixtureDir,
  cacheMode: fixtureMode ? undefined : config.cacheMode,
  systemKey: fixtureMode ? undefined : config.system.key,
  systemIdentitySource: fixtureMode ? undefined : config.system.source,
  storageRoot: fixtureMode ? undefined : config.storageRoot,
  logDir: logging.dir,
  nodeVersion: process.version,
  parser: PARSER_NAME,
  parserVersion: PARSER_VERSION,
  extractorVersion: EXTRACTOR_VERSION,
  adtCommand: fixtureMode ? undefined : config.adtCommand,
  maxDepth: config.maxDepth,
  maxObjects: config.maxObjects,
  concurrency: config.concurrency,
});

const server = app.listen(config.port, () => {
  const mode = fixtureMode
    ? `fixture mode (dir: ${config.fixtureDir})`
    : `ADT CLI (command: ${config.adtCommand}), local repository (system ${config.system.key}, mode ${config.cacheMode}, root ${config.storageRoot})`;
  log.info("Backend listening", {
    event: "app.listening",
    port: config.port,
    url: `http://localhost:${config.port}`,
    mode,
  });
});

server.on("error", (err) => {
  log.fatal("HTTP server error", { event: "app.server.error", port: config.port, err });
  void closeLogging().finally(() => {
    process.exit(1);
  });
});

let shuttingDown = false;

async function closeLogging(): Promise<void> {
  await Promise.race([
    logging.close(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
  ]);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info("Shutting down", { event: "app.shutdown", signal });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Do not wait forever for keep-alive connections.
    setTimeout(resolve, 5_000).unref();
  });
  await closeLogging();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("unhandledRejection", (reason) => {
  log.fatal("Unhandled promise rejection", {
    event: "app.unhandled-rejection",
    err: reason instanceof Error ? reason : { message: String(reason) },
  });
  void closeLogging().finally(() => {
    process.exitCode = 1;
  });
});
process.on("uncaughtException", (err) => {
  log.fatal("Uncaught exception", { event: "app.uncaught-exception", err });
  void closeLogging().finally(() => {
    process.exit(1);
  });
});
