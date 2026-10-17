import { createHmac } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { BitnobClient, LightningInvoice } from "../../bitnob/types.js";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { ulid } from "../../ids.js";
import { normalizeSnPhone } from "../../auth/phone.js";
import { assertSatsInRange, pricedRate, xofToSats } from "../rates/convert.js";
import type { RateCache } from "../rates/service.js";

const IDEMPOTENCY_MS = 10 * 60 * 1000;
const INVOICE_TTL_MS = 15 * 60 * 1000;
const PAY_METHODS = ["wave", "orange", "free", "expresso"] as const;

export type PayMethod = (typeof PAY_METHODS)[number];

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
  simulated_method: string | null;
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
  paymentHash: string | null;
  simulated: boolean;
  demoPayment: boolean;
  payMethod: PayMethod | null;
  payUrl: string | null;
}

export interface PublicInvoiceJson {
  status: InvoiceRow["status"];
  amountXof: number;
  expiresAt: string | null;
  demoPayment: boolean;
  payMethod: PayMethod | null;
}

function isPayMethod(value: string): value is PayMethod {
  return (PAY_METHODS as readonly string[]).includes(value);
}

function readPayMethod(value: string | null): PayMethod | null {
  if (value !== null && isPayMethod(value)) return value;
  return null;
}

function isDemoPayment(config: AppConfig, row: InvoiceRow): boolean {
  return config.demoPayMode === "manual" && row.source === "live";
}

function simulatedOf(config: AppConfig, row: InvoiceRow): boolean {
  if (row.source !== "live") return false;
  if (config.demoPayMode === "manual") return true;
  return config.autoSettle;
}

function invoicePayUrl(config: AppConfig, slug: string, row: InvoiceRow): string | null {
  if (!isDemoPayment(config, row)) return null;
  const path = `/p/${slug}?facture=${row.id}`;
  return config.publicUrl ? `${config.publicUrl}${path}` : path;
}

export function toInvoiceJson(row: InvoiceRow, config: AppConfig, slug: string): InvoiceJson {
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
    paymentHash: row.payment_hash,
    simulated: simulatedOf(config, row),
    demoPayment: isDemoPayment(config, row),
    payMethod: readPayMethod(row.simulated_method),
    payUrl: invoicePayUrl(config, slug, row),
  };
}

function present(db: Database, config: AppConfig, row: InvoiceRow): InvoiceJson {
  const merchant = db.prepare("SELECT slug FROM merchants WHERE id = ?").get(row.merchant_id) as
    | { slug: string }
    | undefined;
  return toInvoiceJson(row, config, merchant?.slug ?? "");
}

function publicView(config: AppConfig, row: InvoiceRow): PublicInvoiceJson {
  return {
    status: row.status,
    amountXof: row.amount_xof,
    expiresAt: row.expires_at,
    demoPayment: isDemoPayment(config, row),
    payMethod: readPayMethod(row.simulated_method),
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
    return { invoice: present(db, config, existing), created: false };
  }
  if (existing && (existing.status === "creating" || existing.status === "failed")) {
    const refreshed = await sendToBitnob(db, bitnob, config, existing);
    return { invoice: present(db, config, refreshed), created: true };
  }

  const merchant = db.prepare("SELECT id, slug, bitnob_customer_id FROM merchants WHERE id = ?").get(merchantId) as
    | { id: string; slug: string; bitnob_customer_id: string | null }
    | undefined;
  if (!merchant) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");

  const priced = await quoteAmount(db, bitnob, rates, input.amountXof, now);

  const id = ulid(now.getTime());
  const reference = `jk_${merchant.slug}_${ulid(now.getTime())}`;
  const createdAt = now.toISOString();
  if (config.demoPayMode === "manual") {
    db.prepare(
      `INSERT INTO invoices (
         id, merchant_id, reference, idempotency_key, amount_sats, amount_xof, rate_btc_xof, rate_source,
         description, channel, status, source, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dynamic', 'pending', 'live', ?, ?)`,
    ).run(
      id,
      merchantId,
      reference,
      idempotencyKey,
      priced.sats,
      input.amountXof,
      priced.rateBtcXof,
      priced.source,
      input.label?.trim() || null,
      createdAt,
      new Date(now.getTime() + INVOICE_TTL_MS).toISOString(),
    );
    const pending = loadInvoice(db, id);
    if (!pending) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    return { invoice: present(db, config, pending), created: true };
  }
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
    priced.sats,
    input.amountXof,
    priced.rateBtcXof,
    priced.source,
    input.label?.trim() || null,
    createdAt,
  );
  const row = loadInvoice(db, id);
  if (!row) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  const refreshed = await sendToBitnob(db, bitnob, config, row, merchant.bitnob_customer_id);
  return { invoice: present(db, config, refreshed), created: true };
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
  return present(db, config, refreshed);
}

async function quoteAmount(
  db: Database,
  bitnob: BitnobClient,
  rates: RateCache,
  amountXof: number,
  now: Date,
): Promise<{ sats: number; rateBtcXof: number; source: string }> {
  if (!Number.isInteger(amountXof) || amountXof <= 0) {
    throw new AppError(400, "VALIDATION", "Montant invalide.");
  }
  const snapshot = await rates.get(db, bitnob, now.getTime());
  const direct = snapshot.btcXof;
  const priced = direct
    ? { rateBtcXof: direct.sell, source: "btc_xof" }
    : pricedRate(snapshot.btcUsd.sell, snapshot.usdXof.buy);
  const sats = xofToSats(amountXof, priced.rateBtcXof);
  try {
    assertSatsInRange(sats, priced.rateBtcXof);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Montant invalide.";
    throw new AppError(400, "VALIDATION", message);
  }
  return { sats, rateBtcXof: priced.rateBtcXof, source: priced.source };
}

function rememberPayer(
  db: Database,
  config: AppConfig,
  merchantId: string,
  input: { payerName?: string; payerPhone?: string; deviceId?: string },
  now: Date,
): string | null {
  const phone = input.payerPhone ? normalizeSnPhone(input.payerPhone) : null;
  if (input.payerPhone && !phone) {
    throw new AppError(400, "VALIDATION", "Vérifiez les champs.", { fields: { payerPhone: "Numéro invalide" } });
  }
  const payerRef = phone
    ? createHmac("sha256", config.payerPepper).update(phone).digest("hex")
    : input.deviceId
      ? `device:${input.deviceId.slice(0, 80)}`
      : null;
  if (!payerRef) return null;
  const nickname = input.payerName?.trim() || null;
  const existing = db.prepare("SELECT id FROM payers WHERE merchant_id = ? AND payer_ref = ?").get(merchantId, payerRef) as
    | { id: string }
    | undefined;
  const seen = now.toISOString();
  if (existing) {
    db.prepare("UPDATE payers SET last_seen_at = ?, nickname = COALESCE(?, nickname) WHERE id = ?").run(
      seen,
      nickname,
      existing.id,
    );
    return existing.id;
  }
  const id = ulid(now.getTime());
  db.prepare(
    `INSERT INTO payers (id, merchant_id, payer_ref, nickname, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, merchantId, payerRef, nickname, seen, seen);
  return id;
}

export async function getPublicShop(db: Database, slug: string): Promise<{ name: string; category: string | null }> {
  const row = db.prepare("SELECT display_name, category FROM merchants WHERE slug = ?").get(slug) as
    | { display_name: string; category: string | null }
    | undefined;
  if (!row) throw new AppError(404, "NOT_FOUND", "Boutique introuvable.");
  return { name: row.display_name, category: row.category ?? "autre" };
}

export async function createPublicInvoice(
  db: Database,
  bitnob: BitnobClient,
  rates: RateCache,
  config: AppConfig,
  input: { slug: string; amountXof: number; payerName?: string; payerPhone?: string; deviceId?: string },
): Promise<InvoiceJson> {
  const merchant = db
    .prepare("SELECT id, slug, bitnob_customer_id FROM merchants WHERE slug = ?")
    .get(input.slug) as { id: string; slug: string; bitnob_customer_id: string | null } | undefined;
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Boutique introuvable.");
  const now = config.now();
  const priced = await quoteAmount(db, bitnob, rates, input.amountXof, now);
  const payerId = rememberPayer(db, config, merchant.id, input, now);
  const id = ulid(now.getTime());
  const reference = `jk_${merchant.slug}_${ulid(now.getTime())}`;
  const createdAt = now.toISOString();
  if (config.demoPayMode === "manual") {
    db.prepare(
      `INSERT INTO invoices (
         id, merchant_id, payer_id, reference, amount_sats, amount_xof, rate_btc_xof, rate_source,
         description, channel, status, source, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'static_qr', 'pending', 'live', ?, ?)`,
    ).run(
      id,
      merchant.id,
      payerId,
      reference,
      priced.sats,
      input.amountXof,
      priced.rateBtcXof,
      priced.source,
      createdAt,
      new Date(now.getTime() + INVOICE_TTL_MS).toISOString(),
    );
    const pending = loadInvoice(db, id);
    if (!pending) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    return present(db, config, pending);
  }
  db.prepare(
    `INSERT INTO invoices (
       id, merchant_id, payer_id, reference, amount_sats, amount_xof, rate_btc_xof, rate_source,
       description, channel, status, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'static_qr', 'creating', 'live', ?)`,
  ).run(id, merchant.id, payerId, reference, priced.sats, input.amountXof, priced.rateBtcXof, priced.source, createdAt);
  const row = loadInvoice(db, id);
  if (!row) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  const refreshed = await sendToBitnob(db, bitnob, config, row, merchant.bitnob_customer_id);
  return present(db, config, refreshed);
}

export async function getPublicInvoice(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  polls: InvoicePolls,
  invoiceId: string,
): Promise<PublicInvoiceJson> {
  const row = loadInvoice(db, invoiceId);
  if (!row || row.source !== "live") throw new AppError(404, "NOT_FOUND", "Facture introuvable.");
  polls.lastSeen.set(row.id, config.now().getTime());
  const refreshed = await confirmIfDue(db, bitnob, config, polls, row, "poll");
  return publicView(config, refreshed);
}

function assertPayable(db: Database, row: InvoiceRow, now: Date): void {
  if (row.status === "paid") throw new AppError(409, "ALREADY_PAID", "Cette facture est déjà payée.");
  const expired = row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime();
  if (row.status === "expired" || expired || row.status !== "pending") {
    if (row.status === "pending") {
      db.prepare("UPDATE invoices SET status = 'expired' WHERE id = ? AND status = 'pending'").run(row.id);
    }
    throw new AppError(409, "EXPIRED", "Cette facture a expiré.");
  }
}

export async function payPublicInvoice(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  invoiceId: string,
  method: string,
): Promise<PublicInvoiceJson> {
  if (config.demoPayMode !== "manual") {
    throw new AppError(404, "NOT_FOUND", "Paiement simulé indisponible.");
  }
  if (!isPayMethod(method)) {
    throw new AppError(400, "VALIDATION", "Moyen de paiement invalide.");
  }
  const row = loadInvoice(db, invoiceId);
  if (!row || row.source !== "live") throw new AppError(404, "NOT_FOUND", "Facture introuvable.");
  const now = config.now();
  assertPayable(db, row, now);
  if (row.bitnob_invoice_id || row.simulated_method) return publicView(config, row);

  const claim = db
    .prepare(
      `UPDATE invoices SET simulated_method = ?
       WHERE id = ? AND status = 'pending' AND simulated_method IS NULL AND bitnob_invoice_id IS NULL`,
    )
    .run(method, row.id);
  if (claim.changes === 0) {
    const current = loadInvoice(db, row.id);
    if (!current || current.source !== "live") throw new AppError(404, "NOT_FOUND", "Facture introuvable.");
    assertPayable(db, current, now);
    return publicView(config, current);
  }

  const merchant = db.prepare("SELECT bitnob_customer_id FROM merchants WHERE id = ?").get(row.merchant_id) as
    | { bitnob_customer_id: string | null }
    | undefined;
  const remainingMs = row.expires_at ? Date.parse(row.expires_at) - now.getTime() : 0;
  const expirySeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  try {
    const remote = await bitnob.lightning.createInvoice({
      amountSats: row.amount_sats,
      description: row.description ?? row.reference,
      reference: row.reference,
      customerId: merchant?.bitnob_customer_id ?? undefined,
      expirySeconds,
      autoSettle: true,
    });
    db.prepare("UPDATE invoices SET bitnob_invoice_id = ?, payment_hash = ?, bolt11 = ? WHERE id = ?").run(
      remote.id,
      remote.paymentHash,
      remote.bolt11,
      row.id,
    );
  } catch (error) {
    db.prepare("UPDATE invoices SET simulated_method = NULL WHERE id = ? AND bitnob_invoice_id IS NULL").run(row.id);
    const correlationId =
      error instanceof Error && "correlationId" in error && typeof error.correlationId === "string"
        ? error.correlationId
        : undefined;
    throw new AppError(502, "BITNOB_UNAVAILABLE", "La facture n'a pas pu être créée.", {
      ...(correlationId ? { correlationId } : {}),
    });
  }
  const updated = loadInvoice(db, row.id);
  if (!updated) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  return publicView(config, updated);
}
