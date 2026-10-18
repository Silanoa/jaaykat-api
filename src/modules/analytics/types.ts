export interface SalePoint {
  at: string;
  createdAt: string;
  amountXof: number;
  status: "creating" | "pending" | "paid" | "expired" | "failed";
  payerKey?: string | null;
  nickname?: string | null;
  source?: "live" | "seed";
}
