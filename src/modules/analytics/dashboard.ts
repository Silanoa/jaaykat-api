import type { SalePoint } from "./types.js";
import { scoreFromSales } from "../score/formula.js";
import { DAY_NAMES, dakarMidnight, dakarParts } from "../../time.js";

export type { SalePoint } from "./types.js";

export type DashboardRange = "today" | "7d" | "30d";

export interface DashboardResult {
  range: DashboardRange;
  kpis: {
    revenueXof: number;
    deltaPct: number | null;
    salesCount: number;
    averageBasketXof: number | null;
    medianBasketXof: number | null;
    conversion: number | null;
    medianPayDelaySeconds: number | null;
    bestDay: string | null;
  };
  heatmap: { count: number; revenueXof: number }[][];
  loyal: { nickname: string; purchases: number; revenueXof: number }[];
  advice: { priority: number; text: string };
}

export function dashboardFromSales(sales: SalePoint[], range: DashboardRange, now: Date): DashboardResult {
  const bounds = rangeBounds(range, now);
  const current = sales.filter((sale) => inHalfOpen(sale.at, bounds.start, bounds.end));
  const previous = sales.filter((sale) => inHalfOpen(sale.at, bounds.prevStart, bounds.start));
  const paid = current.filter((sale) => sale.status === "paid");
  const expired = current.filter((sale) => sale.status === "expired");
  const revenue = paid.reduce((sum, sale) => sum + sale.amountXof, 0);
  const previousRevenue = previous.filter((sale) => sale.status === "paid").reduce((sum, sale) => sum + sale.amountXof, 0);
  const thirty = rangeBounds("30d", now);
  const paid30 = sales.filter((sale) => sale.status === "paid" && inHalfOpen(sale.at, thirty.start, thirty.end));
  const heatmap = emptyHeatmap();
  const byWeekday = Array.from({ length: 7 }, () => 0);
  for (const sale of paid30) {
    const parts = dakarParts(new Date(sale.at));
    const cell = heatmap[parts.weekday]?.[parts.hour];
    if (cell) {
      cell.count += 1;
      cell.revenueXof += sale.amountXof;
    }
    const bucket = byWeekday[parts.weekday];
    if (bucket !== undefined) byWeekday[parts.weekday] = bucket + sale.amountXof;
  }
  const bestIndex = byWeekday.reduce((best, value, index, all) => (value > (all[best] ?? 0) ? index : best), 0);
  const bestDay = paid30.length === 0 ? null : DAY_NAMES[bestIndex] ?? null;
  const delays = paid
    .map((sale) => (Date.parse(sale.at) - Date.parse(sale.createdAt)) / 1000)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    range,
    kpis: {
      revenueXof: revenue,
      deltaPct: previousRevenue === 0 ? null : (revenue - previousRevenue) / previousRevenue,
      salesCount: paid.length,
      averageBasketXof: paid.length === 0 ? null : revenue / paid.length,
      medianBasketXof: median(paid.map((sale) => sale.amountXof)),
      conversion: paid.length + expired.length === 0 ? null : paid.length / (paid.length + expired.length),
      medianPayDelaySeconds: median(delays),
      bestDay,
    },
    heatmap,
    loyal: loyalCustomers(paid30),
    advice: adviceFor(sales, now, byWeekday, bestIndex),
  };
}

function adviceFor(sales: SalePoint[], now: Date, byWeekday: number[], bestIndex: number): { priority: number; text: string } {
  const week = slicePaid(sales, rangeBounds("7d", now), now);
  const month = slicePaid(sales, rangeBounds("30d", now), now);
  const weekAll = sales.filter((sale) => inHalfOpen(sale.at, rangeBounds("7d", now).start, rangeBounds("7d", now).end));
  const weekExpired = weekAll.filter((sale) => sale.status === "expired").length;
  const weekTerminal = week.length + weekExpired;
  const conversion = weekTerminal === 0 ? 1 : week.length / weekTerminal;
  if (conversion < 0.7 && weekTerminal >= 5) {
    return { priority: 1, text: "3 clients sur 10 n'ont pas payé. Montrez le QR de plus près." };
  }
  const today = dakarParts(now);
  const peak = peakWindow(month);
  if (today.weekday === bestIndex && byWeekday[bestIndex] && today.hour < peak.start && month.length > 0) {
    const dayRevenue = byWeekday[bestIndex] ?? 0;
    const share = dayRevenue === 0 ? 0 : Math.round((peak.revenue / dayRevenue) * 100);
    const day = DAY_NAMES[bestIndex] ?? "jour";
    return {
      priority: 2,
      text: `Le ${day}, vous faites ${share} % de vos ventes entre ${peak.start}h et ${peak.end}h. Préparez votre stock avant ${peak.start}h.`,
    };
  }
  const pm7 = average(week.map((sale) => sale.amountXof));
  const pm30 = average(month.map((sale) => sale.amountXof));
  if (pm7 !== null && pm30 !== null && pm30 > 0 && pm7 < 0.85 * pm30) {
    const drop = Math.round((1 - pm7 / pm30) * 100);
    return {
      priority: 3,
      text: `Votre panier moyen a baissé de ${drop} %. Essayez un lot à ${Math.round(pm30)} F.`,
    };
  }
  const absent = absentLoyal(month, now);
  if (absent) {
    return {
      priority: 4,
      text: `${absent.nickname} venait tous les ${absent.every} jours, rien depuis ${absent.since} jours. Un petit message ?`,
    };
  }
  if (scoreFromSales(sales, now).components.regularity < 0.5) {
    return { priority: 5, text: "Encaissez au moins une vente par jour pour faire monter votre score." };
  }
  const yesterdayStart = dakarMidnight(now) - 86_400_000;
  const yesterday = sales.filter((sale) => sale.status === "paid" && inHalfOpen(sale.at, yesterdayStart, yesterdayStart + 86_400_000));
  const yesterdayRevenue = yesterday.reduce((sum, sale) => sum + sale.amountXof, 0);
  const daily = month.length === 0 ? 0 : month.reduce((sum, sale) => sum + sale.amountXof, 0) / 30;
  return {
    priority: 6,
    text: `Hier : ${yesterday.length} ventes, ${formatAmount(yesterdayRevenue)} F. Objectif du jour : ${formatAmount(Math.round(daily * 1.1))} F.`,
  };
}

function peakWindow(paid: SalePoint[]): { start: number; end: number; revenue: number } {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const sale of paid) hours[dakarParts(new Date(sale.at)).hour] = (hours[dakarParts(new Date(sale.at)).hour] ?? 0) + sale.amountXof;
  let best = { start: 18, end: 20, revenue: 0 };
  for (let hour = 0; hour < 23; hour++) {
    const revenue = (hours[hour] ?? 0) + (hours[hour + 1] ?? 0);
    if (revenue > best.revenue) best = { start: hour, end: hour + 2, revenue };
  }
  return best;
}

function absentLoyal(paid: SalePoint[], now: Date): { nickname: string; every: number; since: number } | null {
  const groups = new Map<string, { nickname: string; times: number[] }>();
  for (const sale of paid) {
    if (!sale.payerKey || !sale.nickname) continue;
    const group = groups.get(sale.payerKey) ?? { nickname: sale.nickname, times: [] };
    group.times.push(Date.parse(sale.at));
    groups.set(sale.payerKey, group);
  }
  let chosen: { nickname: string; every: number; since: number; ratio: number } | null = null;
  for (const group of groups.values()) {
    if (group.times.length < 2) continue;
    const times = group.times.sort((a, b) => a - b);
    const intervals: number[] = [];
    for (let index = 1; index < times.length; index++) {
      const previous = times[index - 1];
      const current = times[index];
      if (previous === undefined || current === undefined) continue;
      intervals.push((current - previous) / 86_400_000);
    }
    const every = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const last = times[times.length - 1];
    if (last === undefined || every <= 0) continue;
    const since = (now.getTime() - last) / 86_400_000;
    if (since <= every * 2) continue;
    const ratio = since / every;
    if (!chosen || ratio > chosen.ratio) {
      chosen = { nickname: group.nickname, every: Math.max(1, Math.round(every)), since: Math.max(1, Math.round(since)), ratio };
    }
  }
  return chosen ? { nickname: chosen.nickname, every: chosen.every, since: chosen.since } : null;
}

function loyalCustomers(paid: SalePoint[]): { nickname: string; purchases: number; revenueXof: number }[] {
  const groups = new Map<string, { nickname: string; purchases: number; revenueXof: number }>();
  for (const sale of paid) {
    if (!sale.payerKey) continue;
    const current = groups.get(sale.payerKey) ?? { nickname: sale.nickname || "Client", purchases: 0, revenueXof: 0 };
    current.purchases += 1;
    current.revenueXof += sale.amountXof;
    if (sale.nickname) current.nickname = sale.nickname;
    groups.set(sale.payerKey, current);
  }
  return [...groups.values()]
    .filter((payer) => payer.purchases >= 2)
    .sort((a, b) => b.revenueXof - a.revenueXof)
    .slice(0, 5);
}

function slicePaid(sales: SalePoint[], bounds: { start: number; end: number }, _now: Date): SalePoint[] {
  return sales.filter((sale) => sale.status === "paid" && inHalfOpen(sale.at, bounds.start, bounds.end));
}

function rangeBounds(range: DashboardRange, now: Date): { start: number; end: number; prevStart: number } {
  const today = dakarMidnight(now);
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const end = today + 86_400_000;
  const start = end - days * 86_400_000;
  return { start, end, prevStart: start - days * 86_400_000 };
}

function inHalfOpen(iso: string, start: number, end: number): boolean {
  const time = Date.parse(iso);
  return time >= start && time < end;
}

function emptyHeatmap(): { count: number; revenueXof: number }[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ count: 0, revenueXof: 0 })));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("fr-FR").format(amount);
}
