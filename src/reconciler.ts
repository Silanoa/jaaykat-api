import type { Database } from "better-sqlite3";
import type { BitnobClient } from "./bitnob/types.js";
import type { AppConfig } from "./config.js";
import { applyRemoteStatus, ensureRemoteInvoice, type InvoicePolls, type InvoiceRow } from "./modules/invoices/service.js";

export type { InvoicePolls };

export async function reconcilePending(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  polls: InvoicePolls,
): Promise<void> {
  const nowMs = config.now().getTime();
  const cutoff = new Date(nowMs - 20_000).toISOString();
  const unstarted = db
    .prepare(
      `SELECT * FROM invoices
       WHERE status = 'pending' AND source = 'live' AND simulated_method IS NOT NULL AND bitnob_invoice_id IS NULL`,
    )
    .all() as InvoiceRow[];
  for (const row of unstarted) void ensureRemoteInvoice(db, bitnob, config, polls, row);
  const rows = db
    .prepare(`SELECT * FROM invoices WHERE status = 'pending' AND source = 'live' AND created_at <= ?`)
    .all(cutoff) as InvoiceRow[];
  for (const row of rows) {
    const seen = polls.lastSeen.get(row.id);
    if (seen !== undefined && nowMs - seen < 20_000) continue;
    if (!row.bitnob_invoice_id) continue;
    const last = polls.lastFetch.get(row.id) ?? 0;
    if (nowMs - last < 2000) continue;
    polls.lastFetch.set(row.id, nowMs);
    try {
      const remote = await bitnob.lightning.getInvoice(row.bitnob_invoice_id);
      applyRemoteStatus(db, row, remote, "reconcile", config.now());
    } catch {
      continue;
    }
  }
}
