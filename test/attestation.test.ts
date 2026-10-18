import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { seedDemo } from "../src/db/seed.js";
import { bootApp, insertSale, merchantIdOf, registerMerchant, type TestDb } from "./helpers.js";

const DAY = 86_400_000;

describe("score et attestation", () => {
  const apps: FastifyInstance[] = [];
  const clock = { now: new Date("2026-10-17T18:00:00.000Z") };

  afterEach(async () => {
    clock.now = new Date("2026-10-17T18:00:00.000Z");
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function boot() {
    const { app, db } = await bootApp(clock);
    apps.push(app);
    const { headers } = await registerMerchant(app);
    return { app, db, headers, merchantId: merchantIdOf(db) };
  }

  function sellOverDays(db: TestDb, merchantId: string, count: number, spanDays: number) {
    for (let index = 0; index < count; index += 1) {
      const daysAgo = spanDays === 0 ? 0 : index % (spanDays + 1);
      insertSale(db, merchantId, { amountXof: 1000, at: new Date(clock.now.getTime() - daysAgo * DAY - 6 * 3_600_000) });
    }
  }

  it("annonce les seuils et ce qu'il reste à faire pour un marchand sans vente", async () => {
    const { app, headers } = await boot();
    const score = (await app.inject({ method: "GET", url: "/api/score", headers })).json();
    expect(score).toMatchObject({
      eligible: false,
      score: null,
      band: null,
      demo: false,
      windowDays: 90,
      thresholds: { days: 14, sales: 20 },
      remaining: { days: 14, sales: 20 },
    });
  });

  it("refuse l'attestation d'un marchand inéligible avec ce qu'il lui reste à faire", async () => {
    const { app, db, headers, merchantId } = await boot();
    const none = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe("NOT_ELIGIBLE");
    expect(none.json().message).toBe("Attestation indisponible. Encore 20 ventes payées et 14 jours pour être éligible.");
    expect(none.json().remaining).toEqual({ days: 14, sales: 20 });

    sellOverDays(db, merchantId, 19, 20);
    const salesOnly = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(salesOnly.statusCode).toBe(422);
    expect(salesOnly.json().message).toBe("Attestation indisponible. Encore 1 vente payée pour être éligible.");

    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM score_shares").get() as { n: number }).n;
    expect(count()).toBe(0);
  });

  it("refuse quand il y a assez de ventes mais pas assez de jours", async () => {
    const { app, db, headers, merchantId } = await boot();
    sellOverDays(db, merchantId, 25, 3);
    const res = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe("Attestation indisponible. Encore 11 jours pour être éligible.");
    expect(res.json().remaining).toEqual({ days: 11, sales: 0 });
  });

  it("ne compte ni les factures expirées ni celles en attente", async () => {
    const { app, db, headers, merchantId } = await boot();
    sellOverDays(db, merchantId, 19, 20);
    insertSale(db, merchantId, { amountXof: 1000, at: new Date(clock.now.getTime() - 3_600_000), status: "pending" });
    insertSale(db, merchantId, { amountXof: 1000, at: new Date(clock.now.getTime() - 3_600_000), status: "expired" });
    const res = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(res.statusCode).toBe(422);
    expect(res.json().remaining.sales).toBe(1);
  });

  it("émet une attestation datée, identifiée et sans donnée personnelle", async () => {
    const { app, db, headers, merchantId } = await boot();
    sellOverDays(db, merchantId, 25, 20);
    insertSale(db, merchantId, { amountXof: 4000, at: new Date(clock.now.getTime() - 3_600_000), status: "expired" });
    insertSale(db, merchantId, { amountXof: 4000, at: new Date(clock.now.getTime() - 3_600_000), status: "pending" });

    const share = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(share.statusCode).toBe(200);
    expect(share.json().url).toMatch(/^https:\/\/demo\.example\/s\/[A-Za-z0-9_-]{43}$/);
    const token = String(share.json().url).split("/s/")[1];

    const res = await app.inject({ method: "GET", url: `/api/public/shares/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["attestationId", "band", "demo", "environment", "expiresAt", "issuedAt", "period", "salesCount", "score", "shopName", "status", "totalXof", "windowDays"].sort(),
    );
    expect(body).toMatchObject({
      shopName: "Chez Awa",
      status: "valid",
      demo: false,
      environment: "mock",
      salesCount: 25,
      totalXof: 25_000,
      windowDays: 90,
      issuedAt: clock.now.toISOString(),
      expiresAt: new Date(clock.now.getTime() + 7 * DAY).toISOString(),
      period: { from: "2026-09-27", to: "2026-10-17" },
    });
    expect(body.attestationId).toMatch(/^JK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(typeof body.score).toBe("number");
    expect(["A", "B", "C", "D"]).toContain(body.band);
    expect(JSON.stringify(body)).not.toMatch(/phone|payer|nickname|221|771234567|token|bolt11/i);
  });

  it("étiquette comme démonstration l'attestation d'un compte avec historique simulé", async () => {
    const db = openDatabase(":memory:");
    const { app, config } = await bootApp(clock, db);
    apps.push(app);
    seedDemo(db, config);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "771234567", pin: "482915" } });
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    expect((await app.inject({ method: "GET", url: "/api/score", headers })).json().demo).toBe(true);
    const share = await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(share.statusCode).toBe(200);
    const token = String(share.json().url).split("/s/")[1];
    const body = (await app.inject({ method: "GET", url: `/api/public/shares/${token}` })).json();
    expect(body.demo).toBe(true);
    expect(body.shopName).toBe("Awa Beauté");
    expect((await app.inject({ method: "GET", url: "/api/dashboard?range=30d", headers })).json().demo).toBe(true);
  });

  it("reflète l'expiration, la révocation et un lien inconnu", async () => {
    const { app, db, headers, merchantId } = await boot();
    sellOverDays(db, merchantId, 25, 20);
    const share = await app.inject({ method: "POST", url: "/api/score/share", headers });
    const token = String(share.json().url).split("/s/")[1];
    const read = async () => (await app.inject({ method: "GET", url: `/api/public/shares/${token}` })).json();

    expect((await read()).status).toBe("valid");
    clock.now = new Date(clock.now.getTime() + 7 * DAY + 1000);
    const expired = await read();
    expect(expired.status).toBe("expired");
    expect(expired.score).not.toBeNull();

    clock.now = new Date(clock.now.getTime() - 5 * DAY);
    db.prepare("UPDATE score_shares SET revoked = 1 WHERE token_id = ?").run(token);
    const revoked = await read();
    expect(revoked.status).toBe("revoked");
    expect(revoked).toMatchObject({ score: null, band: null, salesCount: null, totalXof: null, period: null });
    expect(revoked.shopName).toBe("Chez Awa");

    const unknown = await app.inject({ method: "GET", url: "/api/public/shares/inconnu" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("NOT_FOUND");
  });

  it("ne garde une trace en base que des attestations émises", async () => {
    const { app, db, headers, merchantId } = await boot();
    sellOverDays(db, merchantId, 25, 20);
    await app.inject({ method: "GET", url: "/api/score", headers });
    await app.inject({ method: "GET", url: "/api/score", headers });
    const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM credit_scores").get() as { n: number }).n;
    expect(rows()).toBe(0);
    await app.inject({ method: "POST", url: "/api/score/share", headers });
    expect(rows()).toBe(1);
  });

  it("note l'environnement Bitnob réel au moment de l'émission, pas le mode de l'API", async () => {
    const { app, db, bitnob } = await bootApp(clock, undefined, { bitnobMode: "live" });
    apps.push(app);
    const { headers } = await registerMerchant(app);
    sellOverDays(db, merchantIdOf(db), 25, 20);
    const token = async () => String((await app.inject({ method: "POST", url: "/api/score/share", headers })).json().url).split("/s/")[1];
    const read = async (value: string) => (await app.inject({ method: "GET", url: `/api/public/shares/${value}` })).json();

    expect((await read(await token())).environment).toBe("sandbox");

    bitnob.whoami = async () => {
      throw new Error("injoignable");
    };
    expect((await read(await token())).environment).toBe("unknown");
  });

  it("révoque à la migration les liens émis avant l'identifiant et le périmètre vérifiables", () => {
    const dir = mkdtempSync(join(tmpdir(), "jk-migrate-"));
    const path = join(dir, "old.db");
    try {
      const old = openDatabase(path);
      old.exec("ALTER TABLE score_shares DROP COLUMN snapshot");
      old.prepare("INSERT INTO score_shares (token_id, merchant_id, score_id, expires_at, revoked) VALUES ('legacy', 'm', 's', '2099-01-01T00:00:00.000Z', 0)").run();
      old.pragma("user_version = 2");
      old.close();

      const migrated = openDatabase(path);
      const columns = (migrated.prepare("PRAGMA table_info(score_shares)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain("snapshot");
      expect(migrated.prepare("SELECT revoked FROM score_shares WHERE token_id = 'legacy'").get()).toEqual({ revoked: 1 });
      expect(migrated.pragma("user_version", { simple: true })).toBe(3);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
