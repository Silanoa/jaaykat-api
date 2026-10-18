const MAX_SATS = 20_000_000;

export function xofToSats(amountXof: number, rateBtcXof: number): number {
  if (!(rateBtcXof > 0) || !Number.isFinite(amountXof)) {
    throw new Error("Taux indisponible.");
  }
  return Math.round((amountXof / rateBtcXof) * 1e8);
}

export function assertSatsInRange(sats: number, rateBtcXof: number): void {
  if (sats < 1) {
    const minXof = Math.max(1, Math.ceil(rateBtcXof / 1e8));
    throw new Error(`Montant trop petit. Minimum ${formatXof(minXof)}.`);
  }
  if (sats > MAX_SATS) {
    const maxXof = Math.floor((MAX_SATS * rateBtcXof) / 1e8);
    throw new Error(`Montant trop élevé. Maximum ${formatXof(maxXof)}.`);
  }
}

export function formatXof(amount: number): string {
  return `${new Intl.NumberFormat("fr-FR").format(Math.round(amount))} F`;
}

export function pricedRate(btcUsdSell: number, usdXofBuy: number): { rateBtcXof: number; source: "btc_usd*usd_xof" } {
  return { rateBtcXof: btcUsdSell * usdXofBuy, source: "btc_usd*usd_xof" };
}
