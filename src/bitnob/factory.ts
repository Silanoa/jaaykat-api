import type { AppConfig } from "../config.js";
import { LiveBitnobClient } from "./live.js";
import { MockBitnobClient } from "./mock.js";
import type { BitnobClient } from "./types.js";

export function createBitnobClient(config: AppConfig): BitnobClient {
  if (config.bitnobMode === "live") {
    if (!config.bitnobClientId || !config.bitnobClientSecret) {
      throw new Error("BITNOB_CLIENT_ID et BITNOB_CLIENT_SECRET sont requis quand BITNOB_MODE=live.");
    }
    return new LiveBitnobClient({
      clientId: config.bitnobClientId,
      clientSecret: config.bitnobClientSecret,
      baseUrl: config.bitnobBaseUrl,
    });
  }
  return new MockBitnobClient({
    clientId: config.bitnobClientId || "mock",
    clientSecret: config.bitnobClientSecret || "mock",
    baseUrl: config.bitnobBaseUrl,
    settleAfterMs: config.autoSettle ? 5_000 : undefined,
  });
}
