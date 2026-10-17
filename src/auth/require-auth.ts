import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { readSession } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: { userId: string; merchantId: string; expiresAt: string } | null;
  }
}

export function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export function makeRequireAuth(db: Database, config: AppConfig) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = readSession(db, bearerToken(req.headers.authorization), config.now());
    if (!session) {
      await reply.code(401).send({ error: "UNAUTHENTICATED", message: "Connexion requise." });
      return;
    }
    req.auth = session;
  };
}
