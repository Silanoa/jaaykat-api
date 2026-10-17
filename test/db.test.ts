import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";

const TABLES = [
  "users",
  "sessions",
  "merchants",
  "payers",
  "invoices",
  "payouts",
  "webhook_events",
  "api_calls",
  "rate_snapshots",
  "credit_scores",
  "score_shares",
];

describe("sqlite", () => {
  it("ouvre en WAL, crée les tables et relit un marchand", () => {
    const dir = mkdtempSync(join(tmpdir(), "jk-db-"));
    const db = openDatabase(join(dir, "jaaykat.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of TABLES) expect(names).toContain(table);

    db.prepare(
      `INSERT INTO users (id, phone_hash, phone_masked, pin_hash, first_name, last_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("u1", "hash", "77•••••67", "pin", "Awa", "Diop", "2026-10-17T00:00:00.000Z");
    db.prepare(
      `INSERT INTO merchants (id, slug, display_name, category, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("m1", "awa-beaute", "Awa Beauté", "beaute", "u1", "2026-10-17T00:00:00.000Z");

    const row = db.prepare("SELECT display_name FROM merchants WHERE slug = ?").get("awa-beaute") as {
      display_name: string;
    };
    expect(row.display_name).toBe("Awa Beauté");
    db.close();
  });
});
