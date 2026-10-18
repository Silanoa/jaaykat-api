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
import { reconcilePending } from "../src/reconciler.js";

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
    app.invoicePolls.retryDelaysMs = [5, 5];
    const created = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    const token = created.json().token as string;
    const idle = async () => {
      await Promise.all([...app.invoicePolls.inflight.values()]);
    };
    return { app, db, bitnob, creates, token, idle };
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
    const { app, token, bitnob, creates, idle } = await boot("manual", 0);
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
    expect(paid.statusCode).toBe(202);
    expect(paid.json()).toEqual({
      status: "pending",
      amountXof: 2500,
      expiresAt: "2026-10-17T18:15:00.000Z",
      demoPayment: true,
      payMethod: "wave",
    });
    await idle();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ reference, autoSettle: true, expirySeconds: 840 });
    expect(bitnob.invoiceGets).toHaveLength(0);

    const again = await app.inject({
      method: "POST",
      url: `/api/public/invoices/${id}/pay`,
      payload: { method: "orange" },
    });
    expect(again.statusCode).toBe(202);
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
    const { app, token, creates, idle } = await boot("manual", 0);
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
    expect(paid.statusCode).toBe(202);
    expect(paid.json().payMethod).toBe("lightning");
    expect(paid.json().status).toBe("pending");
    await idle();
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
    const { app, token, idle } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-wave-nobolt" },
      payload: { amountXof: 1500 },
    });
    const id = created.json().invoice.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "wave" } });
    await idle();
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
    const { app, bitnob, idle } = await boot("manual", 0);
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
      payload: { method: "yas" },
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
    expect(ok.statusCode).toBe(202);
    await idle();
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

  it("marque expir\u00e9e une facture jamais pay\u00e9e quand le d\u00e9lai est pass\u00e9", async () => {
    const { app, db, bitnob } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/public/invoices",
      payload: { slug: "awa-beaute", amountXof: 1500 },
    });
    const id = created.json().invoice.id as string;
    now = new Date("2026-10-17T18:10:00.000Z");
    await reconcilePending(db, bitnob, config("manual"), app.invoicePolls);
    expect((db.prepare("SELECT status FROM invoices WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
    now = new Date("2026-10-17T18:16:00.000Z");
    await reconcilePending(db, bitnob, config("manual"), app.invoicePolls);
    expect((db.prepare("SELECT status FROM invoices WHERE id = ?").get(id) as { status: string }).status).toBe("expired");
    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(polled.json().status).toBe("expired");
    expect(bitnob.invoiceCreates).toBe(0);
  });

  it("accepte yas et garde free comme alias vers yas", async () => {
    const { app, db, token, idle } = await boot("manual", 0);
    const ids: string[] = [];
    for (const key of ["demo-yas-1", "demo-yas-2"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/invoices",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
        payload: { amountXof: 2500 },
      });
      ids.push(created.json().invoice.id as string);
    }
    const direct = await app.inject({ method: "POST", url: `/api/public/invoices/${ids[0]}/pay`, payload: { method: "yas" } });
    expect(direct.statusCode).toBe(202);
    expect(direct.json().payMethod).toBe("yas");
    const alias = await app.inject({ method: "POST", url: `/api/public/invoices/${ids[1]}/pay`, payload: { method: "free" } });
    expect(alias.statusCode).toBe(202);
    expect(alias.json().payMethod).toBe("yas");
    await idle();
    const stored = db.prepare("SELECT simulated_method FROM invoices WHERE id = ?").get(ids[1]) as { simulated_method: string };
    expect(stored.simulated_method).toBe("yas");
    const merchant = await app.inject({ method: "GET", url: `/api/invoices/${ids[1]}`, headers: { authorization: `Bearer ${token}` } });
    expect(merchant.json().invoice.payMethod).toBe("yas");
  });

  it("lit en yas une ancienne ligne enregistrée avec free", async () => {
    const { app, db, token } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-legacy-free" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    db.prepare("UPDATE invoices SET simulated_method = 'free', bitnob_invoice_id = 'legacy' WHERE id = ?").run(id);
    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(polled.json().payMethod).toBe("yas");
    const invalid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "mixx" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("répond à /pay sans attendre la facture Bitnob et expose le bolt11 ensuite", async () => {
    const { app, bitnob, token, idle } = await boot("manual", 0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = bitnob.lightning.createInvoice.bind(bitnob.lightning);
    bitnob.lightning.createInvoice = async (input) => {
      await gate;
      return original(input);
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-slow" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "lightning" } });
    expect(paid.statusCode).toBe(202);
    expect(paid.json().payMethod).toBe("lightning");
    expect(paid.json().bolt11).toBeUndefined();
    const waiting = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json().status).toBe("pending");
    expect(waiting.json().bolt11).toBeUndefined();
    release();
    await idle();
    const ready = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(ready.json().bolt11).toMatch(/^ln/);
  });

  it("réessaie en arrière-plan une création Bitnob échouée sans refaire échouer /pay", async () => {
    const { app, bitnob, token, idle } = await boot("manual", 0);
    const original = bitnob.lightning.createInvoice.bind(bitnob.lightning);
    let calls = 0;
    bitnob.lightning.createInvoice = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("réseau coupé");
      return original(input);
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-retry" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "wave" } });
    expect(paid.statusCode).toBe(202);
    await idle();
    expect(calls).toBe(2);
    const merchant = await app.inject({ method: "GET", url: `/api/invoices/${id}`, headers: { authorization: `Bearer ${token}` } });
    expect(merchant.json().invoice.bolt11).toMatch(/^lntb/);
  });

  it("reprend une création Bitnob restée en suspens via le réconciliateur", async () => {
    const { app, db, bitnob, token, idle } = await boot("manual", 0);
    const original = bitnob.lightning.createInvoice.bind(bitnob.lightning);
    let down = true;
    bitnob.lightning.createInvoice = async (input) => {
      if (down) throw new Error("indisponible");
      return original(input);
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-resume" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    const paid = await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "wave" } });
    expect(paid.statusCode).toBe(202);
    await idle();
    const stuck = db.prepare("SELECT simulated_method, bitnob_invoice_id FROM invoices WHERE id = ?").get(id) as {
      simulated_method: string | null;
      bitnob_invoice_id: string | null;
    };
    expect(stuck).toEqual({ simulated_method: "wave", bitnob_invoice_id: null });
    down = false;
    now = new Date("2026-10-17T18:01:00.000Z");
    await reconcilePending(db, bitnob, config("manual"), app.invoicePolls);
    await idle();
    const resumed = db.prepare("SELECT bitnob_invoice_id FROM invoices WHERE id = ?").get(id) as { bitnob_invoice_id: string | null };
    expect(resumed.bitnob_invoice_id).not.toBeNull();
    expect(bitnob.invoiceCreates).toBe(1);
  });

  it("ne renvoie pas d'erreur au polling public si la relecture Bitnob échoue", async () => {
    const { app, bitnob, token, idle } = await boot("manual", 0);
    const created = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "demo-get-fails" },
      payload: { amountXof: 2500 },
    });
    const id = created.json().invoice.id as string;
    await app.inject({ method: "POST", url: `/api/public/invoices/${id}/pay`, payload: { method: "wave" } });
    await idle();
    bitnob.lightning.getInvoice = async () => {
      throw new Error("relecture indisponible");
    };
    now = new Date("2026-10-17T18:01:00.000Z");
    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${id}` });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().status).toBe("pending");
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
