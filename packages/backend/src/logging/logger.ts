import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DestinationStream } from "pino";
import pino, { type Logger as PinoLogger } from "pino";
import pinoPretty from "pino-pretty";
import { createStream, type RotatingFileStream } from "rotating-file-stream";
import { getLogContext } from "./context.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Structured fields attached to a log event. Never put SAP source here. */
export type LogFields = Record<string, unknown>;

/**
 * Minimal logging surface used by application modules.
 *
 * Keeping this interface small (instead of exposing pino's full type) makes it
 * trivial to inject a fake logger in tests and keeps pino out of domain code.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
}

export interface LoggingOptions {
  dir: string;
  level: LogLevel;
  pretty: boolean;
  retentionDays: number;
  /** Injectable clock for retention tests. */
  now?: () => Date;
}

export interface Logging {
  app: Logger;
  sap: Logger;
  parse: Logger;
  /** Directory actually used, or undefined when console fallback is active. */
  dir?: string;
  /** Set when file logging could not be initialised. */
  fallbackReason?: string;
  close(): Promise<void>;
}

const CHANNELS = ["app", "sap", "parse"] as const;
type Channel = (typeof CHANNELS)[number];

const LOG_FILE_PATTERN = /^(app|sap|parse|error)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * Create the three file-backed channel loggers.
 *
 * Layout:
 *   logs/app-YYYY-MM-DD.jsonl
 *   logs/sap-YYYY-MM-DD.jsonl
 *   logs/parse-YYYY-MM-DD.jsonl
 *   logs/error-YYYY-MM-DD.jsonl   (mirrors error/fatal from every channel)
 *
 * If the directory cannot be created or opened, console logging is used and
 * `fallbackReason` is set. Logging failures never propagate into an analysis.
 */
export function createLogging(options: LoggingOptions): Logging {
  const now = options.now ?? (() => new Date());

  try {
    mkdirSync(options.dir, { recursive: true });
    pruneOldLogs(options.dir, options.retentionDays, now());
  } catch (err) {
    return createFallbackLogging(`Could not prepare log directory ${options.dir}: ${errorMessage(err)}`);
  }

  const openedStreams = new Set<DestinationStream | RotatingFileStream>();

  const createFileStream = (channel: "app" | "sap" | "parse" | "error"): RotatingFileStream => {
    const stream = createStream(
      (time) => `${channel}-${formatDate(time)}.jsonl`,
      {
        path: options.dir,
        interval: "1d",
        // Rotate at local midnight rather than 24h after process start.
        intervalBoundary: true,
        intervalUTC: false,
        maxFiles: Math.max(1, Math.floor(options.retentionDays)),
        mode: 0o600,
      },
    );
    stream.on("error", (err: Error) => {
      process.stderr.write(`[logging] ${channel} log stream error: ${err.message}\n`);
    });
    openedStreams.add(stream);
    return stream;
  };

  try {
    // A single error stream is shared by all channel loggers.
    const errorStream = createFileStream("error");
    const prettyStream = options.pretty
      ? pinoPretty({
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          singleLine: true,
        })
      : undefined;
    if (prettyStream) openedStreams.add(prettyStream);

    const build = (channel: Channel): Logger => {
      const channelStream = createFileStream(channel);
      const destinations: Array<{ level: LogLevel; stream: DestinationStream }> = [
        { level: options.level, stream: channelStream },
        // Errors and fatals are always mirrored into the shared error file.
        { level: "error", stream: errorStream },
      ];
      if (prettyStream) {
        destinations.push({ level: options.level, stream: prettyStream });
      }

      const pinoLogger = pino(
        {
          level: options.level,
          base: { app: "cds-visualiser", channel, pid: process.pid },
          timestamp: () => `,"ts":"${new Date().toISOString()}"`,
          formatters: {
            level: (label) => ({ level: label }),
          },
          serializers: {
            err: pino.stdSerializers.err,
            error: pino.stdSerializers.err,
          },
          redact: {
            paths: [
              "authorization",
              "password",
              "token",
              "secret",
              "cookie",
              "headers.authorization",
              "headers.cookie",
              "req.headers.authorization",
              "req.headers.cookie",
              "*.authorization",
              "*.password",
              "*.token",
              "*.secret",
              "*.cookie",
              "*.headers.authorization",
              "*.headers.cookie",
            ],
            censor: "[REDACTED]",
          },
          // Return a fresh object: pino's default mixin strategy mutates the
          // object returned by `mixin`, which would leak fields between calls.
          mixin: () => ({ ...getLogContext() }),
        },
        pino.multistream(destinations),
      );

      return new PinoLoggerAdapter(pinoLogger);
    };

    const app = build("app");
    const sap = build("sap");
    const parse = build("parse");

    return {
      app,
      sap,
      parse,
      dir: options.dir,
      close: async () => {
        await Promise.all(
          [...openedStreams].map(
            (stream) =>
              new Promise<void>((resolve) => {
                const writable = stream as unknown as {
                  destroyed?: boolean;
                  writableEnded?: boolean;
                  end(callback?: () => void): void;
                };
                if (writable.destroyed || writable.writableEnded) {
                  resolve();
                  return;
                }
                writable.end(() => resolve());
              }),
          ),
        );
      },
    };
  } catch (err) {
    for (const stream of openedStreams) {
      try {
        (stream as unknown as { destroy(): void }).destroy();
      } catch {
        /* ignore */
      }
    }
    return createFallbackLogging(`Could not open log files in ${options.dir}: ${errorMessage(err)}`);
  }
}

/** Remove log files older than the retention window (also runs at startup). */
export function pruneOldLogs(dir: string, retentionDays: number, now: Date): void {
  const keep = Math.max(1, Math.floor(retentionDays));
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - (keep - 1));

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const match = LOG_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const [, , year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (Number.isNaN(date.getTime()) || date >= cutoff) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {
      /* A file still held open by another process is left for the next run. */
    }
  }
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly logger: PinoLogger) {}

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }

  fatal(message: string, fields?: LogFields): void {
    this.logger.fatal(fields ?? {}, message);
  }
}

/** Fill in any omitted methods with no-ops (useful for focused test doubles). */
export function normalizeLogger(logger?: Partial<Logger>): Logger {
  return {
    debug: (message, fields) => logger?.debug?.(message, fields),
    info: (message, fields) => logger?.info?.(message, fields),
    warn: (message, fields) => logger?.warn?.(message, fields),
    error: (message, fields) => logger?.error?.(message, fields),
    fatal: (message, fields) => logger?.fatal?.(message, fields),
  };
}

/** Scrub token/password-shaped values from untrusted diagnostic text. */
export function redactText(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(password|passwd|token|secret|authorization|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]");
}

export function createConsoleLogger(channel: "app" | "sap" | "parse" = "app"): Logger {
  return new ConsoleLogger(channel);
}

function createFallbackLogging(reason: string): Logging {
  const build = (channel: Channel): Logger => new ConsoleLogger(channel);
  return {
    app: build("app"),
    sap: build("sap"),
    parse: build("parse"),
    fallbackReason: reason,
    close: async () => undefined,
  };
}

/** JSONL to stderr, used only when the log directory is unavailable. */
class ConsoleLogger implements Logger {
  constructor(private readonly channel: Channel) {}

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.write("fatal", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    const context = getLogContext();
    const normalized = { ...(fields ?? {}) };
    for (const key of ["err", "error"] as const) {
      const value = normalized[key];
      if (value instanceof Error) {
        normalized[key] = { type: value.name, message: value.message, stack: value.stack };
      }
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      app: "cds-visualiser",
      channel: this.channel,
      msg: message,
      ...context,
      ...normalized,
    });
    process.stderr.write(`${line}\n`);
  }
}

function formatDate(value: number | Date): string {
  const candidate = value instanceof Date ? value : value > 0 ? new Date(value) : new Date();
  const date = Number.isNaN(candidate.getTime()) ? new Date() : candidate;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
