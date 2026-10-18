import type { SalePoint } from "../modules/analytics/types.js";
import { dakarParts } from "../time.js";

const NAMES = ["Fatou", "Moussa", "Aïda", "Ibrahima", "Khady", "Omar", "Bineta", "Cheikh", "Astou", "Pape", "Ndeye", "Modou"];
const AMOUNTS = [1000, 1500, 2000, 2500, 3500, 5000, 7500];

export function buildSeedSales(now: Date): SalePoint[] {
  const random = mulberry32(20261017);
  const sales: SalePoint[] = [];
  const origin = now.getTime() - 60 * 86_400_000;
  for (let day = 0; day <= 60; day++) {
    const cursor = new Date(origin + day * 86_400_000);
    const parts = dakarParts(cursor);
    const growth = 1 + 0.22 * (day / 60);
    let expected = 3.2 * growth;
    if (parts.weekday === 5) expected *= 1.8;
    if (parts.weekday === 6) expected *= 0.7;
    if (parts.weekday !== 5 && random() < 0.18) continue;
    const count = Math.max(1, Math.round(expected + (random() - 0.5) * 2));
    for (let index = 0; index < count; index++) {
      const hour = pickHour(random);
      const minute = Math.floor(random() * 60);
      const [year, month, date] = parts.dateKey.split("-").map(Number);
      const at = new Date(Date.UTC(year ?? 2026, (month ?? 1) - 1, date ?? 1, hour, minute, 0));
      const recurring = random() < 0.42;
      const nameIndex = Math.floor(random() * NAMES.length);
      const nickname = recurring ? NAMES[nameIndex] ?? "Client" : null;
      sales.push({
        at: at.toISOString(),
        createdAt: new Date(at.getTime() - 4_000 - Math.floor(random() * 12_000)).toISOString(),
        amountXof: AMOUNTS[Math.floor(random() * AMOUNTS.length)] ?? 2500,
        status: random() < 0.07 ? "expired" : "paid",
        payerKey: nickname ? `payer-${nameIndex}` : random() < 0.25 ? `once-${day}-${index}` : null,
        nickname,
        source: "seed",
      });
    }
  }
  for (let nameIndex = 0; nameIndex < NAMES.length; nameIndex++) {
    const nickname = NAMES[nameIndex] ?? "Client";
    if (sales.some((sale) => sale.nickname === nickname)) continue;
    const at = new Date(now.getTime() - (nameIndex + 1) * 86_400_000);
    sales.push({
      at: at.toISOString(),
      createdAt: new Date(at.getTime() - 5_000).toISOString(),
      amountXof: 2500,
      status: "paid",
      payerKey: `payer-${nameIndex}`,
      nickname,
      source: "seed",
    });
  }
  sales.sort((a, b) => a.at.localeCompare(b.at));
  return sales;
}

function pickHour(random: () => number): number {
  const weights = Array.from({ length: 24 }, (_, hour) => {
    if (hour >= 12 && hour <= 14) return 6;
    if (hour >= 18 && hour <= 20) return 7;
    if (hour >= 9 && hour <= 21) return 1.4;
    return 0.15;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = random() * total;
  for (let hour = 0; hour < weights.length; hour++) {
    cursor -= weights[hour] ?? 0;
    if (cursor <= 0) return hour;
  }
  return 18;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
