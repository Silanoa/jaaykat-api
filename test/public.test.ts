import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";

const registerBody = {
  shopName: "Awa Beauté",
  category: "beaute",
  firstName: "Awa",
  lastName: "Diop",
  phone: "77 123 45 67",
  pin: "482915",
};

describe("public et fichiers", () => {
  const apps: FastifyInstance[] = [];
  const now = () => new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function boot(publicDir = "/tmp/jaaykat-no-public") {
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
      webhookSecret: "whsec_test",
      phonePepper: "phone-pepper-0123456789abcdef",
      payerPepper: "payer-pepper-0123456789abcdef",
      publicDir,
      autoSettle: true,
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now,
    };
    const app = await buildApp({ db, bitnob, config, bitnobEnv: "mock" });
    apps.push(app);
    await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    return { app, db };
  }

  it("expose la boutique et une facture publique payée après relecture", async () => {
    const { app } = await boot();
    const shop = await app.inject({ method: "GET", url: "/api/public/shops/awa-beaute" });
    expect(shop.statusCode).toBe(200);
    expect(shop.json()).toEqual({ name: "Awa Beauté", category: "beaute" });

    const missing = await app.inject({ method: "GET", url: "/api/public/shops/inconnue" });
    expect(missing.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/public/invoices",
      headers: { "cf-connecting-ip": "203.0.113.20" },
      payload: { slug: "awa-beaute", amountXof: 2500, payerName: "Fatou", payerPhone: "77 000 00 01" },
    });
    expect(created.statusCode).toBe(201);
    const invoice = created.json().invoice;
    expect(invoice.status).toBe("pending");
    expect(invoice.channel).toBe("static_qr");
    expect(invoice.bolt11).toMatch(/^lntb/);

    const polled = await app.inject({ method: "GET", url: `/api/public/invoices/${invoice.id}` });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      status: "paid",
      amountXof: 2500,
      expiresAt: invoice.expiresAt,
    });
    expect(polled.json().bolt11).toBeUndefined();
  });

  it("limite les routes publiques à 10 requêtes par minute", async () => {
    const { app } = await boot();
    const headers = { "cf-connecting-ip": "203.0.113.21" };
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "GET", url: "/api/public/shops/awa-beaute", headers });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/api/public/shops/awa-beaute", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");
  });

  it("sert la PWA et laisse les 404 API en JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jk-public-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Jaaykat</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const { app } = await boot(dir);
    const home = await app.inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("Jaaykat");
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
    const spa = await app.inject({ method: "GET", url: "/p/awa-beaute" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("Jaaykat");
    const attestation = await app.inject({ method: "GET", url: "/s/token-demo" });
    expect(attestation.statusCode).toBe(200);
    expect(attestation.body).toContain("Jaaykat");
    const api = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe("NOT_FOUND");
  });
});
