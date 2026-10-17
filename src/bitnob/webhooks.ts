import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface BitnobEvent {
  eventId: string;
  event: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string | string[],
): boolean {
  if (!header || header.length === 0) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const provided = Buffer.from(header);
  const secrets = Array.isArray(secret) ? secret : [secret];
  for (const item of secrets) {
    if (!item) continue;
    const expectedHex = createHmac("sha512", item).update(body).digest("hex");
    const expected = Buffer.from(expectedHex);
    if (expected.length !== provided.length) continue;
    if (timingSafeEqual(expected, provided)) return true;
  }
  return false;
}

export function parseWebhook(rawBody: string | Buffer, headerEventId?: string): BitnobEvent {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const parsed = JSON.parse(text) as { event_id?: unknown; event?: unknown; data?: unknown };
  const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : {};
  const event = typeof parsed.event === "string" ? parsed.event : "";
  const fromBody = typeof parsed.event_id === "string" ? parsed.event_id : "";
  const eventId = fromBody || headerEventId || "";
  const fallback = createHash("sha256")
    .update(`${event}:${String(data.id ?? "")}:${String(data.status ?? "")}`)
    .digest("hex");
  return { eventId, event, data, dedupeKey: eventId || fallback };
}
