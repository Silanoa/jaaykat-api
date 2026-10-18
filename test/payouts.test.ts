import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { seedDemo } from "../src/db/seed.js";
import { ulid } from "../src/ids.js";

const registerBody = {
  shopName: "Awa Beauté",
  category: "beaute",
  firstName: "Awa",
  lastName: "Diop",
  phone: "77 123 45 67",
  pin: "482915",
};

describe("retraits et ledger", () => {
  const apps: FastifyInstance[] = [];
  const now = new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function config(payoutFromAsset: AppConfig["payoutFromAsset"] = "USDT"): AppConfig {
    return {
      nodeEnv: "test",
      port: 0,
      databasePath: ":memory:",
      publicUrl: "https://demo.example",
      bitnobMode: "mock",
      bitnobBaseUrl: "https://api.bitnob.com",
      bitnobClientId: "mock",
      bitnobClientSecret: "mock",
      webhookSecret: "whsec_test",
      phonePepper: "phone-pepper-0123456789abcdef",
      payerPepper: "payer-pepper-0123456789abcdef",
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: true,
      demoPayMode: "auto",
      payoutFromAsset,
      reconcileIntervalMs: 0,
      now: () => now,
    };
  }

  async function boot(opts?: { payoutRate?: number; payoutFromAsset?: AppConfig["payoutFromAsset"] }) {
    const db = openDatabase(":memory:");
    const bitnob = new MockBitnobClient({
      clientId: "mock",
      clientSecret: "mock",
      settleAfterMs: 0,
      payoutRate: opts?.payoutRate,
      now: () => now.getTime(),
    });
    const cfg = config(opts?.payoutFromAsset);
    const app = await buildApp({ db, bitnob, config: cfg, bitnobEnv: "mock" });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    const merchant = db.prepare("SELECT id FROM merchants").get() as { id: string };
    return { app, db, bitnob, token, merchantId: merchant.id };
  }

  function credit(db: ReturnType<typeof openDatabase>, merchantId: string, amountXof: number, source: "live" | "seed") {
    const rate = 64_000 * 605;
    const sats = Math.round((amountXof / rate) * 1e8);
    db.prepare(
      `INSERT INTO invoices (
         id, merchant_id, reference, amount_sats, amount_xof, rate_btc_xof, rate_source,
         channel, status, source, created_at, paid_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'btc_usd*usd_xof', 'dynamic', 'paid', ?, ?, ?)`,
    ).run(
      ulid(now.getTime() + amountXof + (source === "seed" ? 1 : 2)),
      merchantId,
      `jk_test_${source}_${amountXof}`,
      sats,
      amountXof,
      rate,
      source,
      now.toISOString(),
      now.toISOString(),
    );
    return sats;
  }

  it("refuse de retirer l'historique simulé et ne le compte pas dans le solde", async () => {
    const db = openDatabase(":memory:");
    const cfg = config();
    seedDemo(db, cfg);
    const bitnob = new MockBitnobClient({ clientId: "mock", clientSecret: "mock", settleAfterMs: 0 });
    const app = await buildApp({ db, bitnob, config: cfg, bitnobEnv: "mock" });
    apps.push(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "771234567", pin: "482915" },
    });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };
    const balance = await app.inject({ method: "GET", url: "/api/balance", headers });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ balanceXof: 0, balanceSats: 0, lastPayouts: [] });
    const quote = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 1000, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    expect(quote.statusCode).toBe(422);
    expect(quote.json().error).toBe("INSUFFICIENT_BALANCE");
  });

  it("chiffre le devis en BTC quand le retrait est débité du portefeuille BTC", async () => {
    const { app, db, bitnob, token, merchantId } = await boot({ payoutFromAsset: "BTC" });
    credit(db, merchantId, 10_000, "live");
    const quote = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers: { authorization: `Bearer ${token}` },
      payload: { amountXof: 5000, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json().quote.receivedXof).toBe(5000);
    const requested = bitnob.quoteRequests.map((request) => ({ asset: request.fromAsset, amount: Number(request.amount) }));
    expect(requested.every((request) => request.asset === "BTC")).toBe(true);
    expect(requested[0]?.amount).toBeLessThan(0.001);
    expect(requested[0]?.amount).toBeGreaterThan(0.00001);
    const last = requested.at(-1);
    expect(String(bitnob.quoteRequests.at(-1)?.amount).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(8);
    expect((last?.amount ?? 0) * 590 * 65_000).toBeGreaterThanOrEqual(5000);
  });

  it("envoie à Bitnob un bénéficiaire mobile money complet avec pays et expéditeur", async () => {
    const { app, db, bitnob, token, merchantId } = await boot();
    credit(db, merchantId, 10_000, "live");
    const headers = { authorization: `Bearer ${token}` };
    const seen: Array<{ quoteId: string; body: Record<string, unknown> }> = [];
    const original = bitnob.payouts.initialize;
    bitnob.payouts.initialize = async (quoteId, body) => {
      seen.push({ quoteId, body: body as unknown as Record<string, unknown> });
      return original(quoteId, body);
    };
    const quote = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 5000, network: "yas", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/payouts",
      headers: { ...headers, "idempotency-key": "33333333-3333-3333-3333-333333333333" },
      payload: { quoteId: quote.json().quote.id },
    });
    expect(created.statusCode).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.beneficiary).toMatchObject({
      destination_type: "mobile_money",
      country: "SN",
      account_name: "Awa Diop",
      account_number: "771234567",
      network: "free",
      sender: { country: "SN" },
    });
  });

  it("devis puis finalise une fois, et completed seulement après le GET", async () => {
    const { app, db, token, merchantId } = await boot();
    const sats = credit(db, merchantId, 10_000, "live");
    credit(db, merchantId, 50_000, "seed");
    const headers = { authorization: `Bearer ${token}` };

    const balance = await app.inject({ method: "GET", url: "/api/balance", headers });
    expect(balance.json().balanceXof).toBe(10_000);
    expect(balance.json().balanceSats).toBe(sats);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 50, network: "wave", accountNumber: "661234567", accountName: "Awa" },
    });
    expect(invalid.statusCode).toBe(400);

    const quote = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 5000, network: "orange", accountNumber: "77 123 45 67", accountName: "Awa Diop" },
    });
    expect(quote.statusCode).toBe(200);
    const body = quote.json().quote;
    expect(body.amountXof).toBe(5000);
    expect(body.receivedXof).toBe(5000);
    expect(body.network).toBe("orange");
    expect(body.exchangeRate).toBe("590");
    expect(body.fees).toBe("0");
    expect(body.accountName).toBe("Awa Diop");
    expect(body.accountNumberMasked).toBe("77•••••67");
    expect(body.expiresAt).toBe(new Date(now.getTime() + 16 * 60 * 1000).toISOString());
    expect(JSON.stringify(quote.json())).not.toContain("771234567");

    const after = await app.inject({ method: "GET", url: "/api/balance", headers });
    expect(after.json().balanceXof).toBe(5000);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 6000, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    expect(blocked.statusCode).toBe(422);

    const key = "22222222-2222-2222-2222-222222222222";
    const created = await app.inject({
      method: "POST",
      url: "/api/payouts",
      headers: { ...headers, "idempotency-key": key },
      payload: { quoteId: body.id },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().payout.status).not.toBe("completed");
    expect(["initiated", "processing"]).toContain(created.json().payout.status);

    const replay = await app.inject({
      method: "POST",
      url: "/api/payouts",
      headers: { ...headers, "idempotency-key": key },
      payload: { quoteId: body.id },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().payout.id).toBe(created.json().payout.id);

    const again = await app.inject({
      method: "POST",
      url: "/api/payouts",
      headers: { ...headers, "idempotency-key": "33333333-3333-3333-3333-333333333333" },
      payload: { quoteId: body.id },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().payout.status).not.toBe("completed");

    const polled = await app.inject({ method: "GET", url: `/api/payouts/${body.id}`, headers });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().payout.status).toBe("completed");

    const left = await app.inject({ method: "GET", url: "/api/balance", headers });
    expect(left.json().balanceXof).toBe(5000);
    expect(left.json().lastPayouts[0].status).toBe("completed");
    expect(JSON.stringify(left.json())).not.toContain("771234567");
  });
  it("redemande un devis au taux réel pour que le montant reçu soit celui demandé", async () => {
    const { app, db, bitnob, token, merchantId } = await boot({ payoutRate: 590.6 });
    credit(db, merchantId, 10_000, "live");
    const headers = { authorization: `Bearer ${token}` };
    const res = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 2000, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quote.receivedXof).toBe(2000);
    expect(res.json().quote.exchangeRate).toBe("590.6");
    expect(bitnob.quoteRequests).toHaveLength(2);
    expect(bitnob.quoteRequests[0]?.amount).toBe("3.389831");
    expect(bitnob.quoteRequests[1]?.amount).toBe("3.386387");
    expect(bitnob.quoteRequests[1]?.reference).toBe(`${bitnob.quoteRequests[0]?.reference}_r`);
    const row = db.prepare("SELECT reference FROM payouts").get() as { reference: string };
    expect(row.reference).toBe(bitnob.quoteRequests[1]?.reference);
  });

  it("ne redemande pas de devis quand le taux supposé suffit", async () => {
    const { app, db, bitnob, token, merchantId } = await boot();
    credit(db, merchantId, 10_000, "live");
    const headers = { authorization: `Bearer ${token}` };
    const res = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 2000, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" },
    });
    expect(res.json().quote.receivedXof).toBe(2000);
    expect(bitnob.quoteRequests).toHaveLength(1);
  });


  it("accepte yas comme nom du reseau free et cite Yas dans le refus d'un reseau inconnu", async () => {
    const { app, db, token, merchantId } = await boot();
    credit(db, merchantId, 10_000, "live");
    const headers = { authorization: `Bearer ${token}` };
    const yas = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 2000, network: "yas", accountNumber: "77 123 45 67", accountName: "Awa Diop" },
    });
    expect(yas.statusCode).toBe(200);
    expect(yas.json().quote.network).toBe("free");
    const bad = await app.inject({
      method: "POST",
      url: "/api/payouts/quote",
      headers,
      payload: { amountXof: 2000, network: "bogus", accountNumber: "77 123 45 67", accountName: "Awa Diop" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields.network).toContain("Yas");
    expect(bad.json().fields.network).not.toContain("Free");
  });
});
