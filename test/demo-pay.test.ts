import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { CreateInvoiceInput } from "../src/bitnob/types.js";
import { loadConfig, type AppConfig, type DemoPayMode } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";

const registerBody = {
  shopName: "Awa Beauté",
  category: "beaute",
  firstName: "Awa",
  lastName: "Diop",
  phone: "77 123 45 67",
  pin: "482915",
};

const peppers = {
  PHONE_PEPPER: "phone-pepper-0123456789abcdef",
  PAYER_PEPPER: "payer-pepper-0123456789abcdef",
};

describe("DEMO_PAY_MODE", () => {
  const apps: FastifyInstance[] = [];
  let now = new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    now = new Date("2026-10-17T18:00:00.000Z");
  });

  function config(mode: DemoPayMode): AppConfig {
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
      phonePepper: peppers.PHONE_PEPPER,
      payerPepper: peppers.PAYER_PEPPER,
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: false,
      demoPayMode: mode,
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => now,
    };
  }

  async function boot(mode: DemoPayMode, settleAfterMs = 60_000) {
    const db = openDatabase(":memory:");
    const bitnob = new MockBitnobClient({ clientId: "mock", clientSecret: "mock", settleAfterMs });
    const creates: CreateInvoiceInput[] = [];
    const original = bitnob.lightning.createInvoice.bind(bitnob.lightning);
    bitnob.lightning.createInvoice = async (input) => {
      creates.push(input);
      return original(input);
    };
    const cfg = config(mode);
    const app = await buildApp({ db, bitnob, config: cfg, bitnobEnv: "mock" });
    apps.push(app);
    const created = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    const token = created.json().token as string;
    return { app, db, bitnob, creates, token };
  }

  it("charge auto par défaut et manual seulement si la variable vaut manual", () => {
    expect(loadConfig(peppers).demoPayMode).toBe("auto");
    expect(loadConfig({ ...peppers, DEMO_PAY_MODE: "manual" }).demoPayMode).toBe("manual");
    expect(loadConfig({ ...peppers, DEMO_PAY_MODE: "other" }).demoPayMode).toBe("auto");
  });

  it("crée marchand et public en pending sans lightning, avec payUrl", async () => {
    const { app, token, bitnob, creates } = await boot("manual");
    const rate = 64_000 * 605;
    const merchant = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-manual-1" },
      payload: { amountXof: 2500, label: "Huile" },
    });
    expect(merchant.statusCode).toBe(201);
    const invoice = merchant.json().invoice;
    expect(invoice.status).toBe("pending");
    expect(invoice.bolt11).toBeNull();
    expect(invoice.amountSats).toBe(Math.round((2500 / rate) * 1e8));
    expect(invoice.expiresAt).toBe("2026-10-17T18:15:00.000Z");
    expect(invoice.simulated).toBe(true);
    expect(invoice.demoPayment).toBe(true);
    expect(invoice.payMethod).toBeNull();
    expect(invoice.payUrl).toBe(`https://demo.example/p/awa-beaute?facture=${invoice.id}`);
    expect(creates).toHaveLength(0);
    expect(bitnob.invoiceCreates).toBe(0);
    expect(bitnob.references).toHaveLength(0);

    const pub = await app.inject({
      method: "POST",
      url: "/api/public/invoices",
      payload: { slug: "awa-beaute", amountXof: 1000 },
    });
    expect(pub.statusCode).toBe(201);
    expect(pub.json().invoice.bolt11).toBeNull();
    expect(pub.json().invoice.channel).toBe("static_qr");
    expect(pub.json().invoice.demoPayment).toBe(true);
    expect(pub.json().invoice.payUrl).toBe(`https://demo.example/p/awa-beaute?facture=${pub.json().invoice.id}`);
    expect(bitnob.invoiceCreates).toBe(0);

    const viewed = await app.inject({
      method: "GET",
      url: `/api/invoices/${invoice.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viewed.json().invoice.payMethod).toBeNull();
    expect(viewed.json().invoice.demoPayment).toBe(true);
    const flat = await app.inject({ method: "GET", url: `/api/public/invoices/${invoice.id}` });
    expect(flat.json()).toEqual({
      status: "pending",
      amountXof: 2500,
      expiresAt: "2026-10-17T18:15:00.000Z",
      demoPayment: true,
      payMethod: null,
    });
    expect(flat.json().bolt11).toBeUndefined();
    expect(bitnob.invoiceGets).toHaveLength(0);
  });

  it("paie une seule fois en auto_settle et ne passe paid qu'après le GET Bitnob", async () => {
    const { app, token, bitnob, creates } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-manual-pay" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    const reference = created.json().invoice.reference as string;
    now = new Date("2026-10-17T18:01:00.000Z");
    const paid = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${id}/pay`,
      payload: { method: "wave" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({
      status: "pending",
      amountXof: 2500,
      expiresAt: "2026-10-17T18:15:00.000Z",
      demoPayment: true,
      payMethod: "wave",
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ reference, autoSettle: true, expirySeconds: 840 });
    expect(bitnob.invoiceCreates).toBe(1);
    expect(bitnob.invoiceGets).toHaveLength(0);

    const again = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${id}/pay`,
      payload: { method: "orange" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().payMethod).toBe("wave");
    expect(again.json().status).toBe("pending");
    expect(bitnob.invoiceCreates).toBe(1);

    const merchant = await app.inject({
      method: "GET",
      url: `/api/invoices/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(merchant.json().invoice.status).toBe("paid");
    expect(merchant.json().invoice.payMethod).toBe("wave");
    expect(merchant.json().invoice.bolt11).toMatch(/^lntb/);
    expect(bitnob.invoiceGets).toHaveLength(1);
  });

  it("accepte le portefeuille Lightning et expose la facture bolt11 seulement pour ce moyen", async () => {
    const { app, token, creates } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-lightning-1" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    const before = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(before.json().bolt11).toBeUndefined();

    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "lightning" } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().payMethod).toBe("lightning");
    expect(paid.json().status).toBe("pending");
    expect(paid.json().bolt11).toMatch(/^ln/);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.autoSettle).toBe(true);

    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(polled.json().status).toBe("paid");
    expect(polled.json().payMethod).toBe("lightning");
    expect(polled.json().bolt11).toMatch(/^ln/);

    const merchant = await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers: { authorization: `Bearer ${token}` } });
    expect(merchant.json().invoice.payMethod).toBe("lightning");
  });

  it("n'expose pas bolt11 pour un paiement Wave", async () => {
    const { app, token } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-wave-nobolt" },
      payload: { amountXof: 1500 },
    });
    const id = created.json().invoice.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "wave" } });
    expect(paid.json().bolt11).toBeUndefined();
    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(polled.json().bolt11).toBeUndefined();
  });

  it("répond 404 en mode auto", async () => {
    const { app, token, bitnob } = await boot("auto", 60_000);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-auto" },
      payload: { amountXof: 500 },
    });
    expect(created.json().invoice.demoPayment).toBe(false);
    expect(created.json().invoice.payUrl).toBeNull();
    expect(created.json().invoice.payMethod).toBeNull();
    expect(created.json().invoice.bolt11).toMatch(/^lntb/);
    const id = created.json().invoice.id as string;
    const denied = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${id}/pay`,
      payload: { method: "wave" },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error).toBe("NOT_FOUND");
    expect(bitnob.invoiceCreates).toBe(1);
  });

  it("répond 409 si la facture est expirée ou déjà payée", async () => {
    const { app, token, bitnob } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/public/invoices",
      payload: { slug: "awa-beaute", amountXof: 1500 },
    });
    const id = created.json().invoice.id as string;
    now = new Date("2026-10-17T18:15:00.000Z");
    const expired = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${id}/pay`,
      payload: { method: "free" },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toBe("EXPIRED");
    expect(bitnob.invoiceCreates).toBe(0);

    const fresh = await app.inject({
      method: "POST",
      url: "/api/public/invoices",
      payload: { slug: "awa-beaute", amountXof: 1500 },
    });
    const freshId = fresh.json().invoice.id as string;
    const ok = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${freshId}/pay`,
      payload: { method: "expresso" },
    });
    expect(ok.statusCode).toBe(200);
    await app.inject({ method: "GET", url: `/api/public/invoices/${freshId}` });
    const second = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${freshId}/pay`,
      payload: { method: "expresso" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("ALREADY_PAID");
    expect(bitnob.invoiceCreates).toBe(1);
  });

  it("publie demoPayMode sur health et system", async () => {
    const { app, token } = await boot("manual");
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toMatchObject({ ok: true, bitnob: true, mode: "mock", demoPayMode: "manual" });
    const system = await app.inject({
      method: "GET",
      url: "/api/system",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(system.json().demoPayMode).toBe("manual");
  });

  it("ajoute simulated_method aux bases déjà en version 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "jk-mig-"));
    const path = join(dir, "jaaykat.db");
    const created = new Database(path);
    created.exec("CREATE TABLE invoices (id TEXT PRIMARY KEY)");
    created.pragma("user_version = 1");
    created.close();
    const db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    const columns = db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("simulated_method");
    db.close();
  });
});
