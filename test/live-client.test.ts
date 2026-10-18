import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BitnobError, BitnobIpNotWhitelistedError } from "../src/bitnob/errors.js";
import { createBitnobClient } from "../src/bitnob/factory.js";
import { LiveBitnobClient, signRequest } from "../src/bitnob/live.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { resetBitnobEnvCache } from "../src/bitnob/environment.js";

const CLIENT_ID = "client_test";
const SECRET = "test-secret";

function signature(body: string, timestamp: string, nonce: string): string {
  return createHmac("sha256", SECRET).update(`${CLIENT_ID}:${timestamp}:${nonce}:${body}`).digest("hex");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function assertSigned(req: IncomingMessage, body: string): void {
  const timestamp = header(req, "x-auth-timestamp");
  const nonce = header(req, "x-auth-nonce");
  const provided = header(req, "x-auth-signature");
  expect(header(req, "x-auth-client")).toBe(CLIENT_ID);
  expect(timestamp).toMatch(/^\d+$/);
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  const expected = signature(body, timestamp, nonce);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  expect(a.length).toBe(b.length);
  expect(timingSafeEqual(a, b)).toBe(true);
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    handler(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("client Bitnob live", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    resetBitnobEnvCache();
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("signe le corps exact et une chaîne vide", () => {
    expect(
      signRequest({
        clientId: CLIENT_ID,
        clientSecret: SECRET,
        timestamp: "1700000000",
        nonce: "00112233445566778899aabbccddeeff",
        body: "",
      }),
    ).toBe("07a73dde68896acdb7ed3d52fbb46633cd1ca67c5ca7b07f7e87f0b5b37d0ed8");
    expect(
      signRequest({
        clientId: CLIENT_ID,
        clientSecret: SECRET,
        timestamp: "1700000000",
        nonce: "00112233445566778899aabbccddeeff",
        body: '{"a":1}',
      }),
    ).toBe("79f7e510474a81ff60496c4113eb7938413a7b2e37445b4c303105ed236fecde");
  });

  it("crée une facture signée et relit le statut", async () => {
    const seen: string[] = [];
    const fake = await listen((req, res, body) => {
      assertSigned(req, body);
      seen.push(`${req.method} ${req.url}`);
      if (req.url === "/api/lightning/invoices" && req.method === "POST") {
        const payload = JSON.parse(body) as { amount: number; auto_settle: boolean; reference: string; customer_id: string };
        expect(payload.amount).toBe(4200);
        expect(payload.auto_settle).toBe(true);
        expect(payload.customer_id).toBe("cus_1");
        expect(Number.isInteger(payload.amount)).toBe(true);
        res.writeHead(200, { "content-type": "application/json", "x-correlation-id": "corr_1" });
        res.end(JSON.stringify({ data: { id: "inv_1", request: "lntb1", status: "pending", payment_hash: "hash", expires_at: "1774192723", reference: payload.reference, amount: 4200 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id: "inv_1", bolt11: "lntb1", status: "paid", payment_hash: "hash", expires_at: "2026-10-17T18:00:05.000Z", preimage: "ab" } }));
    });
    closers.push(fake.close);
    const logs: string[] = [];
    const client = new LiveBitnobClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      baseUrl: fake.baseUrl,
      lookupIp: async () => "203.0.113.10",
      onRequest: (log) => logs.push(`${log.method} ${log.path} ${log.status} ${log.correlationId ?? ""}`),
    });
    const created = await client.lightning.createInvoice({
      amountSats: 4200,
      description: "Huile",
      reference: "jk_awa_01",
      customerId: "cus_1",
      expirySeconds: 900,
      autoSettle: true,
    });
    expect(created.id).toBe("inv_1");
    expect(created.bolt11).toBe("lntb1");
    expect(created.status).toBe("pending");
    expect(created.expiresAt.toISOString()).toBe("2026-03-22T15:18:43.000Z");
    const paid = await client.lightning.getInvoice("inv_1");
    expect(paid.status).toBe("paid");
    expect(paid.preimage).toBe("ab");
    expect(seen).toEqual(["POST /api/lightning/invoices", "GET /api/lightning/invoices/inv_1"]);
    expect(logs.join(" ")).toContain("corr_1");
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("traduit un 403 whitelist en français avec l'IP sortante", async () => {
    const fake = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "IP address not whitelisted" }));
    });
    closers.push(fake.close);
    const client = new LiveBitnobClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      baseUrl: fake.baseUrl,
      lookupIp: async () => "203.0.113.10",
    });
    await expect(client.whoami()).rejects.toBeInstanceOf(BitnobIpNotWhitelistedError);
    try {
      await client.whoami();
    } catch (error) {
      expect(error).toBeInstanceOf(BitnobIpNotWhitelistedError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(/203\.0\.113\.10/);
      expect(message).toMatch(/Autorisez l'IP sortante/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(CLIENT_ID);
    }
  });

  it("ne rejoue pas un 401", async () => {
    let hits = 0;
    const fake = await listen((_req, res) => {
      hits += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
    });
    closers.push(fake.close);
    const client = new LiveBitnobClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      baseUrl: fake.baseUrl,
      lookupIp: async () => null,
      retryDelayMs: 0,
    });
    await expect(client.balances.get()).rejects.toMatchObject({ status: 401 });
    expect(hits).toBe(1);
    try {
      await client.balances.get();
    } catch (error) {
      expect(error).toBeInstanceOf(BitnobError);
      expect(error instanceof Error ? error.message : "").not.toContain(SECRET);
    }
  });

  it("branche le mode live dans la factory", () => {
    const client = createBitnobClient({
      nodeEnv: "test",
      port: 0,
      databasePath: ":memory:",
      publicUrl: "",
      bitnobMode: "live",
      bitnobBaseUrl: "http://127.0.0.1:9",
      bitnobClientId: CLIENT_ID,
      bitnobClientSecret: SECRET,
      webhookSecret: "whsec",
      phonePepper: "phone-pepper-0123456789abcdef",
      payerPepper: "payer-pepper-0123456789abcdef",
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: true,
      demoPayMode: "auto",
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => new Date("2026-10-17T18:00:00.000Z"),
    });
    expect(client).toBeInstanceOf(LiveBitnobClient);
  });

  it("met en cache le whoami pour /api/system et replie sur le mode", async () => {
    let whoamiHits = 0;
    const fake = await listen((req, res, body) => {
      assertSigned(req, body);
      if (req.url === "/api/whoami") {
        whoamiHits += 1;
        if (whoamiHits > 2) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "down" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { environment: "sandbox" } }));
        return;
      }
      if (req.url === "/api/customers" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "cus_1" } }));
        return;
      }
      if (req.url === "/api/balances") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ asset: "USDT", available: "10" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    closers.push(fake.close);
    const now = new Date("2026-10-17T18:00:00.000Z");
    const config: AppConfig = {
      nodeEnv: "test",
      port: 0,
      databasePath: ":memory:",
      publicUrl: "https://demo.example",
      bitnobMode: "live",
      bitnobBaseUrl: fake.baseUrl,
      bitnobClientId: CLIENT_ID,
      bitnobClientSecret: SECRET,
      webhookSecret: "whsec_test",
      phonePepper: "phone-pepper-0123456789abcdef",
      payerPepper: "payer-pepper-0123456789abcdef",
      publicDir: "/tmp/jaaykat-no-public",
      autoSettle: true,
      demoPayMode: "auto",
      payoutFromAsset: "USDT",
      reconcileIntervalMs: 0,
      now: () => now,
    };
    const db = openDatabase(":memory:");
    const bitnob = new LiveBitnobClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      baseUrl: fake.baseUrl,
      lookupIp: async () => null,
      retryDelayMs: 0,
    });
    const app = await buildApp({ db, bitnob, config, bitnobEnv: "live" });
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        shopName: "Awa Beauté",
        category: "beaute",
        firstName: "Awa",
        lastName: "Diop",
        phone: "77 123 45 67",
        pin: "482915",
      },
    });
    expect(created.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${created.json().token}` };
    const first = await app.inject({ method: "GET", url: "/api/system", headers });
    const second = await app.inject({ method: "GET", url: "/api/system", headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().env).toBe("sandbox");
    expect(second.json().env).toBe("sandbox");
    expect(whoamiHits).toBe(1);
    resetBitnobEnvCache();
    whoamiHits = 3;
    const fallback = await app.inject({ method: "GET", url: "/api/system", headers });
    expect(fallback.json().env).toBe("live");
    await app.close();
  });

  it("ne rejoue automatiquement que les lectures et la creation de facture par reference", async () => {
    const hits = new Map<string, number>();
    const fake = await listen((req, res, body) => {
      const key = `${req.method} ${req.url?.split("?")[0]}`;
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      if (key === "POST /api/lightning/invoices" && count >= 2) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "inv_1", status: "pending", request: "lntb1x", expires_at: 4102444800, amount: 1000, reference: "ref-1" } }));
        return;
      }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "down", body }));
    });
    closers.push(fake.close);
    const client = new LiveBitnobClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      baseUrl: fake.baseUrl,
      lookupIp: async () => null,
      retryDelayMs: 0,
    });
    await expect(client.balances.get()).rejects.toMatchObject({ status: 503 });
    expect(hits.get("GET /api/balances")).toBe(3);
    await client.lightning.createInvoice({ amountSats: 1000, reference: "ref-1", expiresInSeconds: 900, autoSettle: true } as never);
    expect(hits.get("POST /api/lightning/invoices")).toBe(2);
    await expect(
      client.payouts.quote({ amount: 10, country: "SN", fromAsset: "USDT", toCurrency: "XOF", source: "offchain", reference: "q-1" } as never),
    ).rejects.toMatchObject({ status: 503 });
    expect(hits.get("POST /api/payouts/quotes")).toBe(1);
    await expect(
      client.payouts.initialize("QT2_1", {
        reference: "p-1",
        callbackUrl: "https://demo.example/webhooks/bitnob",
        customerId: "cus_1",
        beneficiary: { account_number: "771234567", network: "wave", account_name: "Awa Diop" },
      } as never),
    ).rejects.toMatchObject({ status: 503 });
    expect(hits.get("POST /api/payouts/QT2_1/initialize")).toBe(1);
    await expect(client.payouts.finalize("QT2_1")).rejects.toMatchObject({ status: 503 });
    expect(hits.get("POST /api/payouts/QT2_1/finalize")).toBe(1);
  });
});
