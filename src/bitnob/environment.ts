import type { AppConfig } from "../config.js";
import type { BitnobClient } from "./types.js";

const TTL_MS = 60_000;
let cached: { env: string; at: number } | null = null;

export function resetBitnobEnvCache(): void {
  cached = null;
}

export async function resolveBitnobEnv(bitnob: BitnobClient, config: AppConfig): Promise<string> {
  if (config.bitnobMode !== "live") return config.bitnobMode;
  const now = config.now().getTime();
  if (cached && now - cached.at < TTL_MS) return cached.env;
  try {
    const who = await bitnob.whoami();
    const env = who.environment.trim() || config.bitnobMode;
    cached = { env, at: now };
    return env;
  } catch {
    return config.bitnobMode;
  }
}
