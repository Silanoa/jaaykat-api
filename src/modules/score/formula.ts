import type { SalePoint } from "../analytics/types.js";
import { dakarMidnight, dakarParts, daysBetweenKeys } from "../../time.js";

export interface ScoreComponents {
  regularity: number;
  growth: number;
  volume: number;
  fidelity: number;
  quality: number;
}

export interface ScoreAction {
  component: keyof ScoreComponents;
  points: number;
  text: string;
}

export interface ScoreResult {
  eligible: boolean;
  score: number | null;
  band: "A" | "B" | "C" | "D" | null;
  components: ScoreComponents;
  actions: ScoreAction[];
  progress: { days: number; sales: number };
  windowDays: 90;
}

const WEIGHTS: Record<keyof ScoreComponents, number> = {
  regularity: 0.4,
  growth: 0.3,
  volume: 0.1,
  fidelity: 0.1,
  quality: 0.1,
};

const VOLUME_CAP = 1_500_000;

export function scoreFromComponents(components: ScoreComponents, eligible: boolean, progress = { days: 0, sales: 0 }): ScoreResult {
  const weighted =
    WEIGHTS.regularity * components.regularity +
    WEIGHTS.growth * components.growth +
    WEIGHTS.volume * components.volume +
    WEIGHTS.fidelity * components.fidelity +
    WEIGHTS.quality * components.quality;
  const score = eligible ? Math.round(100 * weighted) : null;
  return {
    eligible,
    score,
    band: score === null ? null : bandFor(score),
    components,
    actions: eligible ? actionsFor(components) : [],
    progress,
    windowDays: 90,
  };
}

export function scoreFromSales(sales: SalePoint[], now: Date): ScoreResult {
  const start = now.getTime() - 90 * 86_400_000;
  const inWindow = sales.filter((sale) => Date.parse(sale.at) >= start && Date.parse(sale.at) <= now.getTime());
  const paid = inWindow.filter((sale) => sale.status === "paid");
  const expired = inWindow.filter((sale) => sale.status === "expired");
  const first = paid.reduce<string | null>((earliest, sale) => {
    const key = dakarParts(new Date(sale.at)).dateKey;
    return earliest === null || key < earliest ? key : earliest;
  }, null);
  const todayKey = dakarParts(now).dateKey;
  const days = first ? Math.max(0, daysBetweenKeys(first, todayKey)) : 0;
  const active = new Set(paid.map((sale) => dakarParts(new Date(sale.at)).dateKey)).size;
  const weeks = completeWeeks(paid, now, first);
  const cv = coefficientOfVariation(weeks);
  const activeRatio = days === 0 ? 0 : active / days;
  const regularity = clamp(0.6 * activeRatio + 0.4 * (1 - Math.min(cv, 1)), 0, 1);
  const revenue30 = sumBetween(paid, now.getTime() - 30 * 86_400_000, now.getTime());
  const revenuePrev = sumBetween(paid, now.getTime() - 60 * 86_400_000, now.getTime() - 30 * 86_400_000);
  const growth = days >= 60 ? clamp(0.5 + (revenue30 - revenuePrev) / Math.max(revenuePrev, 1) / 2, 0, 1) : growthFromSlope(weeks);
  const volume = Math.min(1, Math.log10(1 + revenue30) / Math.log10(1 + VOLUME_CAP));
  const fidelity = fidelityScore(paid);
  const quality = paid.length + expired.length === 0 ? 1 : paid.length / (paid.length + expired.length);
  const eligible = days >= 14 && paid.length >= 20;
  return scoreFromComponents(
    { regularity, growth, volume, fidelity, quality },
    eligible,
    { days, sales: paid.length },
  );
}

function bandFor(score: number): "A" | "B" | "C" | "D" {
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  return "D";
}

function actionsFor(components: ScoreComponents): ScoreAction[] {
  const ranked = (Object.keys(WEIGHTS) as (keyof ScoreComponents)[])
    .map((component) => ({
      component,
      manque: WEIGHTS[component] * (1 - components[component]) * 100,
    }))
    .sort((a, b) => b.manque - a.manque)
    .slice(0, 2);
  return ranked.map((item) => {
    const points = Math.max(1, Math.round(item.manque));
    return { component: item.component, points, text: actionText(item.component, points) };
  });
}

function actionText(component: keyof ScoreComponents, points: number): string {
  switch (component) {
    case "regularity":
      return `+${points} points si vous vendez au moins 5 jours sur 7.`;
    case "growth":
      return `+${points} points en faisant croître le chiffre des 30 derniers jours.`;
    case "volume":
      return `+${points} points en augmentant le volume du mois.`;
    case "fidelity":
      return `+${points} points si vos clients identifiés reviennent.`;
    case "quality":
      return `+${points} points en réduisant les factures expirées.`;
    default: {
      const unreachable: never = component;
      return unreachable;
    }
  }
}

function completeWeeks(paid: SalePoint[], now: Date, firstKey: string | null): number[] {
  if (!firstKey) return [];
  const todayStart = dakarMidnight(now);
  const firstStart = Date.parse(`${firstKey}T00:00:00.000Z`);
  const weeks: number[] = [];
  for (let index = 0; index < 8; index++) {
    const end = todayStart - index * 7 * 86_400_000;
    const start = end - 7 * 86_400_000;
    if (start < firstStart) break;
    weeks.push(sumBetween(paid, start, end));
  }
  return weeks;
}

function growthFromSlope(weeksNewestFirst: number[]): number {
  const series = [...weeksNewestFirst].reverse();
  if (series.length < 2) return 0.5;
  const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
  if (mean === 0) return 0.5;
  const n = series.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  series.forEach((value, index) => {
    sumX += index;
    sumY += value;
    sumXY += index * value;
    sumXX += index * index;
  });
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  return clamp(0.5 + slope / mean / 2, 0, 1);
}

function fidelityScore(paid: SalePoint[]): number {
  const identified = paid.filter((sale) => sale.payerKey);
  if (identified.length < 10) return 0.5;
  const byPayer = new Map<string, { count: number; revenue: number }>();
  for (const sale of identified) {
    const key = sale.payerKey ?? "";
    const current = byPayer.get(key) ?? { count: 0, revenue: 0 };
    current.count += 1;
    current.revenue += sale.amountXof;
    byPayer.set(key, current);
  }
  let loyal = 0;
  let total = 0;
  for (const payer of byPayer.values()) {
    total += payer.revenue;
    if (payer.count >= 2) loyal += payer.revenue;
  }
  return total === 0 ? 0.5 : loyal / total;
}

function sumBetween(sales: SalePoint[], start: number, end: number): number {
  return sales.reduce((sum, sale) => {
    const time = Date.parse(sale.at);
    return time >= start && time < end ? sum + sale.amountXof : sum;
  }, 0);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
