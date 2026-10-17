import type { AppConfig } from "../config.js";
import { MockBitnobClient } from "./mock.js";
import type { BitnobClient } from "./types.js";

export function createBitnobClient(config: AppConfig): BitnobClient {
  if (config.bitnobMode === "live") {
    throw new Error(
      "BITNOB_MODE=live : le client signé se branche dans ce fichier (docs/SDK_SWAP.md). Lancez la démo avec BITNOB_MODE=mock tant que la VM n'est pas sur l'IP autorisée.",
    );
  }
  return new MockBitnobClient({
    clientId: config.bitnobClientId || "mock",
    clientSecret: config.bitnobClientSecret || "mock",
    baseUrl: config.bitnobBaseUrl,
    settleAfterMs: config.autoSettle ? 5_000 : undefined,
  });
}
