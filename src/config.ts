import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BitnobMode = "mock" | "live";
export type PayoutAsset = "USDT" | "USDC" | "BTC";
export type DemoPayMode = "auto" | "manual";

export interface AppConfig {
  nodeEnv: string;
  port: number;
  databasePath: string;
  publicUrl: string;
  bitnobMode: BitnobMode;
  bitnobBaseUrl: string;
  bitnobClientId: string;
  bitnobClientSecret: string;
  webhookSecret: string;
  phonePepper: string;
  payerPepper: string;
  publicDir: string;
  autoSettle: boolean;
  demoPayMode: DemoPayMode;
  payoutFromAsset: PayoutAsset;
  reconcileIntervalMs: number;
  now: () => Date;
}

function payoutAsset(value: string | undefined): PayoutAsset {
  if (value === "USDC" || value === "BTC" || value === "USDT") return value;
  return "USDT";
}

function demoPayMode(value: string | undefined): DemoPayMode {
  if (value === "manual") return "manual";
  return "auto";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const phonePepper = env.PHONE_PEPPER ?? "";
  const payerPepper = env.PAYER_PEPPER ?? "";
  if (phonePepper.length < 16 || payerPepper.length < 16) {
    throw new Error("PHONE_PEPPER et PAYER_PEPPER sont requis (openssl rand -hex 32).");
  }
  const bitnobMode: BitnobMode = env.BITNOB_MODE === "live" ? "live" : "mock";
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/jaaykat.db",
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/$/, ""),
    bitnobMode,
    bitnobBaseUrl: env.BITNOB_BASE_URL ?? "https://api.bitnob.com",
    bitnobClientId: env.BITNOB_CLIENT_ID ?? "",
    bitnobClientSecret: env.BITNOB_CLIENT_SECRET ?? "",
    webhookSecret: env.BITNOB_WEBHOOK_SECRET ?? "",
    phonePepper,
    payerPepper,
    publicDir: env.PUBLIC_DIR ?? join(here, "..", "public"),
    autoSettle: env.BITNOB_AUTO_SETTLE !== "false",
    demoPayMode: demoPayMode(env.DEMO_PAY_MODE),
    payoutFromAsset: payoutAsset(env.BITNOB_PAYOUT_FROM_ASSET),
    reconcileIntervalMs: 30_000,
    now: () => new Date(),
  };
}
