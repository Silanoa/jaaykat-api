import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import { parseWebhook, verifyWebhookSignature } from "../bitnob/webhooks.js";
import type { BitnobClient, PayoutStatus } from "../bitnob/types.js";
import type { AppConfig } from "../config.js";
import { applyRemoteStatus, type InvoiceRow } from "../modules/invoices/service.js";
import { ulid } from "../ids.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function registerWebhookRoute(app: FastifyInstance, db: Database, bitnob: BitnobClient, config: AppConfig): void {
  app.post("/webhooks/bitnob", async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = headerValue(req.headers["x-bitnob-signature"]);
    const now = config.now().toISOString();
    if (!verifyWebhookSignature(raw, signature, config.webhookSecret)) {
      const dedupe = `invalid:${createHash("sha256").update(raw).digest("hex")}`;
      db.prepare(
        `INSERT INTO webhook_events (id, dedupe_key, event_type, signature_valid, raw_body, received_at)
         VALUES (?, ?, NULL, 0, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      ).run(ulid(config.now().getTime()), dedupe, raw.toString("utf8"), now);
      return reply.code(401).send({ error: "INVALID_SIGNATURE", message: "Signature webhook invalide." });
    }

    const event = parseWebhook(raw, headerValue(req.headers["x-bitnob-event-id"]));
    const inserted = db
      .prepare(
        `INSERT INTO webhook_events (id, dedupe_key, event_type, signature_valid, raw_body, received_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(ulid(config.now().getTime()), event.dedupeKey, event.event, raw.toString("utf8"), now);
    if (inserted.changes === 0) return reply.code(200).send({ ok: true, duplicate: true });

    try {
      await applyEvent(db, bitnob, config, event.data);
      db.prepare("UPDATE webhook_events SET processed_at = ? WHERE dedupe_key = ?").run(config.now().toISOString(), event.dedupeKey);
    } catch (error) {
      db.prepare("DELETE FROM webhook_events WHERE dedupe_key = ?").run(event.dedupeKey);
      const message = error instanceof Error ? error.message : "erreur";
      req.log.error({ message }, "webhook");
      return reply.code(500).send({ error: "WEBHOOK_FAILED", message: "Traitement du webhook impossible." });
    }
    return reply.code(200).send({ ok: true });
  });
}

async function applyEvent(
  db: Database,
  bitnob: BitnobClient,
  config: AppConfig,
  data: Record<string, unknown>,
): Promise<void> {
  const id = typeof data.id === "string" ? data.id : "";
  const reference = typeof data.reference === "string" ? data.reference : "";
  if (!id && !reference) return;
  const invoice = db
    .prepare("SELECT * FROM invoices WHERE bitnob_invoice_id = ? OR reference = ?")
    .get(id, reference || id) as InvoiceRow | undefined;
  if (invoice?.bitnob_invoice_id) {
    const remote = await bitnob.lightning.getInvoice(invoice.bitnob_invoice_id);
    applyRemoteStatus(db, invoice, remote, "webhook", config.now());
    return;
  }
  const payout = db
    .prepare("SELECT id, status, bitnob_payout_id FROM payouts WHERE bitnob_payout_id = ? OR bitnob_quote_id = ? OR reference = ?")
    .get(id, id, reference) as { id: string; status: string; bitnob_payout_id: string | null } | undefined;
  if (!payout?.bitnob_payout_id) return;
  const remote = await bitnob.payouts.get(payout.bitnob_payout_id);
  const next = mapPayoutStatus(remote.status);
  if (!next || !canAdvancePayout(payout.status, next)) return;
  db.prepare("UPDATE payouts SET status = ?, updated_at = ? WHERE id = ?").run(next, config.now().toISOString(), payout.id);
}

function mapPayoutStatus(status: PayoutStatus): string | null {
  switch (status) {
    case "INITIATED":
    case "PENDING":
      return "initiated";
    case "PROCESSING":
      return "processing";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "QUOTE":
      return null;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function canAdvancePayout(current: string, next: string): boolean {
  const order = ["quoted", "initiated", "processing", "completed", "failed", "expired"];
  if (current === "completed" || current === "failed" || current === "expired") return false;
  if (next === "failed" || next === "expired") return current !== "completed";
  return order.indexOf(next) >= order.indexOf(current);
}
