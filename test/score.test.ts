import { describe, expect, it } from "vitest";
import { buildSeedSales } from "../src/db/seed-data.js";
import { dashboardFromSales, type SalePoint } from "../src/modules/analytics/dashboard.js";
import { scoreFromComponents, scoreFromSales } from "../src/modules/score/formula.js";

describe("score de régularité", () => {
  it("reproduit l'exemple 71 bande B", () => {
    const volume = Math.min(1, Math.log10(1 + 450_000) / Math.log10(1 + 1_500_000));
    const result = scoreFromComponents(
      { regularity: 0.76, growth: 0.6, volume, fidelity: 0.45, quality: 0.88 },
      true,
    );
    expect(result.score).toBe(71);
    expect(result.band).toBe("B");
    expect(result.actions.map((action) => action.component)).toEqual(["growth", "regularity"]);
  });

  it("reste inéligible sous 14 jours ou 20 ventes", () => {
    const now = new Date("2026-10-17T12:00:00.000Z");
    const sales: SalePoint[] = Array.from({ length: 19 }, (_, index) => ({
      at: new Date(now.getTime() - index * 86_400_000).toISOString(),
      createdAt: new Date(now.getTime() - index * 86_400_000).toISOString(),
      amountXof: 1000,
      status: "paid" as const,
    }));
    expect(scoreFromSales(sales, now).eligible).toBe(false);
    expect(scoreFromSales(sales, now).score).toBeNull();
  });

  it("calcule la régularité, la croissance et la qualité sur une fixture", () => {
    const now = new Date("2026-10-17T18:00:00.000Z");
    const sales: SalePoint[] = [];
    for (let day = 0; day < 60; day++) {
      const at = new Date(Date.UTC(2026, 7, 19 + day, 12, 0, 0));
      sales.push({
        at: at.toISOString(),
        createdAt: new Date(at.getTime() - 5_000).toISOString(),
        amountXof: day >= 30 ? 12_000 : 10_000,
        status: "paid",
        payerKey: day % 3 === 0 ? "fatou" : `once-${day}`,
        nickname: day % 3 === 0 ? "Fatou" : "Client",
      });
    }
    sales.push({
      at: "2026-10-01T12:00:00.000Z",
      createdAt: "2026-10-01T12:00:00.000Z",
      amountXof: 1000,
      status: "expired",
    });
    const score = scoreFromSales(sales, now);
    expect(score.eligible).toBe(true);
    expect(score.components.growth).toBeGreaterThan(0.5);
    expect(score.components.quality).toBeLessThan(1);
    expect(score.band === "A" || score.band === "B" || score.band === "C" || score.band === "D").toBe(true);
  });
});

describe("tableau de bord", () => {
  it("donne le conseil de conversion quand moins de 70 % paient", () => {
    const now = new Date("2026-10-17T18:00:00.000Z");
    const sales: SalePoint[] = [];
    for (let i = 0; i < 3; i++) {
      sales.push({
        at: new Date(Date.UTC(2026, 9, 16, 10, i)).toISOString(),
        createdAt: new Date(Date.UTC(2026, 9, 16, 10, i)).toISOString(),
        amountXof: 2000,
        status: "paid",
      });
    }
    for (let i = 0; i < 2; i++) {
      sales.push({
        at: new Date(Date.UTC(2026, 9, 15, 10, i)).toISOString(),
        createdAt: new Date(Date.UTC(2026, 9, 15, 10, i)).toISOString(),
        amountXof: 2000,
        status: "expired",
      });
    }
    const dashboard = dashboardFromSales(sales, "7d", now);
    expect(dashboard.advice).toEqual({
      priority: 1,
      text: "3 clients sur 10 n'ont pas payé. Montrez le QR de plus près.",
    });
    expect(dashboard.kpis.salesCount).toBe(3);
    expect(dashboard.kpis.revenueXof).toBe(6000);
    expect(dashboard.kpis.conversion).toBeCloseTo(0.6);
  });
});

describe("seed Awa Beauté", () => {
  it("couvre 60 jours en source simulée et tombe en bande B", () => {
    const now = new Date("2026-10-17T18:00:00.000Z");
    const sales = buildSeedSales(now);
    expect(sales.length).toBeGreaterThan(20);
    expect(sales.every((sale) => sale.source === "seed")).toBe(true);
    const first = Date.parse(sales[0]?.at ?? "");
    const last = Date.parse(sales[sales.length - 1]?.at ?? "");
    expect(last - first).toBeGreaterThan(59 * 86_400_000);
    const nicknames = new Set(sales.map((sale) => sale.nickname).filter(Boolean));
    expect(nicknames.size).toBe(12);
    const score = scoreFromSales(sales, now);
    expect(score.eligible).toBe(true);
    expect(score.band).toBe("B");
    expect(score.score).toBeGreaterThanOrEqual(65);
    expect(score.score).toBeLessThanOrEqual(78);
  });
});
