import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.exec(schemaSql);
  } else {
    if (version < 2 && !hasColumn(db, "invoices", "simulated_method")) {
      db.exec("ALTER TABLE invoices ADD COLUMN simulated_method TEXT");
    }
    if (version < 3 && hasColumn(db, "score_shares", "token_id")) {
      if (!hasColumn(db, "score_shares", "snapshot")) db.exec("ALTER TABLE score_shares ADD COLUMN snapshot TEXT");
      db.exec("UPDATE score_shares SET revoked = 1 WHERE snapshot IS NULL");
    }
  }
  if (version < 3) db.pragma("user_version = 3");
  return db;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((entry) => entry.name === column);
}
