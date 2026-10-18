import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LiveBitnobClient } from "../src/bitnob/live.js";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => handler(req, res, await readBody(req)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const QUOTE_PAYOUT = {
  id: "01a14eac-5238-7e93-8fad-009c4447dee6",
  quote_id: "QT2_21053315",
  status: "QUOTE",
  source: "OFFCHAIN",
  from_asset: "USDT",
  to_currency: "XOF",
  amount: "2",
  settlement_amount: "1179.58",
  fees: "0",
  exchange_rate: { rate: "590.97", btc_rate: "82067.35", currency: "xof", effective_rate: "589.79" },
  reference: "jk_boutique_01",
  country: "SN",
  expires_at: "2026-10-18T11:17:18.522535Z",
};

const BALANCES = {
  success: true,
  data: {
    accounts: [
      { currency: "BTC", ledger_balance: "1209446", available_balance: "1209446", available_balance_formatted: "0.01209446 BTC" },
      { currency: "USDC", ledger_balance: "0", available_balance: "0", available_balance_formatted: "0.0 USDC" },
      { currency: "USDT", ledger_balance: "0", available_balance: "0", available_balance_formatted: "0.0 USDT" },
    ],
  },
};

describe("retraits Bitnob : formes constatées en sandbox", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  async function clientWith(handler: Parameters<typeof listen>[0]) {
    const fake = await listen(handler);
    closers.push(fake.close);
    return new LiveBitnobClient({ clientId: "c", clientSecret: "s", baseUrl: fake.baseUrl, lookupIp: async () => null, retryDelayMs: 0 });
  }

  it("garde quote_id (QT2_…) comme identifiant du devis, pas l'UUID du payout", async () => {
    const client = await clientWith((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { payout: QUOTE_PAYOUT } }));
    });
    const quote = await client.payouts.quote({
      amount: "2",
      country: "SN",
      fromAsset: "USDT",
      toCurrency: "XOF",
      source: "offchain",
      reference: "jk_boutique_01",
    });
    expect(quote.id).toBe("QT2_21053315");
    expect(quote.settlementAmount).toBe("1179.58");
  });

  it("initialise avec quote_id, motif et bénéficiaire complet, et renvoie l'UUID du payout", async () => {
    let seen: { url?: string; body?: Record<string, unknown> } = {};
    const client = await clientWith((req, res, body) => {
      seen = { url: req.url, body: JSON.parse(body) as Record<string, unknown> };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { payout: { ...QUOTE_PAYOUT, status: "INITIATED", reference: "jk_boutique_01" } } }));
    });
    const payout = await client.payouts.initialize("QT2_21053315", {
      reference: "jk_boutique_01",
      callbackUrl: "https://demo.example/webhooks/bitnob",
      beneficiary: {
        destination_type: "mobile_money",
        country: "SN",
        account_name: "Awa Diop",
        account_number: "771234567",
        network: "free",
        sender: { account_name: "Awa Beauté", country: "SN" },
      },
    });
    expect(seen.url).toBe("/api/payouts/QT2_21053315/initialize");
    expect(seen.body).toMatchObject({
      quote_id: "QT2_21053315",
      reference: "jk_boutique_01",
      payment_reason: "vendor_payment",
      callback_url: "https://demo.example/webhooks/bitnob",
      beneficiary: { destination_type: "mobile_money", country: "SN", network: "free", sender: { country: "SN" } },
    });
    expect(payout).toMatchObject({ id: "01a14eac-5238-7e93-8fad-009c4447dee6", status: "INITIATED", quoteId: "QT2_21053315" });
  });

  it("lit les soldes sous data.accounts avec le montant formaté", async () => {
    const client = await clientWith((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(BALANCES));
    });
    const { assets } = await client.balances.get();
    expect(assets).toEqual([
      { asset: "BTC", available: "0.01209446" },
      { asset: "USDC", available: "0.0" },
      { asset: "USDT", available: "0.0" },
    ]);
  });
});
