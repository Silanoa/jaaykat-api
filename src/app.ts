import { existsSync } from "node:fs";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Database } from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import type { BitnobClient } from "./bitnob/types.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";

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
  app.decorateRequest("auth", null);
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
        message: "Trop de tentatives. Réessayez dans un instant.",
        retryAfterSeconds,
      });
    }
    const name = error instanceof Error ? error.name : "Error";
    request.log.error({ name }, "erreur interne");
    return reply.code(500).send({ error: "INTERNAL", message: "Une erreur est survenue." });
  });

  app.get("/api/health", async () => ({ ok: true, bitnob: bitnobEnv }));

  registerAuthRoutes(app, db, bitnob, config);

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
