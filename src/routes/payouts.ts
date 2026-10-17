import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { resolveBitnobEnv } from "../bitnob/environment.js";
import type { BitnobClient } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { makeRequireAuth } from "../auth/require-auth.js";
import { balanceView, confirmPayout, getPayout, quotePayout, type PayoutPolls } from "../modules/payouts/service.js";
import { RateCache } from "../modules/rates/service.js";

const quoteBody = z.object({
  amountXof: z.number(),
  network: z.string(),
  accountNumber: z.string(),
  accountName: z.string(),
});

const confirmBody = z.object({
  quoteId: z.string().min(1),
});

function idempotencyKey(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? "";
  return header ?? "";
}

export function registerPayoutRoutes(
  app: FastifyInstance,
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  rates: RateCache,
): void {
  const requireAuth = makeRequireAuth(db, config);
  const polls: PayoutPolls = { lastFetch: new Map() };

  app.get("/api/balance", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    return balanceView(db, req.auth.merchantId, config.now());
  });

  app.post("/api/payouts/quote", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const parsed = quoteBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "VALIDATION", "Vérifiez les champs.");
    const quote = await quotePayout(db, bitnob, config, req.auth.merchantId, parsed.data);
    return { quote };
  });

  app.post("/api/payouts", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const parsed = confirmBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, "VALIDATION", "Vérifiez les champs.");
    const result = await confirmPayout(
      db,
      bitnob,
      config,
      req.auth.merchantId,
      parsed.data.quoteId,
      idempotencyKey(req.headers["idempotency-key"]),
    );
    return reply.code(result.created ? 201 : 200).send({ payout: result.payout });
  });

  app.get("/api/payouts/:id", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const params = req.params as { id: string };
    const payout = await getPayout(db, bitnob, config, polls, req.auth.merchantId, params.id);
    return { payout };
  });

  app.get("/api/rates", async () => {
    const snapshot = await rates.get(db, bitnob, config.now().getTime());
    const btcXof = snapshot.btcXof?.sell ?? snapshot.btcUsd.sell * snapshot.usdXof.buy;
    const source = snapshot.btcXof ? "btc_xof" : "btc_usd*usd_xof";
    return {
      btcXof,
      btcUsd: snapshot.btcUsd.sell,
      usdXof: snapshot.usdXof.buy,
      ts: snapshot.fetchedAt.toISOString(),
      validFor: Math.min(snapshot.btcUsd.validForSeconds, snapshot.usdXof.validForSeconds),
      source,
    };
  });

  app.get("/api/system", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const balances = await bitnob.balances.get();
    const lastCalls = db
      .prepare(
        `SELECT at, method, path, status, duration_ms AS durationMs, correlation_id AS correlationId
         FROM api_calls ORDER BY id DESC LIMIT 20`,
      )
      .all() as {
      at: string;
      method: string;
      path: string;
      status: number | null;
      durationMs: number | null;
      correlationId: string | null;
    }[];
    const seed = db
      .prepare("SELECT 1 AS ok FROM invoices WHERE merchant_id = ? AND source = 'seed' LIMIT 1")
      .get(req.auth.merchantId) as { ok: number } | undefined;
    return {
      env: await resolveBitnobEnv(bitnob, config),
      demoPayMode: config.demoPayMode,
      platformBalances: balances.assets,
      lastCalls,
      seedHistory: Boolean(seed),
    };
  });
}
