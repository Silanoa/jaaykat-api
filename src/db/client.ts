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
    db.pragma("user_version = 2");
  } else if (version < 2) {
    const columns = db.prepare("PRAGMA table_info(invoices)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "simulated_method")) {
      db.exec("ALTER TABLE invoices ADD COLUMN simulated_method TEXT");
    }
    db.pragma("user_version = 2");
  }
  return db;
}
