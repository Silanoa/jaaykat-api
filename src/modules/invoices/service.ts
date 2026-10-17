import type { Database } from "better-sqlite3";
import type { BitnobClient, LightningInvoice } from "../../bitnob/types.js";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { ulid } from "../../ids.js";
import { assertSatsInRange, pricedRate, xofToSats } from "../rates/convert.js";
import type { RateCache } from "../rates/service.js";

const IDEMPOTENCY_MS = 10 * 60 * 1000;

export interface InvoiceRow {
  id: string;
  merchant_id: string;
  payer_id: string | null;
  reference: string;
  idempotency_key: string | null;
  bitnob_invoice_id: string | null;
  payment_hash: string | null;
  bolt11: string | null;
  amount_sats: number;
  amount_xof: number;
  rate_btc_xof: number;
  rate_source: string;
  description: string | null;
  channel: "dynamic" | "static_qr";
  status: "creating" | "pending" | "paid" | "expired" | "failed";
  settle_method: string | null;
  preimage: string | null;
  source: "live" | "seed";
  created_at: string;
  expires_at: string | null;
  paid_at: string | null;
}

export interface InvoicePolls {
  lastFetch: Map<string, number>;
  lastSeen: Map<string, number>;
}

export interface InvoiceJson {
  id: string;
  status: InvoiceRow["status"];
  amountXof: number;
  amountSats: number;
  bolt11: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  label: string | null;
  channel: InvoiceRow["channel"];
  source: InvoiceRow["source"];
  reference: string;
  simulated: boolean;
}

export function toInvoiceJson(row: InvoiceRow, simulated: boolean): InvoiceJson {
  return {
    id: row.id,
    status: row.status,
    amountXof: row.amount_xof,
    amountSats: row.amount_sats,
    bolt11: row.bolt11,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    label: row.description,
    channel: row.channel,
    source: row.source,
    reference: row.reference,
    simulated: simulated && row.source === "live",
  };
}

function loadInvoice(db: Database, id: string): InvoiceRow | undefined {
  return db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
}

export function applyRemoteStatus(
  db: Database,
  row: InvoiceRow,
  remote: LightningInvoice,
  method: "poll" | "webhook" | "reconcile",
  now: Date,
): InvoiceRow {
  if (row.status === "paid") return row;
  if (remote.status === "paid") {
    db.prepare(
      `UPDATE invoices
       SET status = 'paid', paid_at = ?, settle_method = ?, preimage = COALESCE(?, preimage),
           payment_hash = COALESCE(payment_hash, ?)
       WHERE id = ? AND status != 'paid'`,
    ).run(now.toISOString(), method, remote.preimage ?? null, remote.paymentHash, row.id);
  } else if ((remote.status === "expired" || remote.status === "failed") && row.status === "pending") {
    db.prepare("UPDATE invoices SET status = ?, settle_method = ? WHERE id = ? AND status = 'pending'").run(
      remote.status,
      method,
      row.id,
    );
  }
  return loadInvoice(db, row.id) ?? row;
}

async function confirmIfDue(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  polls: InvoicePolls,
  row: InvoiceRow,
  method: "poll" | "reconcile",
): Promise<InvoiceRow> {
  if (row.status !== "pending" || !row.bitnob_invoice_id || row.source !== "live") return row;
  const nowMs = config.now().getTime();
  const last = polls.lastFetch.get(row.id) ?? 0;
  if (nowMs - last < 2000) return row;
  polls.lastFetch.set(row.id, nowMs);
  const remote = await bitnob.lightning.getInvoice(row.bitnob_invoice_id);
  return applyRemoteStatus(db, row, remote, method, config.now());
}

export async function createMerchantInvoice(
  db: Database,
  bitnob: BitnobClient,
  rates: RateCache,
  config: AppConfig,
  merchantId: string,
  input: { amountXof: number; label?: string | null },
  idempotencyKey: string,
): Promise<{ invoice: InvoiceJson; created: boolean }> {
  if (!idempotencyKey.trim()) {
    throw new AppError(400, "VALIDATION", "Idempotency-Key requise.");
  }
  if (!Number.isInteger(input.amountXof) || input.amountXof <= 0) {
    throw new AppError(400, "VALIDATION", "Montant invalide.");
  }
  const now = config.now();
  const since = new Date(now.getTime() - IDEMPOTENCY_MS).toISOString();
  const existing = db
    .prepare(
      `SELECT * FROM invoices
       WHERE merchant_id = ? AND idempotency_key = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(merchantId, idempotencyKey, since) as InvoiceRow | undefined;
  if (existing && (existing.status === "pending" || existing.status === "paid" || existing.status === "expired")) {
    return { invoice: toInvoiceJson(existing, config.autoSettle), created: false };
  }
  if (existing && (existing.status === "creating" || existing.status === "failed")) {
    const refreshed = await sendToBitnob(db, bitnob, config, existing);
    return { invoice: toInvoiceJson(refreshed, config.autoSettle), created: true };
  }

  const merchant = db.prepare("SELECT id, slug, bitnob_customer_id FROM merchants WHERE id = ?").get(merchantId) as
    | { id: string; slug: string; bitnob_customer_id: string | null }
    | undefined;
  if (!merchant) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");

  const snapshot = await rates.get(db, bitnob, now.getTime());
  const direct = snapshot.btcXof;
  const priced = direct
    ? { rateBtcXof: direct.sell, source: "btc_xof" as const }
    : pricedRate(snapshot.btcUsd.sell, snapshot.usdXof.buy);
  const sats = xofToSats(input.amountXof, priced.rateBtcXof);
  try {
    assertSatsInRange(sats, priced.rateBtcXof);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Montant invalide.";
    throw new AppError(400, "VALIDATION", message);
  }

  const id = ulid(now.getTime());
  const reference = `jk_${merchant.slug}_${ulid(now.getTime())}`;
  const createdAt = now.toISOString();
  db.prepare(
    `INSERT INTO invoices (
       id, merchant_id, reference, idempotency_key, amount_sats, amount_xof, rate_btc_xof, rate_source,
       description, channel, status, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dynamic', 'creating', 'live', ?)`,
  ).run(
    id,
    merchantId,
    reference,
    idempotencyKey,
    sats,
    input.amountXof,
    priced.rateBtcXof,
    priced.source,
    input.label?.trim() || null,
    createdAt,
  );
  const row = loadInvoice(db, id);
  if (!row) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  const refreshed = await sendToBitnob(db, bitnob, config, row, merchant.bitnob_customer_id);
  return { invoice: toInvoiceJson(refreshed, config.autoSettle), created: true };
}

async function sendToBitnob(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  row: InvoiceRow,
  customerId?: string | null,
): Promise<InvoiceRow> {
  const merchant =
    customerId === undefined
      ? (db.prepare("SELECT bitnob_customer_id FROM merchants WHERE id = ?").get(row.merchant_id) as
          | { bitnob_customer_id: string | null }
          | undefined)
      : { bitnob_customer_id: customerId };
  try {
    const remote = await bitnob.lightning.createInvoice({
      amountSats: row.amount_sats,
      description: row.description ?? row.reference,
      reference: row.reference,
      customerId: merchant?.bitnob_customer_id ?? undefined,
      expirySeconds: 900,
      autoSettle: config.autoSettle,
    });
    db.prepare(
      `UPDATE invoices
       SET status = 'pending', bitnob_invoice_id = ?, payment_hash = ?, bolt11 = ?, expires_at = ?
       WHERE id = ?`,
    ).run(remote.id, remote.paymentHash, remote.bolt11, remote.expiresAt.toISOString(), row.id);
    const updated = loadInvoice(db, row.id);
    if (!updated) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    return updated;
  } catch (error) {
    db.prepare("UPDATE invoices SET status = 'failed' WHERE id = ? AND status IN ('creating', 'failed')").run(row.id);
    const correlationId =
      error instanceof Error && "correlationId" in error && typeof error.correlationId === "string"
        ? error.correlationId
        : undefined;
    throw new AppError(502, "BITNOB_UNAVAILABLE", "La facture n'a pas pu être créée.", {
      ...(correlationId ? { correlationId } : {}),
    });
  }
}

export async function getMerchantInvoice(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  polls: InvoicePolls,
  merchantId: string,
  invoiceId: string,
): Promise<InvoiceJson> {
  const row = loadInvoice(db, invoiceId);
  if (!row || row.merchant_id !== merchantId) {
    throw new AppError(404, "NOT_FOUND", "Facture introuvable.");
  }
  polls.lastSeen.set(row.id, config.now().getTime());
  const refreshed = await confirmIfDue(db, bitnob, config, polls, row, "poll");
  return toInvoiceJson(refreshed, config.autoSettle);
}
