import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { reconcilePending } from "../src/reconciler.js";

const registerBody = {
  shopName: "Awa Beauté",
  category: "beaute",
  firstName: "Awa",
  lastName: "Diop",
  phone: "77 123 45 67",
  pin: "482915",
};

describe("factures", () => {
  const apps: FastifyInstance[] = [];
  let now = new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    now = new Date("2026-10-17T18:00:00.000Z");
  });

  function config(): AppConfig {
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
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => now,
    };
  }

  async function boot(opts?: { settleAfterMs?: number; failNextInvoices?: number }) {
    const db = openDatabase(":memory:");
    const bitnob = new MockBitnobClient({
      clientId: "mock",
      clientSecret: "mock",
      settleAfterMs: opts?.settleAfterMs ?? 0,
      failNextInvoices: opts?.failNextInvoices ?? 0,
    });
    const cfg = config();
    const app = await buildApp({ db, bitnob, config: cfg, bitnobEnv: "mock" });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    const token = created.json().token as string;
    return { app, db, bitnob, token, cfg };
  }

  it("crée une facture pending puis paid seulement après le GET Bitnob", async () => {
    const { app, token, bitnob } = await boot({ settleAfterMs: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "11111111-1111-1111-1111-111111111111" },
      payload: { amountXof: 2500, label: "Huile" },
    });
    expect(res.statusCode).toBe(201);
    const invoice = res.json().invoice;
    const rate = 64_000 * 605;
    expect(invoice.status).toBe("pending");
    expect(invoice.amountXof).toBe(2500);
    expect(invoice.amountSats).toBe(Math.round((2500 / rate) * 1e8));
    expect(invoice.bolt11).toMatch(/^lntb/);
    expect(invoice.channel).toBe("dynamic");
    expect(invoice.source).toBe("live");
    expect(invoice.label).toBe("Huile");
    expect(invoice.simulated).toBe(true);
    expect(invoice.reference).toMatch(/^jk_awa-beaute_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(bitnob.invoiceGets).toHaveLength(0);

    const paid = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().invoice.status).toBe("paid");
    expect(paid.json().invoice.paidAt).toBe("2026-10-17T18:00:00.000Z");
    expect(bitnob.invoiceGets).toHaveLength(1);
  });

  it("rejoue la même Idempotency-Key sans second appel Bitnob", async () => {
    const { app, token, bitnob } = await boot({ settleAfterMs: 60_000 });
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "22222222-2222-2222-2222-222222222222" };
    const first = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountXof: 1000 } });
    const second = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountXof: 1000 } });
    expect(second.statusCode).toBe(200);
    expect(second.json().invoice.id).toBe(first.json().invoice.id);
    expect(second.json().invoice.reference).toBe(first.json().invoice.reference);
    expect(bitnob.invoiceCreates).toBe(1);
  });

  it("réessaie Bitnob avec la même reference après un échec", async () => {
    const { app, token, bitnob } = await boot({ settleAfterMs: 60_000, failNextInvoices: 1 });
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "33333333-3333-3333-3333-333333333333" };
    const failed = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountXof: 1500 } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe("BITNOB_UNAVAILABLE");
    const retried = await app.inject({ method: "POST", url: "/api/invoices", headers, payload: { amountXof: 1500 } });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().invoice.status).toBe("pending");
    expect(bitnob.references).toEqual([retried.json().invoice.reference, retried.json().invoice.reference]);
  });

  it("ne relit Bitnob qu'une fois toutes les 2 secondes", async () => {
    const { app, token, bitnob } = await boot({ settleAfterMs: 60_000 });
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "44444444-4444-4444-4444-444444444444" },
      payload: { amountXof: 500 },
    });
    const id = created.json().invoice.id as string;
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers });
    await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers });
    expect(bitnob.invoiceGets).toHaveLength(1);
    now = new Date("2026-10-17T18:00:03.000Z");
    await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers });
    expect(bitnob.invoiceGets).toHaveLength(2);
  });

  it("le reconciler confirme une facture non affichée", async () => {
    const { app, db, token, bitnob, cfg } = await boot({ settleAfterMs: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "55555555-5555-5555-5555-555555555555" },
      payload: { amountXof: 2500 },
    });
    expect(created.json().invoice.status).toBe("pending");
    now = new Date("2026-10-17T18:00:21.000Z");
    await reconcilePending(db, bitnob, cfg, app.invoicePolls);
    const row = db.prepare("SELECT status, settle_method FROM invoices WHERE id = ?").get(created.json().invoice.id) as {
      status: string;
      settle_method: string;
    };
    expect(row.status).toBe("paid");
    expect(row.settle_method).toBe("reconcile");
  });

  it("refuse un montant hors bornes", async () => {
    const { app, token } = await boot();
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "66666666-6666-6666-6666-666666666666" },
      payload: { amountXof: 20_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION");
    expect(res.json().message).toMatch(/F/);
  });
});
