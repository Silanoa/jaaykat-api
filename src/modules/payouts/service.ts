import type { Database } from "better-sqlite3";
import { maskPhone } from "../../auth/phone.js";
import type { BitnobClient, PayoutStatus, SnNetwork } from "../../bitnob/types.js";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../errors.js";
import { ulid } from "../../ids.js";

const IDEMPOTENCY_MS = 10 * 60 * 1000;
const XOF_PER_STABLE = 590;
const pendingAccounts = new Map<string, string>();
const ACCOUNT = /^(\+?221)?(7\d{8})$/;
const NETWORKS = ["wave", "orange", "free", "expresso"] as const;

export interface PayoutRow {
  id: string;
  merchant_id: string;
  reference: string;
  idempotency_key: string | null;
  bitnob_quote_id: string | null;
  bitnob_payout_id: string | null;
  network: SnNetwork;
  account_number_masked: string;
  account_name: string;
  amount_xof: number;
  from_asset: string;
  from_amount: string | null;
  exchange_rate: string | null;
  fees: string | null;
  quote_expires_at: string | null;
  status: "quoted" | "initiated" | "processing" | "completed" | "failed" | "expired";
  created_at: string;
  updated_at: string;
}

export interface PayoutPolls {
  lastFetch: Map<string, number>;
}

export function ledgerOf(db: Database, merchantId: string, now: Date): { balanceXof: number; balanceSats: number } {
  expireQuoted(db, merchantId, now);
  const gross = db
    .prepare(
      `SELECT COALESCE(SUM(amount_xof), 0) AS xof, COALESCE(SUM(amount_sats), 0) AS sats
       FROM invoices WHERE merchant_id = ? AND status = 'paid' AND source = 'live'`,
    )
    .get(merchantId) as { xof: number; sats: number };
  const reserved = db
    .prepare(
      `SELECT COALESCE(SUM(amount_xof), 0) AS xof FROM payouts
       WHERE merchant_id = ? AND status NOT IN ('failed', 'expired')`,
    )
    .get(merchantId) as { xof: number };
  const balanceXof = gross.xof - reserved.xof;
  const balanceSats = gross.xof === 0 || balanceXof <= 0 ? 0 : Math.round((gross.sats * balanceXof) / gross.xof);
  return { balanceXof, balanceSats };
}

export function balanceView(db: Database, merchantId: string, now: Date) {
  const ledger = ledgerOf(db, merchantId, now);
  const lastPayouts = (
    db
      .prepare(
        `SELECT id, amount_xof AS amountXof, network, status, created_at AS createdAt
         FROM payouts WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 5`,
      )
      .all(merchantId) as { id: string; amountXof: number; network: SnNetwork; status: PayoutRow["status"]; createdAt: string }[]
  );
  return { ...ledger, lastPayouts };
}

export async function quotePayout(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  merchantId: string,
  input: { amountXof: number; network: string; accountNumber: string; accountName: string },
) {
  const network = input.network === "yas" ? "free" : input.network;
  const fields: Record<string, string> = {};
  if (!Number.isInteger(input.amountXof) || input.amountXof < 100 || input.amountXof > 200_000) {
    fields.amountXof = "Entre 100 et 200 000 F";
  }
  if (!isNetwork(network)) fields.network = "Choisissez Wave, Orange, Yas ou Expresso";
  const account = normalizeAccount(input.accountNumber);
  if (!account) fields.accountNumber = "Numéro sénégalais invalide";
  const accountName = input.accountName.trim();
  if (accountName.length < 2 || accountName.length > 80) fields.accountName = "Nom du bénéficiaire requis";
  if (Object.keys(fields).length > 0 || !account || !isNetwork(network)) {
    throw new AppError(400, "VALIDATION", "Vérifiez les champs.", { fields });
  }
  const now = config.now();
  const ledger = ledgerOf(db, merchantId, now);
  if (input.amountXof > ledger.balanceXof) {
    throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde insuffisant. L'historique simulé n'est pas retirable.");
  }
  const merchant = db.prepare("SELECT id, slug, display_name, bitnob_customer_id FROM merchants WHERE id = ?").get(merchantId) as
    | { id: string; slug: string; display_name: string; bitnob_customer_id: string | null }
    | undefined;
  if (!merchant) throw new AppError(401, "UNAUTHENTICATED", "Connexion requise.");

  const id = ulid(now.getTime());
  const reference = `jk_${merchant.slug}_${ulid(now.getTime() + 1)}`;
  const masked = maskPhone(`+221${account}`);
  const createdAt = now.toISOString();
  db.prepare(
    `INSERT INTO payouts (
       id, merchant_id, reference, network, account_number_masked, account_name, amount_xof,
       from_asset, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
    ).run(id, merchantId, reference, network, masked, accountName, input.amountXof, config.payoutFromAsset, createdAt, createdAt);
  pendingAccounts.set(id, account);

  try {
    const quoteInput = {
      country: "SN",
      fromAsset: config.payoutFromAsset,
      toCurrency: "XOF",
      source: "offchain" as const,
    };
    let quotedReference = reference;
    let remote = await bitnob.payouts.quote({
      ...quoteInput,
      amount: (input.amountXof / XOF_PER_STABLE).toFixed(6),
      reference,
    });
    const rate = Number(remote.exchangeRate);
    const settled = Number(remote.settlementAmount);
    if (rate > 0 && settled > 0 && Math.abs(settled - input.amountXof) >= 0.5) {
      quotedReference = `${reference}_r`;
      remote = await bitnob.payouts.quote({
        ...quoteInput,
        amount: (Math.ceil((input.amountXof / rate) * 1e6) / 1e6).toFixed(6),
        reference: quotedReference,
      });
    }
    db.prepare(
      `UPDATE payouts
       SET reference = ?, bitnob_quote_id = ?, from_amount = ?, exchange_rate = ?, fees = ?, quote_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      quotedReference,
      remote.id,
      remote.fromAmount,
      remote.exchangeRate,
      remote.fees,
      remote.expiresAt.toISOString(),
      now.toISOString(),
      id,
    );
    const row = loadPayout(db, id);
    if (!row) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    return presentQuote(row, Number(remote.settlementAmount));
  } catch (error) {
    pendingAccounts.delete(id);
    db.prepare("UPDATE payouts SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'quoted'").run(now.toISOString(), id);
    if (error instanceof AppError) throw error;
    throw new AppError(502, "BITNOB_UNAVAILABLE", "Le devis n'a pas pu être créé.");
  }
}

export async function confirmPayout(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  merchantId: string,
  quoteId: string,
  idempotencyKey: string,
): Promise<{ payout: ReturnType<typeof presentPayout>; created: boolean }> {
  if (!idempotencyKey.trim()) throw new AppError(400, "VALIDATION", "Idempotency-Key requise.");
  const now = config.now();
  expireQuoted(db, merchantId, now);
  const since = new Date(now.getTime() - IDEMPOTENCY_MS).toISOString();
  const replay = db
    .prepare(
      `SELECT * FROM payouts WHERE merchant_id = ? AND idempotency_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(merchantId, idempotencyKey, since) as PayoutRow | undefined;
  if (replay) {
    const advanced = await advance(db, bitnob, config, replay);
    return { payout: presentPayout(advanced), created: false };
  }
  const row = loadPayout(db, quoteId);
  if (!row || row.merchant_id !== merchantId) throw new AppError(404, "NOT_FOUND", "Devis introuvable.");
  if (row.status === "expired") {
    throw new AppError(409, "QUOTE_EXPIRED", "Ce devis a expiré. Demandez-en un nouveau.");
  }
  if (row.status !== "quoted" && row.status !== "initiated") {
    return { payout: presentPayout(row), created: false };
  }
  db.prepare(
    `UPDATE payouts SET idempotency_key = ? WHERE id = ? AND (idempotency_key IS NULL OR idempotency_key = ?)`,
  ).run(idempotencyKey, row.id, idempotencyKey);
  const current = loadPayout(db, row.id);
  if (!current) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  const created = current.status === "quoted";
  const advanced = await advance(db, bitnob, config, current);
  return { payout: presentPayout(advanced), created };
}

export async function getPayout(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  polls: PayoutPolls,
  merchantId: string,
  payoutId: string,
) {
  const row = loadPayout(db, payoutId);
  if (!row || row.merchant_id !== merchantId) throw new AppError(404, "NOT_FOUND", "Retrait introuvable.");
  const nowMs = config.now().getTime();
  if (!row.bitnob_payout_id || row.status === "completed" || row.status === "failed" || row.status === "expired" || row.status === "quoted") {
    return presentPayout(row);
  }
  const last = polls.lastFetch.get(row.id) ?? 0;
  if (nowMs - last < 2000) return presentPayout(row);
  polls.lastFetch.set(row.id, nowMs);
  const remote = await bitnob.payouts.get(row.bitnob_payout_id);
  const next = mapStatus(remote.status);
  if (next && canAdvance(row.status, next)) {
    db.prepare("UPDATE payouts SET status = ?, updated_at = ? WHERE id = ?").run(next, config.now().toISOString(), row.id);
  }
  const refreshed = loadPayout(db, row.id);
  if (!refreshed) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
  return presentPayout(refreshed);
}

function presentQuote(row: PayoutRow, settlement: number) {
  const received = Number.isFinite(settlement) ? Math.round(settlement) : row.amount_xof;
  return {
    id: row.id,
    amountXof: row.amount_xof,
    receivedXof: received,
    exchangeRate: row.exchange_rate ?? "",
    fees: row.fees ?? "0",
    network: row.network,
    accountNumberMasked: row.account_number_masked,
    accountName: row.account_name,
    expiresAt: row.quote_expires_at,
  };
}

function presentPayout(row: PayoutRow) {
  return {
    id: row.id,
    status: row.status,
    amountXof: row.amount_xof,
    network: row.network,
    reference: row.reference,
    failureReason: null as string | null,
  };
}

async function advance(db: Database, bitnob: BitnobClient, config: AppConfig, row: PayoutRow): Promise<PayoutRow> {
  let current = row;
  if (current.status === "quoted") {
    if (!current.bitnob_quote_id) throw new AppError(409, "QUOTE_EXPIRED", "Ce devis a expiré. Demandez-en un nouveau.");
    const account = pendingAccounts.get(current.id);
    if (!account) throw new AppError(409, "QUOTE_EXPIRED", "Ce devis a expiré. Demandez-en un nouveau.");
    const merchant = db.prepare("SELECT display_name, bitnob_customer_id FROM merchants WHERE id = ?").get(current.merchant_id) as
      | { display_name: string; bitnob_customer_id: string | null }
      | undefined;
    try {
      const remote = await bitnob.payouts.initialize(current.bitnob_quote_id, {
        reference: current.reference,
        callbackUrl: config.publicUrl ? `${config.publicUrl}/webhooks/bitnob` : "https://jaaykat.invalid/webhooks/bitnob",
        customerId: merchant?.bitnob_customer_id ?? undefined,
        beneficiary: {
          destination_type: "mobile_money",
          account_name: current.account_name,
          account_number: account,
          network: current.network,
          sender: { account_name: merchant?.display_name ?? current.account_name, country: "SN" },
        },
      });
      pendingAccounts.delete(current.id);
      db.prepare(
        `UPDATE payouts SET status = 'initiated', bitnob_payout_id = ?, updated_at = ? WHERE id = ?`,
      ).run(remote.id, config.now().toISOString(), current.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "BITNOB_UNAVAILABLE", "Le retrait n'a pas pu être envoyé.");
    }
    const reloaded = loadPayout(db, current.id);
    if (!reloaded) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    current = reloaded;
  }
  if (current.status === "initiated") {
    if (!current.bitnob_quote_id) throw new AppError(409, "QUOTE_EXPIRED", "Ce devis a expiré. Demandez-en un nouveau.");
    try {
      const remote = await bitnob.payouts.finalize(current.bitnob_quote_id);
      db.prepare(
        `UPDATE payouts SET status = 'processing', bitnob_payout_id = ?, updated_at = ? WHERE id = ?`,
      ).run(remote.id, config.now().toISOString(), current.id);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "BITNOB_UNAVAILABLE", "Le retrait n'a pas pu être envoyé.");
    }
    const reloaded = loadPayout(db, current.id);
    if (!reloaded) throw new AppError(500, "INTERNAL", "Une erreur est survenue.");
    return reloaded;
  }
  return current;
}

function expireQuoted(db: Database, merchantId: string, now: Date): void {
  db.prepare(
    `UPDATE payouts SET status = 'expired', updated_at = ?
     WHERE merchant_id = ? AND status = 'quoted' AND quote_expires_at IS NOT NULL AND quote_expires_at <= ?`,
  ).run(now.toISOString(), merchantId, now.toISOString());
}

function loadPayout(db: Database, id: string): PayoutRow | undefined {
  return db.prepare("SELECT * FROM payouts WHERE id = ?").get(id) as PayoutRow | undefined;
}

function normalizeAccount(input: string): string | null {
  const match = input.replace(/[\s.-]/g, "").match(ACCOUNT);
  return match?.[2] ?? null;
}

function isNetwork(value: string): value is SnNetwork {
  return (NETWORKS as readonly string[]).includes(value);
}

function mapStatus(status: PayoutStatus): PayoutRow["status"] | null {
  switch (status) {
    case "INITIATED":
    case "PENDING":
      return "initiated";
    case "PROCESSING":
      return "processing";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "QUOTE":
      return null;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function canAdvance(current: PayoutRow["status"], next: PayoutRow["status"]): boolean {
  if (current === "completed" || current === "failed" || current === "expired") return false;
  if (next === "failed" || next === "expired") return true;
  const order = ["quoted", "initiated", "processing", "completed"];
  return order.indexOf(next) >= order.indexOf(current);
}
