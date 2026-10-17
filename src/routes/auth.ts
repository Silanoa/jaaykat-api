import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "better-sqlite3";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { bearerToken, makeRequireAuth } from "../auth/require-auth.js";
import { loginMerchant, registerMerchant, revokeSession, sessionView, type RegisterInput } from "../auth/service.js";

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded;
  return req.ip;
}

function authRateLimit() {
  return {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => clientIp(req),
        errorResponseBuilder: (_req: FastifyRequest, context: { ttl: number }) => {
          const err = new Error("Trop de tentatives. Réessayez dans un instant.");
          return Object.assign(err, {
            statusCode: 429,
            retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
          });
        },
      },
    },
  };
}

function asRegister(body: unknown): RegisterInput {
  const value = (body ?? {}) as Partial<RegisterInput>;
  return {
    shopName: String(value.shopName ?? ""),
    category: String(value.category ?? ""),
    firstName: String(value.firstName ?? ""),
    lastName: String(value.lastName ?? ""),
    phone: String(value.phone ?? ""),
    pin: String(value.pin ?? ""),
  };
}

export function registerAuthRoutes(app: FastifyInstance, db: Database, bitnob: BitnobClient, config: AppConfig): void {
  const requireAuth = makeRequireAuth(db, config);

  app.post("/api/auth/register", authRateLimit(), async (req, reply) => {
    const session = await registerMerchant(db, bitnob, config, asRegister(req.body), req.headers["user-agent"]);
    return reply.code(201).send(session);
  });

  app.post("/api/auth/login", authRateLimit(), async (req, reply) => {
    const body = (req.body ?? {}) as { phone?: string; pin?: string };
    const session = await loginMerchant(db, config, String(body.phone ?? ""), String(body.pin ?? ""), req.headers["user-agent"]);
    return reply.code(200).send(session);
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    return sessionView(db, req.auth, config.publicUrl);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const known = revokeSession(db, token, config.now());
    if (!known) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    return reply.code(204).send();
  });
}
