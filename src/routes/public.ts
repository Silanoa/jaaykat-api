import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "better-sqlite3";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { createPublicInvoice, getPublicInvoice, getPublicShop, type InvoicePolls } from "../modules/invoices/service.js";
import type { RateCache } from "../modules/rates/service.js";

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded;
  return req.ip;
}

function publicRateLimit() {
  return {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => `public:${clientIp(req)}`,
        errorResponseBuilder: (_req: FastifyRequest, context: { ttl: number }) =>
          Object.assign(new Error("Trop de tentatives. Réessayez dans un instant."), {
            statusCode: 429,
            retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
          }),
      },
    },
  };
}

export function registerPublicRoutes(
  app: FastifyInstance,
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  rates: RateCache,
  polls: InvoicePolls,
): void {
  const limit = publicRateLimit();
  app.get("/api/public/shops/:slug", limit, async (req) => {
    const params = req.params as { slug: string };
    return getPublicShop(db, params.slug);
  });

  app.post("/api/public/invoices", limit, async (req, reply) => {
    const body = (req.body ?? {}) as {
      slug?: string;
      amountXof?: number;
      payerName?: string;
      payerPhone?: string;
      deviceId?: string;
    };
    const invoice = await createPublicInvoice(db, bitnob, rates, config, {
      slug: String(body.slug ?? ""),
      amountXof: body.amountXof ?? Number.NaN,
      payerName: body.payerName,
      payerPhone: body.payerPhone,
      deviceId: body.deviceId,
    });
    return reply.code(201).send(invoice);
  });

  app.get("/api/public/invoices/:id", limit, async (req) => {
    const params = req.params as { id: string };
    return getPublicInvoice(db, bitnob, config, polls, params.id);
  });
}
