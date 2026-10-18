import type { Database } from "better-sqlite3";
import type { BitnobClient, RatesSnapshot } from "../../bitnob/types.js";

export class RateCache {
  private entry: { at: number; validForMs: number; data: RatesSnapshot } | null = null;

  async get(db: Database, bitnob: BitnobClient, nowMs: number): Promise<RatesSnapshot> {
    if (this.entry && nowMs < this.entry.at + this.entry.validForMs) return this.entry.data;
    const data = await bitnob.rates.get();
    const validForSeconds = Math.min(data.btcUsd.validForSeconds, data.usdXof.validForSeconds);
    const at = new Date(nowMs).toISOString();
    const insert = db.prepare(
      `INSERT INTO rate_snapshots (at, pair, mid, buy, sell, valid_for_s) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(at, data.btcUsd.pair, data.btcUsd.mid, data.btcUsd.buy, data.btcUsd.sell, data.btcUsd.validForSeconds);
    insert.run(at, data.usdXof.pair, data.usdXof.mid, data.usdXof.buy, data.usdXof.sell, data.usdXof.validForSeconds);
    if (data.btcXof) {
      insert.run(at, data.btcXof.pair, data.btcXof.mid, data.btcXof.buy, data.btcXof.sell, data.btcXof.validForSeconds);
    }
    this.entry = { at: nowMs, validForMs: validForSeconds * 1000, data };
    return data;
  }
}
