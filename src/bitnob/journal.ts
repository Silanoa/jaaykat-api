import type { Database } from "better-sqlite3";
import type { RequestLog } from "./types.js";

type JournalOptions = {
  keep?: number;
  now?: () => Date;
  warn?: (log: RequestLog) => void;
};

function defaultWarn(log: RequestLog): void {
  console.warn(JSON.stringify({ level: 40, time: Date.now(), msg: "appel Bitnob en \u00e9chec", ...log }));
}

export function bitnobJournal(db: Database, options: JournalOptions = {}): (log: RequestLog) => void {
  const keep = options.keep ?? 500;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? defaultWarn;
  const insert = db.prepare(
    "INSERT INTO api_calls (at, method, path, status, duration_ms, correlation_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const trim = db.prepare("DELETE FROM api_calls WHERE id <= (SELECT MAX(id) FROM api_calls) - ?");
  return (log) => {
    try {
      insert.run(now().toISOString(), log.method, log.path, log.status, log.durationMs, log.correlationId ?? null);
      trim.run(keep);
    } catch {
      return;
    }
    if (log.status === 0 || log.status >= 400) warn(log);
  };
}
