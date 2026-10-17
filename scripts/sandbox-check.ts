import { createHmac } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BitnobError } from "../src/bitnob/errors.js";
import { createBitnobClient } from "../src/bitnob/factory.js";
import type { BitnobClient, PayoutAsset } from "../src/bitnob/types.js";
import { verifyWebhookSignature } from "../src/bitnob/webhooks.js";
import { loadConfig } from "../src/config.js";

setDefaultResultOrder("ipv4first");

export interface SandboxCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SandboxReport {
  ip: string;
  checks: SandboxCheck[];
}

export async function fetchOutgoingIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl("https://api.ipify.org", { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) throw new Error(`ipify a répondu ${response.status}`);
  const ip = (await response.text()).trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error("ipify n'a pas renvoyé une IPv4.");
  return ip;
}

export async function runSandboxChecks(input: {
  client: BitnobClient;
  webhookSecret: string;
  fromAsset: PayoutAsset;
  accountNumber?: string;
  paidTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<SandboxCheck[]> {
  return [
    await checkWhoami(input.client),
    await checkAutoSettle(input.client, input.paidTimeoutMs ?? 15_000, input.pollIntervalMs ?? 1_000),
    checkWebhook(input.webhookSecret),
    await checkRates(input.client),
    await checkQuote(input.client, input.fromAsset, input.accountNumber),
    await checkReference(input.client),
    await checkCustomer(input.client),
  ];
}

export function formatReport(report: SandboxReport, secrets: string[] = []): string {
  const lines = [
    "# Constat sandbox Bitnob",
    "",
    `IP sortante : ${report.ip}`,
    "Forcer IPv4 : NODE_OPTIONS=--dns-result-order=ipv4first",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${check.ok ? "OK" : "ÉCHEC"} — ${check.name}`);
    lines.push(redact(check.detail, secrets));
    lines.push("");
  }
  return lines.join("\n");
}

export function reportFailed(checks: SandboxCheck[]): boolean {
  return checks.some((check) => !check.ok);
}

async function checkWhoami(client: BitnobClient): Promise<SandboxCheck> {
  try {
    const who = await client.whoami();
    const ok = who.environment === "sandbox";
    return { name: "whoami", ok, detail: ok ? "environment = sandbox" : `environment = ${who.environment}` };
  } catch (error) {
    return { name: "whoami", ok: false, detail: errorText(error) };
  }
}

async function checkAutoSettle(client: BitnobClient, timeoutMs: number, intervalMs: number): Promise<SandboxCheck> {
  const reference = `jk_probe_settle_${Date.now()}`;
  const started = Date.now();
  try {
    const created = await client.lightning.createInvoice({
      amountSats: 1_000,
      description: "sandbox-check",
      reference,
      expirySeconds: 900,
      autoSettle: true,
    });
    const paid = await client.lightning.waitForPaid(created.id, { timeoutMs, intervalMs });
    const elapsed = Date.now() - started;
    const ok = paid.status === "paid" && elapsed < 15_000;
    return { name: "facture auto_settle", ok, detail: `statut ${paid.status} en ${elapsed} ms` };
  } catch (error) {
    return { name: "facture auto_settle", ok: false, detail: errorText(error) };
  }
}

function checkWebhook(secret: string): SandboxCheck {
  if (!secret) {
    return { name: "webhook", ok: false, detail: "BITNOB_WEBHOOK_SECRET manquant. Nom d'événement : à constater." };
  }
  const raw = Buffer.from('{"event_id":"local","event":"a_constater"}');
  const signature = createHmac("sha512", secret).update(raw).digest("hex");
  const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
  const ok = verifyWebhookSignature(raw, signature, secret) && !verifyWebhookSignature(raw, flipped, secret);
  return {
    name: "webhook",
    ok,
    detail: ok
      ? "Signature HMAC-SHA512 vérifiée localement. Nom d'événement Bitnob : à constater."
      : "La vérification HMAC-SHA512 a échoué. Nom d'événement : à constater.",
  };
}

async function checkRates(client: BitnobClient): Promise<SandboxCheck> {
  try {
    const rates = await client.rates.get();
    const ok = rates.btcUsd.sell > 0 && rates.usdXof.buy > 0;
    return {
      name: "taux BTC/USD/XOF",
      ok,
      detail: `BTC/USD sell ${rates.btcUsd.sell} ; USD/XOF buy ${rates.usdXof.buy} ; BTC/XOF ${rates.btcXof?.sell ?? "absent"}`,
    };
  } catch (error) {
    return { name: "taux BTC/USD/XOF", ok: false, detail: errorText(error) };
  }
}

async function checkQuote(client: BitnobClient, fromAsset: PayoutAsset, accountNumber?: string): Promise<SandboxCheck> {
  const reference = `jk_probe_quote_${Date.now()}`;
  try {
    const quote = await client.payouts.quote({
      amount: "10",
      country: "SN",
      fromAsset,
      toCurrency: "XOF",
      source: "offchain",
      reference,
    });
    if (!quote.id || !quote.settlementAmount) {
      return { name: "devis payout SN", ok: false, detail: "Devis sans identifiant ou sans montant XOF." };
    }
    if (!accountNumber) {
      return {
        name: "devis payout SN",
        ok: true,
        detail: `devis ${quote.id}, règlement ${quote.settlementAmount} ${quote.toCurrency}, taux ${quote.exchangeRate}. initialize/finalize : à constater (SANDBOX_PAYOUT_NUMBER absent).`,
      };
    }
    try {
      const started = await client.payouts.initialize(quote.id, {
        reference,
        callbackUrl: "https://jaaykat.invalid/webhooks/bitnob",
        beneficiary: {
          account_name: "Awa Diop",
          account_number: accountNumber,
          network: "wave",
          sender: { account_name: "Awa Beauté", country: "SN" },
        },
      });
      const finalized = await client.payouts.finalize(quote.id);
      return {
        name: "devis payout SN",
        ok: true,
        detail: `devis ${quote.id}, règlement ${quote.settlementAmount} XOF, initialize ${started.status}, finalize ${finalized.status}.`,
      };
    } catch (error) {
      const status = error instanceof BitnobError ? error.status : 0;
      if (status >= 400 && status < 500) {
        return {
          name: "devis payout SN",
          ok: true,
          detail: `devis ${quote.id}, règlement ${quote.settlementAmount} XOF. initialize/finalize à constater : ${errorText(error)}`,
        };
      }
      return { name: "devis payout SN", ok: false, detail: errorText(error) };
    }
  } catch (error) {
    return { name: "devis payout SN", ok: false, detail: errorText(error) };
  }
}

async function checkReference(client: BitnobClient): Promise<SandboxCheck> {
  const reference = `jk_probe_ref_${Date.now()}`;
  try {
    const first = await client.lightning.createInvoice({
      amountSats: 1_000,
      description: "idempotence",
      reference,
      expirySeconds: 900,
      autoSettle: false,
    });
    const second = await client.lightning.createInvoice({
      amountSats: 1_000,
      description: "idempotence",
      reference,
      expirySeconds: 900,
      autoSettle: false,
    });
    const ok = first.id.length > 0 && first.id === second.id;
    return { name: "idempotence reference", ok, detail: ok ? `même facture ${first.id}` : `identifiants ${first.id} puis ${second.id}` };
  } catch (error) {
    return { name: "idempotence reference", ok: false, detail: errorText(error) };
  }
}

async function checkCustomer(client: BitnobClient): Promise<SandboxCheck> {
  const email = `probe-${Date.now()}@merchants.jaaykat.invalid`;
  try {
    const created = await client.customers.create({ customerType: "individual", email, firstName: "Awa", lastName: "Diop", countryCode: "SEN" });
    return { name: "customer .invalid", ok: created.id.length > 0, detail: created.id ? `client créé, e-mail .invalid accepté` : "identifiant absent" };
  } catch (error) {
    return { name: "customer .invalid", ok: false, detail: errorText(error) };
  }
}

function errorText(error: unknown): string {
  if (error instanceof BitnobError) return `${error.status} ${error.message}`;
  return error instanceof Error ? error.message : "erreur";
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => (secret.length < 4 ? current : current.split(secret).join("[secret]")), text);
}

const isDirectRun = process.argv[1]?.endsWith("sandbox-check.ts") || process.argv[1]?.endsWith("sandbox-check.js");

if (isDirectRun) {
  const config = loadConfig();
  if (config.bitnobMode !== "live") {
    console.error("BITNOB_MODE=live est requis. Le mock ne constate rien sur le sandbox.");
    process.exit(1);
  }
  let ip = "inconnue";
  try {
    ip = await fetchOutgoingIp();
  } catch (error) {
    ip = `inconnue (${error instanceof Error ? error.message : "ipify"})`;
  }
  console.log(`IP sortante : ${ip}`);
  const client = createBitnobClient(config);
  const checks = await runSandboxChecks({
    client,
    webhookSecret: config.webhookSecret,
    fromAsset: config.payoutFromAsset,
    accountNumber: process.env.SANDBOX_PAYOUT_NUMBER,
  });
  const report = formatReport({ ip, checks }, [config.bitnobClientSecret, config.bitnobClientId, config.webhookSecret]);
  const destination = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "sandbox-findings.local.md");
  writeFileSync(destination, report);
  console.log(report);
  console.log(`Rapport : ${destination}`);
  process.exit(reportFailed(checks) ? 1 : 0);
}
