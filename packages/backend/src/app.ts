import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import type { AnalyzeRequest, CacheMode } from "@cds-visualiser/shared";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_OBJECTS,
  MAX_DEPTH_LIMIT,
} from "@cds-visualiser/shared";
import type { ObjectProvider } from "./adt/types.js";
import { analyze, type NameValidator } from "./collector/collector.js";
import { sanitizeCorrelationId, runWithLogContext } from "./logging/context.js";
import type { Logger } from "./logging/logger.js";
import { validateObjectName } from "./adt/validate.js";

export interface AppDeps {
  provider: ObjectProvider;
  maxObjects?: number;
  concurrency?: number;
  maxDepth?: number;
  validate?: NameValidator;
  /** True when serving from bundled fixtures instead of the ADT CLI. */
  fixtureMode?: boolean;
  /** Local repository access policy, for status reporting. */
  cacheMode?: CacheMode;
  /** Stable SAP system key, for status reporting (no secrets). */
  systemKey?: string;
  logger?: Logger;
  parseLogger?: Logger;
  slowParseMs?: number;
  slowAnalysisMs?: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "64kb" }));

  const maxObjects = deps.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const defaultMaxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const validate = deps.validate ?? validateObjectName;
  const logger = deps.logger;

  // Request-scoped correlation. The request ID is also returned to the client
  // so a UI action can be matched with server logs.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId =
      sanitizeCorrelationId(req.header("x-request-id")) ?? randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    const context = { requestId };
    runWithLogContext(context, () => {
      const startedAt = performance.now();
      logger?.debug("HTTP request started", {
        event: "http.request.start",
        requestId,
        method: req.method,
        path: req.path,
      });

      res.on("finish", () => {
        runWithLogContext(context, () => {
          const fields = {
            event: "http.request.finish",
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          };
          // Health probes are high-frequency; keep them out of the info log.
          if (req.path === "/api/health") {
            logger?.debug("Health request finished", fields);
          } else {
            logger?.info("HTTP request finished", fields);
          }
        });
      });

      next();
    });
  });

  app.get("/api/health", (_req, res) => {
    logger?.debug("Health check", {
      event: "http.health",
      fixtureMode: deps.fixtureMode ?? false,
      cacheMode: deps.cacheMode,
      systemKey: deps.systemKey,
    });
    res.json({
      status: "ok",
      fixtureMode: deps.fixtureMode ?? false,
      cacheMode: deps.cacheMode,
      systemKey: deps.systemKey,
    });
  });

  app.post("/api/analyze", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<AnalyzeRequest>;
    const name = typeof body.name === "string" ? body.name : "";

    const requestedDepth = typeof body.maxDepth === "number" ? Math.floor(body.maxDepth) : defaultMaxDepth;
    const maxDepth = Math.min(Math.max(requestedDepth, 0), MAX_DEPTH_LIMIT);

    try {
      const result = await analyze(name, {
        provider: deps.provider,
        options: { maxDepth, maxObjects, concurrency },
        validate,
        cache: deps.cacheMode ? { mode: deps.cacheMode, systemKey: deps.systemKey } : undefined,
        logger,
        parseLogger: deps.parseLogger,
        slowParseMs: deps.slowParseMs,
        slowAnalysisMs: deps.slowAnalysisMs,
      });
      res.json(result);
    } catch (err) {
      logger?.error("Analysis failed", {
        event: "http.error",
        err,
        status: 500,
        rootObject: name,
      });
      res.status(500).json({
        error: {
          code: "internal-error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // JSON body parse errors → 400.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger?.warn("Request rejected", {
      event: "http.request.rejected",
      reason: "invalid-json",
      method: req.method,
      path: req.path,
    });
    res.status(400).json({ error: { code: "bad-request", message: err instanceof Error ? err.message : "Bad request" } });
  });

  return app;
}
