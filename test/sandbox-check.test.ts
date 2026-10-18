import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LiveBitnobClient } from "../src/bitnob/live.js";
import { formatReport, reportFailed, runSandboxChecks } from "../scripts/sandbox-check.js";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("sandbox:check", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("passe les 7 vérifications contre un faux sandbox et masque les secrets", async () => {
    const invoices = new Map<string, { id: string; autoSettle: boolean }>();
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      const url = req.url ?? "";
      const send = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: payload }));
      };
      if (url === "/api/whoami") return send({ environment: "sandbox" });
      if (url === "/api/exchange-rates") {
        return send([
          { pair: "BTCUSD", buy: "66000", sell: "64000", mid: "65000" },
          { pair: "USDXOF", buy: "605", sell: "595", mid: "600" },
        ]);
      }
      if (url === "/api/trading/prices") return send({ BTCUSD: { buy: 66000, sell: 64000 } });
      if (url === "/api/lightning/invoices" && req.method === "POST") {
        const payload = JSON.parse(body) as { reference: string; auto_settle: boolean };
        const existing = invoices.get(payload.reference);
        if (existing) return send({ id: existing.id, status: "pending", request: "lntb", expires_at: "2026-10-17T18:15:00.000Z", amount: 1000 });
        const id = `inv_${invoices.size + 1}`;
        invoices.set(payload.reference, { id, autoSettle: payload.auto_settle });
        return send({ id, status: "pending", request: "lntb", expires_at: "2026-10-17T18:15:00.000Z", amount: 1000, reference: payload.reference });
      }
      if (url.startsWith("/api/lightning/invoices/")) {
        const id = decodeURIComponent(url.split("/").pop() ?? "");
        const row = [...invoices.values()].find((item) => item.id === id);
        return send({ id, status: row?.autoSettle ? "paid" : "pending", request: "lntb", expires_at: "2026-10-17T18:15:00.000Z", preimage: "ab" });
      }
      if (url === "/api/payouts/quotes" && req.method === "POST") {
        const payload = JSON.parse(body) as { country: string; to_currency: string; source: string; from_asset: string };
        expect(payload.country).toBe("SN");
        expect(payload.to_currency).toBe("XOF");
        expect(payload.source).toBe("offchain");
        expect(payload.from_asset).toBe("USDT");
        return send({ id: "qt_1", settlement_amount: "5898", exchange_rate: "590", expires_at: "2026-10-17T18:16:00.000Z", to_currency: "XOF" });
      }
      if (url === "/api/payouts/qt_1/initialize" && req.method === "POST") {
        const payload = JSON.parse(body) as { beneficiary: { account_number: string; network: string; sender: { country: string } } };
        expect(payload.beneficiary.account_number).toBe("771234567");
        expect(payload.beneficiary.network).toBe("wave");
        expect(payload.beneficiary.sender.country).toBe("SN");
        return send({ id: "po_1", status: "INITIATED", quote_id: "qt_1" });
      }
      if (url === "/api/payouts/qt_1/finalize") return send({ id: "po_1", status: "PROCESSING", quote_id: "qt_1" });
      if (url === "/api/customers" && req.method === "POST") {
        const payload = JSON.parse(body) as { email: string; customer_type: string };
        expect(payload.email.endsWith(".invalid")).toBe(true);
        expect(payload.customer_type).toBe("individual");
        return send({ id: "cus_probe" });
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const port = (server.address() as AddressInfo).port;
    const client = new LiveBitnobClient({
      clientId: "client_test",
      clientSecret: "test-secret",
      baseUrl: `http://127.0.0.1:${port}`,
      lookupIp: async () => null,
      retryDelayMs: 0,
    });
    const checks = await runSandboxChecks({
      client,
      webhookSecret: "whsec_test",
      fromAsset: "USDT",
      accountNumber: "771234567",
      pollIntervalMs: 10,
    });
    expect(reportFailed(checks)).toBe(false);
    expect(checks.map((check) => check.name)).toEqual([
      "whoami",
      "facture auto_settle",
      "webhook",
      "taux BTC/USD/XOF",
      "devis payout SN",
      "idempotence reference",
      "customer .invalid",
    ]);
    const text = formatReport({ ip: "203.0.113.10", checks }, ["test-secret", "whsec_test"]);
    expect(text).toContain("IP sortante : 203.0.113.10");
    expect(text).toContain("à constater");
    expect(text).not.toContain("test-secret");
    expect(text).not.toContain("whsec_test");
  });
});
