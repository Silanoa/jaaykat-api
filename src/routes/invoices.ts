import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { makeRequireAuth } from "../auth/require-auth.js";
import { createMerchantInvoice, getMerchantInvoice, type InvoicePolls } from "../modules/invoices/service.js";
import type { RateCache } from "../modules/rates/service.js";

function idempotencyKey(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? "";
  return header ?? "";
}

export function registerInvoiceRoutes(
  app: FastifyInstance,
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  rates: RateCache,
  polls: InvoicePolls,
): void {
  const requireAuth = makeRequireAuth(db, config);

  app.post("/api/invoices", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const body = (req.body ?? {}) as { amountXof?: number; label?: string };
    const result = await createMerchantInvoice(
      db,
      bitnob,
      rates,
      config,
      req.auth.merchantId,
      { amountXof: body.amountXof ?? Number.NaN, label: body.label },
      idempotencyKey(req.headers["idempotency-key"]),
    );
    return reply.code(result.created ? 201 : 200).send({ invoice: result.invoice });
  });

  app.get("/api/invoices/:id", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const params = req.params as { id: string };
    const invoice = await getMerchantInvoice(db, bitnob, config, polls, req.auth.merchantId, params.id);
    return { invoice };
  });
}
