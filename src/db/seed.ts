import { createHmac } from "node:crypto";
import type { Database } from "better-sqlite3";
import { maskPhone } from "../auth/phone.js";
import { hashPin } from "../auth/pin.js";
import { loadConfig, type AppConfig } from "../config.js";
import { ulid } from "../ids.js";
import { openDatabase } from "./client.js";
import { buildSeedSales } from "./seed-data.js";

export const DEMO_PHONE = "+221771234567";
export const DEMO_PIN = "482915";
const DEMO_RATE = 64_000 * 605;

export function seedDemo(db: Database, config: AppConfig): { slug: string } {
  const now = config.now();
  const phoneHash = createHmac("sha256", config.phonePepper).update(DEMO_PHONE).digest("hex");
  let user = db.prepare("SELECT id FROM users WHERE phone_hash = ?").get(phoneHash) as { id: string } | undefined;
  if (!user) {
    const userId = ulid(now.getTime());
    const merchantId = ulid(now.getTime() + 1);
    const createdAt = now.toISOString();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, phone_hash, phone_masked, pin_hash, first_name, last_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?, 'Awa', 'Diop', ?, ?)`,
      ).run(userId, phoneHash, maskPhone(DEMO_PHONE), hashPin(DEMO_PIN), createdAt, createdAt);
      db.prepare(
        `INSERT INTO merchants (id, slug, display_name, category, user_id, bitnob_customer_id, created_at)
         VALUES (?, 'awa-beaute', 'Awa Beauté', 'beaute', ?, 'seed_awa_beaute', ?)`,
      ).run(merchantId, userId, createdAt);
    });
    insert();
    user = { id: userId };
  }
  const merchant = db.prepare("SELECT id FROM merchants WHERE user_id = ?").get(user.id) as { id: string };
  db.prepare("DELETE FROM invoices WHERE merchant_id = ? AND source = 'seed'").run(merchant.id);
  db.prepare(
    `DELETE FROM payers WHERE merchant_id = ? AND id NOT IN (SELECT payer_id FROM invoices WHERE payer_id IS NOT NULL)`,
  ).run(merchant.id);

  const sales = buildSeedSales(now);
  const insertInvoice = db.prepare(
    `INSERT INTO invoices (
       id, merchant_id, payer_id, reference, amount_sats, amount_xof, rate_btc_xof, rate_source,
       description, channel, status, source, created_at, paid_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'btc_usd*usd_xof', ?, 'dynamic', ?, 'seed', ?, ?)`,
  );
  const findPayer = db.prepare("SELECT id FROM payers WHERE merchant_id = ? AND payer_ref = ?");
  const insertPayer = db.prepare(
    `INSERT INTO payers (id, merchant_id, payer_ref, nickname, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const write = db.transaction(() => {
    sales.forEach((sale, index) => {
      let payerId: string | null = null;
      if (sale.payerKey) {
        const existing = findPayer.get(merchant.id, sale.payerKey) as { id: string } | undefined;
        if (existing) {
          payerId = existing.id;
        } else {
          payerId = ulid(now.getTime() + index + 2);
          insertPayer.run(payerId, merchant.id, sale.payerKey, sale.nickname, sale.createdAt, sale.at);
        }
      }
      const sats = Math.max(1, Math.round((sale.amountXof / DEMO_RATE) * 1e8));
      const stamp = now.getTime() + 10_000 + index;
      insertInvoice.run(
        ulid(stamp),
        merchant.id,
        payerId,
        `jk_awa-beaute_${ulid(stamp + sales.length)}`,
        sats,
        sale.amountXof,
        DEMO_RATE,
        sale.status === "paid" ? "Vente historique" : null,
        sale.status === "expired" ? "expired" : "paid",
        sale.createdAt,
        sale.status === "paid" ? sale.at : null,
      );
    });
  });
  write();
  return { slug: "awa-beaute" };
}

const isDirectRun = process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js");
if (isDirectRun) {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  seedDemo(db, config);
  console.log("Historique simulé chargé pour Awa Beauté. Connexion : 77 123 45 67 / PIN 482915. Ces ventes ne sont pas retirables.");
  db.close();
}
