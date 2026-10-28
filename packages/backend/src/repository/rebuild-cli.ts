import { loadConfig } from "../config.js";
import { createLogging } from "../logging/logger.js";
import { FileSystemRepository } from "./repository.js";

/**
 * Explicit repository index recovery path:
 *
 *   npm run repo:rebuild
 *
 * The backend also rebuilds automatically when the index is missing, malformed
 * or refers to missing files; this command is for operators who want to force
 * a clean rebuild.
 */
async function main(): Promise<void> {
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

  const startedAt = performance.now();
  log.info("Repository index rebuild started", {
    event: "repo.rebuild.start",
    systemKey: config.system.key,
    systemIdentitySource: config.system.source,
    storageRoot: config.storageRoot,
  });

  try {
    const repository = new FileSystemRepository({
      root: config.storageRoot,
      system: config.system,
      logger: log,
    });
    const index = await repository.rebuildIndex();
    log.info("Repository index rebuilt", {
      event: "repo.rebuild.summary",
      systemKey: config.system.key,
      objectCount: index.objects.length,
      durationMs: Math.round(performance.now() - startedAt),
      indexFile: repository.indexFile,
    });
  } catch (err) {
    log.fatal("Repository index rebuild failed", {
      event: "repo.rebuild.failed",
      systemKey: config.system.key,
      err,
    });
    process.exitCode = 1;
  } finally {
    await logging.close();
  }
}

void main();
