import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { seedDemo } from "../src/db/seed.js";

describe("dashboard et score HTTP", () => {
  const apps: FastifyInstance[] = [];
  const now = new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("sert le score, le tableau et une attestation sans montants", async () => {
    const db = openDatabase(":memory:");
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
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: true,
      demoPayMode: "auto",
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => now,
    };
    seedDemo(db, config);
    const bitnob = new MockBitnobClient({ clientId: "mock", clientSecret: "mock", settleAfterMs: 0 });
    const app = await buildApp({ db, bitnob, config, bitnobEnv: "mock" });
    apps.push(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "771234567", pin: "482915" },
    });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };

    const score = await app.inject({ method: "GET", url: "/api/score", headers });
    expect(score.statusCode).toBe(200);
    expect(score.json().band).toBe("B");
    expect(score.json().eligible).toBe(true);

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard?range=30d", headers });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().kpis.salesCount).toBeGreaterThan(0);
    expect(dashboard.json().advice.priority).toBeGreaterThanOrEqual(1);

    const sales = await app.inject({ method: "GET", url: "/api/sales", headers });
    expect(sales.statusCode).toBe(200);
    expect(sales.json().items[0].source).toBe("seed");

    const share = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(share.statusCode).toBe(200);
    expect(share.json().url).toMatch(/^https:\/\/demo\.example\/s\//);
    const token = String(share.json().url).split("/s/")[1];
    const attestation = await app.inject({ method: "GET", url: `/api/public/shares/${token}` });
    expect(attestation.statusCode).toBe(200);
    const body = attestation.json();
    expect(body.shopName).toBe("Awa Beauté");
    expect(body.band).toBe("B");
    expect(body.status).toBe("valid");
    expect(body.period).toBe("90 jours");
    expect(JSON.stringify(body)).not.toMatch(/amount|payer|phone/i);
  });
});
