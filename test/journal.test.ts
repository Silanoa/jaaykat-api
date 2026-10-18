import { describe, expect, it, vi } from "vitest";
import { bitnobJournal } from "../src/bitnob/journal.js";
import { openDatabase } from "../src/db/client.js";

describe("journal des appels Bitnob", () => {
  it("enregistre chaque appel et ne garde que les plus r\u00e9cents", () => {
    const db = openDatabase(":memory:");
    const record = bitnobJournal(db, { keep: 3, now: () => new Date("2026-10-17T18:00:00.000Z") });
    for (let i = 1; i <= 5; i++) {
      record({ method: "GET", path: `/api/lightning/invoices/${i}`, status: 200, durationMs: i, correlationId: `c${i}`, attempt: 1 });
    }
    const rows = db.prepare("SELECT path, status, duration_ms AS d, correlation_id AS c, at FROM api_calls ORDER BY id").all() as {
      path: string;
      status: number;
      d: number;
      c: string;
      at: string;
    }[];
    expect(rows.map((row) => row.path)).toEqual([
      "/api/lightning/invoices/3",
      "/api/lightning/invoices/4",
      "/api/lightning/invoices/5",
    ]);
    expect(rows[2]).toMatchObject({ status: 200, d: 5, c: "c5", at: "2026-10-17T18:00:00.000Z" });
  });

  it("signale les \u00e9checs et les coupures r\u00e9seau sans bruit sur les succ\u00e8s", () => {
    const db = openDatabase(":memory:");
    const warn = vi.fn();
    const record = bitnobJournal(db, { warn });
    record({ method: "POST", path: "/api/lightning/invoices", status: 201, durationMs: 120, attempt: 1 });
    record({ method: "POST", path: "/api/lightning/invoices", status: 503, durationMs: 80, correlationId: "corr_1", attempt: 1 });
    record({ method: "GET", path: "/api/lightning/invoices/x", status: 0, durationMs: 5000, attempt: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ status: 503, correlationId: "corr_1", path: "/api/lightning/invoices" });
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ status: 0 });
  });
});
