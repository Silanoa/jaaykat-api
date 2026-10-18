import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { seedDemo } from "../src/db/seed.js";
import { bootApp, insertSale, merchantIdOf } from "./helpers.js";

describe("historique de démonstration non retirable", () => {
  const apps: FastifyInstance[] = [];
  const clock = { now: new Date("2026-10-17T18:00:00.000Z") };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function boot() {
    const db = openDatabase(":memory:");
    const { app, config } = await bootApp(clock, db);
    apps.push(app);
    seedDemo(db, config);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "771234567", pin: "482915" } });
    expect(login.statusCode).toBe(200);
    return { app, db, headers: { authorization: `Bearer ${login.json().token as string}` } };
  }

  const quoteBody = (amountXof: number) => ({ amountXof, network: "wave", accountNumber: "771234567", accountName: "Awa Diop" });

  it("sépare le solde retirable du chiffre d'affaires de démonstration", async () => {
    const { app, db, headers } = await boot();
    const seeded = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_xof), 0) AS xof FROM invoices WHERE source = 'seed' AND status = 'paid'").get() as { n: number; xof: number };
    expect(seeded.n).toBeGreaterThan(50);
    const balance = (await app.inject({ method: "GET", url: "/api/balance", headers })).json();
    expect(balance.balanceXof).toBe(0);
    expect(balance.balanceSats).toBe(0);
    expect(balance.demoRevenueXof).toBe(seeded.xof);
    expect(balance.demoSalesCount).toBe(seeded.n);
  });

  it("refuse un devis sur le seul historique avec un message français clair", async () => {
    const { app, headers } = await boot();
    const res = await app.inject({ method: "POST", url: "/api/payouts/quote", headers, payload: quoteBody(1000) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("INSUFFICIENT_BALANCE");
    expect(res.json().retirableXof).toBe(0);
    expect(res.json().message).toBe("Solde retirable insuffisant : 0\u00a0F disponibles. Le chiffre d'affaires de démonstration n'est pas retirable.");
  });

  it("ne retire que les ventes réelles même quand le seed est plus gros", async () => {
    const { app, db, headers } = await boot();
    insertSale(db, merchantIdOf(db), { amountXof: 8000, at: new Date("2026-10-17T10:00:00.000Z") });
    const balance = (await app.inject({ method: "GET", url: "/api/balance", headers })).json();
    expect(balance.balanceXof).toBe(8000);
    expect(balance.demoRevenueXof).toBeGreaterThan(100_000);

    const over = await app.inject({ method: "POST", url: "/api/payouts/quote", headers, payload: quoteBody(8100) });
    expect(over.statusCode).toBe(422);
    expect(over.json().retirableXof).toBe(8000);
    expect(over.json().message).toContain("8\u00a0000\u00a0F disponibles");

    const exact = await app.inject({ method: "POST", url: "/api/payouts/quote", headers, payload: quoteBody(8000) });
    expect(exact.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/balance", headers })).json();
    expect(after.balanceXof).toBe(0);
    const again = await app.inject({ method: "POST", url: "/api/payouts/quote", headers, payload: quoteBody(100) });
    expect(again.statusCode).toBe(422);
  });

  it("n'annonce aucun chiffre d'affaires de démonstration à un marchand sans seed", async () => {
    const db = openDatabase(":memory:");
    const { app } = await bootApp(clock, db);
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { shopName: "Chez Fatou", category: "beaute", firstName: "Fatou", lastName: "Ba", phone: "77 555 00 11", pin: "482915" },
    });
    const headers = { authorization: `Bearer ${created.json().token as string}` };
    const balance = (await app.inject({ method: "GET", url: "/api/balance", headers })).json();
    expect(balance).toMatchObject({ balanceXof: 0, demoRevenueXof: 0, demoSalesCount: 0 });
    const res = await app.inject({ method: "POST", url: "/api/payouts/quote", headers, payload: quoteBody(1000) });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe("Solde retirable insuffisant : 0\u00a0F disponibles.");
  });
});
