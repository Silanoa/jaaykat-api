import { existsSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Database } from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import type { BitnobClient } from "./bitnob/types.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { InvoicePolls } from "./modules/invoices/service.js";
import { RateCache } from "./modules/rates/service.js";
import { reconcilePending } from "./reconciler.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerPayoutRoutes } from "./routes/payouts.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerWebhookRoute } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    invoicePolls: InvoicePolls;
  }
}

export interface AppDeps {
  db: Database;
  bitnob: BitnobClient;
  config: AppConfig;
  bitnobEnv: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, bitnob, config, bitnobEnv } = deps;
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : { level: "info" },
  });
  app.addHook("onRequest", async (req) => {
    const contentType = req.headers["content-type"];
    if (req.url.startsWith("/webhooks/bitnob") && typeof contentType === "string" && contentType.includes(",")) {
      req.headers["content-type"] = contentType.split(",")[0]?.trim() ?? contentType;
    }
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buffer = body as Buffer;
    const path = req.url.split("?")[0] ?? "";
    if (path === "/webhooks/bitnob") {
      done(null, buffer);
      return;
    }
    try {
      const text = buffer.toString("utf8");
      done(null, text.length === 0 ? {} : JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  app.decorateRequest("auth", null);
  const polls: InvoicePolls = { lastFetch: new Map(), lastSeen: new Map() };
  app.decorate("invoicePolls", polls);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: error.code, message: error.message, ...error.extra });
    }
    const statusCode =
      error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 429) {
      const retryAfterSeconds =
        error instanceof Error && "retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number"
          ? error.retryAfterSeconds
          : 60;
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Trop de tentatives. RÃƒÂ©essayez dans un instant.",
        retryAfterSeconds,
      });
    }
    const name = error instanceof Error ? error.name : "Error";
    request.log.error({ name, code: (error as { code?: unknown }).code, detail: error instanceof Error ? error.message : undefined, contentType: request.headers["content-type"], contentEncoding: request.headers["content-encoding"] }, "erreur interne");
    return reply.code(500).send({ error: "INTERNAL", message: "Une erreur est survenue." });
  });

  app.get("/api/health", async () => ({
    ok: true,
    bitnob: bitnobEnv === "mock" || bitnobEnv === "sandbox" || bitnobEnv === "live",
    mode: bitnobEnv,
  }));

  registerAuthRoutes(app, db, bitnob, config);
  const rates = new RateCache();
  registerInvoiceRoutes(app, db, bitnob, config, rates, polls);
  registerPublicRoutes(app, db, bitnob, config, rates, polls);
  registerWebhookRoute(app, db, bitnob, config);
  registerAnalyticsRoutes(app, db, config);
  registerPayoutRoutes(app, db, bitnob, config, rates);
  if (config.reconcileIntervalMs > 0) {
    const timer = setInterval(() => {
      void reconcilePending(db, bitnob, config, polls);
    }, config.reconcileIntervalMs);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/webhooks/")) {
        return reply.code(404).send({ error: "NOT_FOUND", message: "Ressource introuvable." });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
