import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { ulid } from "../ids.js";
import { makeRequireAuth } from "../auth/require-auth.js";
import { dashboardFromSales, type DashboardRange } from "../modules/analytics/dashboard.js";
import type { SalePoint } from "../modules/analytics/types.js";
import { toInvoiceJson, type InvoiceRow } from "../modules/invoices/service.js";
import { scoreFromSales, type ScoreResult } from "../modules/score/formula.js";

function loadSales(db: Database, merchantId: string): SalePoint[] {
  const rows = db
    .prepare(
      `SELECT i.amount_xof AS amountXof, i.status AS status, i.paid_at AS paidAt, i.created_at AS createdAt,
              i.source AS source, p.payer_ref AS payerKey, p.nickname AS nickname
       FROM invoices i
       LEFT JOIN payers p ON p.id = i.payer_id
       WHERE i.merchant_id = ?`,
    )
    .all(merchantId) as {
    amountXof: number;
    status: SalePoint["status"];
    paidAt: string | null;
    createdAt: string;
    source: "live" | "seed";
    payerKey: string | null;
    nickname: string | null;
  }[];
  return rows.map((row) => ({
    at: row.paidAt ?? row.createdAt,
    createdAt: row.createdAt,
    amountXof: row.amountXof,
    status: row.status,
    payerKey: row.payerKey,
    nickname: row.nickname,
    source: row.source,
  }));
}

function persistScore(db: Database, merchantId: string, score: ScoreResult, now: Date): string {
  const id = ulid(now.getTime());
  db.prepare(
    `INSERT INTO credit_scores (id, merchant_id, computed_at, window_days, score, band, eligible, components)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, merchantId, now.toISOString(), score.windowDays, score.score, score.band, score.eligible ? 1 : 0, JSON.stringify(score));
  return id;
}

function scorePayload(score: ScoreResult, now: Date) {
  return {
    score: score.score,
    band: score.band,
    eligible: score.eligible,
    components: score.components,
    actions: score.actions.map((action) => ({ text: action.text, points: action.points })),
    progress: { days: score.progress.days, sales: score.progress.sales, daysRequired: 14, salesRequired: 20 },
    windowDays: score.windowDays,
    computedAt: now.toISOString(),
  };
}

function parseRange(value: unknown): DashboardRange {
  if (value === "7d" || value === "30d" || value === "today") return value;
  if (value === undefined) return "today";
  throw new AppError(400, "VALIDATION", "Période invalide.", { fields: { range: "today, 7d ou 30d" } });
}

export function registerAnalyticsRoutes(app: FastifyInstance, db: Database, config: AppConfig): void {
  const requireAuth = makeRequireAuth(db, config);

  app.get("/api/dashboard", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const query = req.query as { range?: string };
    const range = parseRange(query.range);
    return dashboardFromSales(loadSales(db, req.auth.merchantId), range, config.now());
  });

  app.get("/api/score", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const now = config.now();
    const score = scoreFromSales(loadSales(db, req.auth.merchantId), now);
    persistScore(db, req.auth.merchantId, score, now);
    return scorePayload(score, now);
  });

  app.post("/api/score/share", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const now = config.now();
    const score = scoreFromSales(loadSales(db, req.auth.merchantId), now);
    const scoreId = persistScore(db, req.auth.merchantId, score, now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
    db.prepare(
      `INSERT INTO score_shares (token_id, merchant_id, score_id, expires_at, revoked) VALUES (?, ?, ?, ?, 0)`,
    ).run(token, req.auth.merchantId, scoreId, expiresAt);
    const path = `/s/${token}`;
    return { url: config.publicUrl ? `${config.publicUrl}${path}` : path };
  });

  app.get("/api/sales", { preHandler: requireAuth }, async (req) => {
    if (!req.auth) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");
    const query = req.query as { from?: string; to?: string };
    const rows = db
      .prepare("SELECT * FROM invoices WHERE merchant_id = ? ORDER BY created_at DESC")
      .all(req.auth.merchantId) as InvoiceRow[];
    const items = rows
      .filter((row) => {
        const at = Date.parse(row.paid_at ?? row.created_at);
        if (query.from && at < Date.parse(query.from)) return false;
        if (query.to && at > Date.parse(query.to)) return false;
        return true;
      })
      .map((row) => toInvoiceJson(row, false));
    return { items };
  });
}

export function readPublicShare(db: Database, token: string, now: Date) {
  const share = db
    .prepare(
      `SELECT s.expires_at AS expiresAt, s.revoked AS revoked, m.display_name AS shopName,
              c.components AS components, c.computed_at AS computedAt
       FROM score_shares s
       JOIN merchants m ON m.id = s.merchant_id
       JOIN credit_scores c ON c.id = s.score_id
       WHERE s.token_id = ?`,
    )
    .get(token) as
    | { expiresAt: string; revoked: number; shopName: string; components: string; computedAt: string }
    | undefined;
  if (!share || share.revoked || share.expiresAt <= now.toISOString()) {
    throw new AppError(404, "NOT_FOUND", "Attestation introuvable.");
  }
  const score = JSON.parse(share.components) as ScoreResult;
  return {
    shopName: share.shopName,
    score: score.score,
    band: score.band,
    periodDays: score.windowDays,
    salesCount: score.progress.sales,
    computedAt: share.computedAt,
    expiresAt: share.expiresAt,
  };
}
