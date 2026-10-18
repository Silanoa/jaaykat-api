import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MockBitnobClient } from "../src/bitnob/mock.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { ulid } from "../src/ids.js";

export type TestDb = ReturnType<typeof openDatabase>;

export function testConfig(clock: { now: Date }): AppConfig {
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
    now: () => clock.now,
  };
}

export async function bootApp(clock: { now: Date }, db: TestDb = openDatabase(":memory:")) {
  const config = testConfig(clock);
  const bitnob = new MockBitnobClient({ clientId: "mock", clientSecret: "mock", settleAfterMs: 0, now: () => clock.now.getTime() });
  const app: FastifyInstance = await buildApp({ db, bitnob, config, bitnobEnv: "mock" });
  return { app, db, config };
}

export async function registerMerchant(app: FastifyInstance, phone = "77 123 45 67", shopName = "Chez Awa") {
  const created = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { shopName, category: "beaute", firstName: "Awa", lastName: "Diop", phone, pin: "482915" },
  });
  if (created.statusCode !== 201) throw new Error(`register ${created.statusCode} ${created.body}`);
  return { headers: { authorization: `Bearer ${created.json().token as string}` } };
}

let counter = 0;

export function insertSale(
  db: TestDb,
  merchantId: string,
  sale: { amountXof: number; at: Date; status?: "paid" | "expired" | "pending"; source?: "live" | "seed" },
): void {
  counter += 1;
  const rate = 64_000 * 605;
  const status = sale.status ?? "paid";
  db.prepare(
    `INSERT INTO invoices (
       id, merchant_id, reference, amount_sats, amount_xof, rate_btc_xof, rate_source,
       channel, status, source, created_at, paid_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'btc_usd*usd_xof', 'dynamic', ?, ?, ?, ?)`,
  ).run(
    ulid(sale.at.getTime() + counter),
    merchantId,
    `jk_test_${counter}_${sale.at.getTime()}`,
    Math.max(1, Math.round((sale.amountXof / rate) * 1e8)),
    sale.amountXof,
    rate,
    status,
    sale.source ?? "live",
    sale.at.toISOString(),
    status === "paid" ? sale.at.toISOString() : null,
  );
}

export function merchantIdOf(db: TestDb): string {
  return (db.prepare("SELECT id FROM merchants ORDER BY created_at LIMIT 1").get() as { id: string }).id;
}
