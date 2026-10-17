import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";

const SECRET = "whsec_test";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

describe("webhooks Bitnob", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function boot() {
    const db = openDatabase(":memory:");
    const bitnob = new MockBitnobClient({ clientId: "mock", clientSecret: "mock", settleAfterMs: 0 });
    const config: AppConfig = {
      nodeEnv: "test",
      port: 0,
      databasePath: ":memory:",
      publicUrl: "https://demo.example",
      bitnobMode: "mock",
      bitnobBaseUrl: "https://api.bitnob.com",
      bitnobClientId: "mock",
      bitnobClientSecret: "mock",
      webhookSecret: SECRET,
      phonePepper: "phone-pepper-0123456789abcdef",
      payerPepper: "payer-pepper-0123456789abcdef",
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: true,
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => new Date("2026-10-17T18:00:00.000Z"),
    };
    const app = await buildApp({ db, bitnob, config, bitnobEnv: "mock" });
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        shopName: "Awa Beauté",
        category: "beaute",
        firstName: "Awa",
        lastName: "Diop",
        phone: "77 123 45 67",
        pin: "482915",
      },
    });
    const token = created.json().token as string;
    const invoice = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "77777777-7777-7777-7777-777777777777" },
      payload: { amountXof: 2500 },
    });
    const invoiceId = invoice.json().invoice.id as string;
    const bitnobId = (
      db.prepare("SELECT bitnob_invoice_id AS id FROM invoices WHERE id = ?").get(invoiceId) as { id: string }
    ).id;
    return { app, db, bitnob, invoiceId, bitnobId };
  }

  it("refuse une signature invalide sans changer la facture", async () => {
    const { app, db, bitnob, invoiceId } = await boot();
    const raw = JSON.stringify({ event_id: "evt_bad", event: "btc.lightning.received.success", data: { id: "x" } });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bitnob",
      headers: { "content-type": "application/json", "x-bitnob-signature": sign(raw, "autre-secret") },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("INVALID_SIGNATURE");
    const invoice = db.prepare("SELECT status FROM invoices WHERE id = ?").get(invoiceId) as { status: string };
    expect(invoice.status).toBe("pending");
    const event = db.prepare("SELECT signature_valid FROM webhook_events").get() as { signature_valid: number };
    expect(event.signature_valid).toBe(0);
    expect(bitnob.invoiceGets).toHaveLength(0);
  });

  it("confirme par GET puis ignore le doublon", async () => {
    const { app, db, bitnob, invoiceId, bitnobId } = await boot();
    const raw = JSON.stringify({
      event_id: "evt_ok",
      event: "btc.lightning.received.success",
      data: { id: bitnobId, status: "success" },
    });
    const headers = {
      "content-type": "application/json",
      "x-bitnob-signature": sign(raw),
      "x-bitnob-event-id": "evt_ok",
    };
    const first = await app.inject({ method: "POST", url: "/webhooks/bitnob", headers, payload: raw });
    expect(first.statusCode).toBe(200);
    const invoice = db.prepare("SELECT status, settle_method FROM invoices WHERE id = ?").get(invoiceId) as {
      status: string;
      settle_method: string;
    };
    expect(invoice.status).toBe("paid");
    expect(invoice.settle_method).toBe("webhook");
    expect(bitnob.invoiceGets).toEqual([bitnobId]);

    const second = await app.inject({ method: "POST", url: "/webhooks/bitnob", headers, payload: raw });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(bitnob.invoiceGets).toEqual([bitnobId]);
  });
});
