import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

export { BitnobHttpClient as LiveBitnobClient, parseBitnobDate, signRequest } from "bitnob-lite";
export type { BitnobClientConfig as LiveBitnobOptions } from "bitnob-lite";
