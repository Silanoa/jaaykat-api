import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "better-sqlite3";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import {
  createPublicInvoice,
  getPublicInvoice,
  getPublicShop,
  payPublicInvoice,
  type InvoicePolls,
} from "../modules/invoices/service.js";
import type { RateCache } from "../modules/rates/service.js";
import { readPublicShare } from "./analytics.js";

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded;
  return req.ip;
}

function invoiceId(req: FastifyRequest): string {
  return String((req.params as { id?: string }).id ?? "");
}

function publicRateLimit(max: number, key: (req: FastifyRequest) => string) {
  return {
    config: {
      rateLimit: {
        max,
        timeWindow: "1 minute",
        keyGenerator: key,
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
  const read = publicRateLimit(60, (req) => `read:${clientIp(req)}`);
  const create = publicRateLimit(10, (req) => `create:${clientIp(req)}`);
  const poll = publicRateLimit(150, (req) => `poll:${clientIp(req)}:${invoiceId(req)}`);
  const pay = publicRateLimit(10, (req) => `pay:${clientIp(req)}:${invoiceId(req)}`);
  app.get("/api/public/shops/:slug", read, async (req) => {
    const params = req.params as { slug: string };
    return getPublicShop(db, params.slug);
  });

  app.post("/api/public/invoices", create, async (req, reply) => {
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
    return reply.code(201).send({ invoice });
  });

  app.get("/api/public/invoices/:id", poll, async (req) => {
    const params = req.params as { id: string };
    return getPublicInvoice(db, bitnob, config, polls, params.id);
  });

  app.post("/api/public/invoices/:id/pay", pay, async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { method?: string };
    const view = payPublicInvoice(db, bitnob, config, polls, params.id, String(body.method ?? ""));
    return reply.code(202).send(view);
  });

  app.get("/api/public/shares/:token", read, async (req) => {
    const params = req.params as { token: string };
    return readPublicShare(db, params.token, config.now());
  });
}
