import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BitnobError } from "../src/bitnob/errors.js";
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

function testConfig(now: () => Date): AppConfig {
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
    now,
  };
}

describe("auth marchand", () => {
  const apps: FastifyInstance[] = [];
  let now = new Date("2026-10-17T18:00:00.000Z");

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    now = new Date("2026-10-17T18:00:00.000Z");
  });

  async function boot(opts?: { failCustomers?: boolean | BitnobError }) {
    const db = openDatabase(":memory:");
    const bitnob = new MockBitnobClient({
      clientId: "mock",
      clientSecret: "mock",
      settleAfterMs: 0,
      failCustomers: opts?.failCustomers ?? false,
    });
    const app = await buildApp({
      db,
      bitnob,
      config: testConfig(() => now),
      bitnobEnv: "mock",
    });
    apps.push(app);
    return { app, db, bitnob };
  }

  it("inscrit, ouvre une session et masque le client Bitnob", async () => {
    const { app, bitnob } = await boot();
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user.phoneMasked).toBe("77•••••67");
    expect(body.merchant.slug).toBe("awa-beaute");
    expect(body.merchant.qrUrl).toBe("https://demo.example/p/awa-beaute");
    expect(JSON.stringify(body)).not.toContain("bitnob");
    expect(bitnob.customersCreated).toHaveLength(1);
    expect(bitnob.customersCreated[0]?.email).toMatch(/^m-.+@merchants\.jaaykat\.invalid$/);
    expect(bitnob.customersCreated[0]?.customerType).toBe("individual");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().merchant.displayName).toBe("Awa Beauté");
    expect(me.json().session.expiresAt).toBe("2026-10-24T18:00:00.000Z");
  });

  it("refuse un PIN faible, un numéro invalide et un téléphone déjà pris", async () => {
    const { app, bitnob } = await boot();
    const weak = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...registerBody, pin: "111111" },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("VALIDATION");
    expect(weak.json().fields.pin).toBe("Code trop simple");

    const badPhone = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...registerBody, phone: "661234567" },
    });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().fields.phone).toBe("Numéro invalide");

    const ok = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(ok.statusCode).toBe(201);
    const taken = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("PHONE_TAKEN");
    expect(bitnob.customersCreated).toHaveLength(1);
  });

  it("ne écrit rien si Bitnob échoue", async () => {
    const { app, db } = await boot({ failCustomers: true });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("BITNOB_UNAVAILABLE");
    const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("refuse un prénom ou un nom avec des chiffres avant d'appeler Bitnob", async () => {
    const { app, bitnob } = await boot();
    const lastName = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...registerBody, lastName: "E2E1" } });
    expect(lastName.statusCode).toBe(400);
    expect(lastName.json().error).toBe("VALIDATION");
    expect(lastName.json().fields.lastName).toBe("Lettres, espaces, tirets et apostrophes uniquement");
    const firstName = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...registerBody, firstName: "Awa2" } });
    expect(firstName.statusCode).toBe(400);
    expect(firstName.json().fields.firstName).toBe("Lettres, espaces, tirets et apostrophes uniquement");
    expect(bitnob.customersCreated).toHaveLength(0);
  });

  it("accepte les noms composés, accentués et avec apostrophe", async () => {
    const { app } = await boot();
    const names: Array<[string, string, string]> = [
      ["Jean-Pierre", "N'Diaye", "77 100 00 01"],
      ["Aïssatou", "Ndiaye Fall", "77 100 00 02"],
      ["Maïmouna", "D’Almeida", "77 100 00 03"],
    ];
    for (const [firstName, lastName, phone] of names) {
      const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...registerBody, firstName, lastName, phone, shopName: "Boutique " + firstName } });
      expect(res.statusCode).toBe(201);
    }
  });

  it("traduit un refus de validation Bitnob en 400 lisible, sans l'appeler 502", async () => {
    const refusal = new BitnobError("last_name must not contain digits", {
      status: 400,
      path: "/api/customers",
      code: "VALIDATION_ERROR",
      correlationId: "req_test",
      body: { code: "VALIDATION_ERROR", extensions: { field: "last_name", rule: "name_has_digits" } },
    });
    const { app, db } = await boot({ failCustomers: refusal });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION");
    expect(res.json().fields.lastName).toBe("Nom refusé par le réseau de paiement");
    expect(JSON.stringify(res.json())).not.toContain("must not contain");
    const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("renvoie un 400 générique quand Bitnob refuse sans champ identifié", async () => {
    const refusal = new BitnobError("refus", { status: 422, path: "/api/customers", code: "VALIDATION_ERROR", body: { code: "VALIDATION_ERROR" } });
    const { app } = await boot({ failCustomers: refusal });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION");
    expect(res.json().message).toBe("Les informations ont été refusées. Vérifiez le nom et le numéro.");
  });

  it("verrouille après 5 PIN incorrects puis accepte le bon code après 15 min", async () => {
    const { app } = await boot();
    await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });

    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { phone: "771234567", pin: "000000" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "INVALID_CREDENTIALS", attemptsLeft: 5 - attempt });
    }

    const fifth = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "771234567", pin: "000000" },
    });
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json().error).toBe("LOCKED");

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "771234567", pin: "482915" },
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error).toBe("LOCKED");
    expect(locked.json().retryAfterSeconds).toBeGreaterThan(0);

    now = new Date("2026-10-17T18:16:00.000Z");
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { phone: "771234567", pin: "482915" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().token).toBeTruthy();
  });

  it("révoque la session au logout", async () => {
    const { app } = await boot();
    const created = await app.inject({ method: "POST", url: "/api/auth/register", payload: registerBody });
    const token = created.json().token as string;
    const headers = { authorization: `Bearer ${token}` };

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(out.statusCode).toBe(204);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe("UNAUTHENTICATED");

    const again = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(again.statusCode).toBe(204);
  });

  it("limite l'inscription à 10 requêtes par minute et par IP", async () => {
    const { app } = await boot();
    const headers = { "cf-connecting-ip": "203.0.113.10" };
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers,
        payload: { ...registerBody, pin: "12" },
      });
      expect(res.statusCode).toBe(400);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers,
      payload: { ...registerBody, pin: "12" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("RATE_LIMITED");
    expect(blocked.json().retryAfterSeconds).toBeGreaterThan(0);
  });
});
