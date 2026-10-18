import { createHmac, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { z } from "zod";
import { BitnobError, BitnobIpNotWhitelistedError, BitnobRateLimitError } from "./errors.js";
import type {
  BalanceAsset,
  BalancesApi,
  BitnobClient,
  BitnobClientOptions,
  CountryRequirements,
  CustomersApi,
  InitializePayoutInput,
  InvoiceStatus,
  LightningApi,
  LightningInvoice,
  Payout,
  PayoutQuote,
  PayoutStatus,
  PayoutsApi,
  QuoteInput,
  RateQuote,
  RatesApi,
  RatesSnapshot,
  SnNetwork,
} from "./types.js";

setDefaultResultOrder("ipv4first");

const SN_ACCOUNT = /^(\+?221[7]\d{8}|[7]\d{8})$/;
const NETWORKS = ["wave", "orange", "free", "expresso"] as const;

export interface LiveBitnobOptions extends BitnobClientOptions {
  lookupIp?: () => Promise<string | null>;
  now?: () => Date;
  retryDelayMs?: number;
}

export function signRequest(input: {
  clientId: string;
  clientSecret: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  const payload = `${input.clientId}:${input.timestamp}:${input.nonce}:${input.body}`;
  return createHmac("sha256", input.clientSecret).update(payload).digest("hex");
}

export function parseBitnobDate(value: string | number): Date {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000);
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return new Date(parsed > 1e12 ? parsed : parsed * 1000);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BitnobError("Date Bitnob illisible.", { status: 502, path: "date", body: value });
  }
  return date;
}

export class LiveBitnobClient implements BitnobClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest?: BitnobClientOptions["onRequest"];
  private readonly lookupIp: () => Promise<string | null>;
  private readonly now: () => Date;

  constructor(options: LiveBitnobOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.baseUrl = (options.baseUrl ?? "https://api.bitnob.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 400;
    this.fetchImpl = options.fetch ?? fetch;
    this.onRequest = options.onRequest;
    this.lookupIp = options.lookupIp ?? lookupPublicIp;
    this.now = options.now ?? (() => new Date());
  }

  readonly lightning: LightningApi = {
    createInvoice: async (input) => {
      const body: Record<string, unknown> = {
        amount: input.amountSats,
        description: input.description,
        expiry: input.expirySeconds ?? 900,
        reference: input.reference,
      };
      if (input.customerId) body.customer_id = input.customerId;
      if (input.autoSettle !== undefined) body.auto_settle = input.autoSettle;
      return this.parseInvoice(await this.request("POST", "/api/lightning/invoices", { body }), input.amountSats);
    },
    getInvoice: async (id) => this.parseInvoice(await this.request("GET", `/api/lightning/invoices/${encodeURIComponent(id)}`)),
    listInvoices: async () => this.request("GET", "/api/lightning/invoices"),
    decode: async () => {
      throw new BitnobError("Le décodage BOLT11 complet reste à constater sur le sandbox.", { status: 501, path: "decode" });
    },
    waitForPaid: async (id, options) => {
      const timeoutMs = options?.timeoutMs ?? 15_000;
      const intervalMs = options?.intervalMs ?? 1_000;
      const started = this.now().getTime();
      let latest = await this.lightning.getInvoice(id);
      while (latest.status !== "paid") {
        if (options?.signal?.aborted) throw new BitnobError("Attente interrompue.", { status: 499, path: `/api/lightning/invoices/${id}` });
        if (this.now().getTime() - started >= timeoutMs) return latest;
        await delay(intervalMs);
        latest = await this.lightning.getInvoice(id);
      }
      return latest;
    },
  };

  readonly customers: CustomersApi = {
    create: async (customer) => {
      const payload = await this.request<unknown>("POST", "/api/customers", {
        body: omitEmpty({
          customer_type: customer.customerType,
          email: customer.email,
          first_name: customer.firstName,
          last_name: customer.lastName,
          phone_number: customer.phoneNumber,
          country_code: customer.countryCode,
          reference: customer.reference,
        }),
      });
      const id = readId(payload);
      if (!id) throw new BitnobError("Identifiant client Bitnob absent.", { status: 502, path: "/api/customers", body: payload });
      return { id };
    },
    get: async (id) => this.request("GET", `/api/customers/${encodeURIComponent(id)}`),
  };

  readonly balances: BalancesApi = {
    get: async () => parseBalances(await this.request("GET", "/api/balances")),
  };

  readonly rates: RatesApi = {
    get: async () => {
      const [exchange, prices] = await Promise.all([
        this.request("GET", "/api/exchange-rates").catch(() => null),
        this.request("GET", "/api/trading/prices").catch(() => null),
      ]);
      if (!exchange && !prices) {
        throw new BitnobError("Taux Bitnob indisponibles.", { status: 502, path: "/api/exchange-rates" });
      }
      const quotes = new Map<string, RateQuote>();
      for (const quote of [...extractObservedQuotes(exchange, prices), ...extractQuotes(exchange), ...extractQuotes(prices)]) {
        if (!quotes.has(quote.pair)) quotes.set(quote.pair, quote);
      }
      const btcUsd = quotes.get("BTCUSD");
      const usdXof = quotes.get("USDXOF");
      if (!btcUsd || !usdXof) {
        throw new BitnobError("Taux BTC/USD ou USD/XOF introuvable.", { status: 502, path: "/api/exchange-rates", body: { exchange, prices } });
      }
      return {
        btcUsd,
        usdXof,
        btcXof: quotes.get("BTCXOF"),
        fetchedAt: this.now(),
      } satisfies RatesSnapshot;
    },
    btcTo: async (fiat, btc) => {
      const snapshot = await this.rates.get();
      if (fiat === "USD") return btc * snapshot.btcUsd.mid;
      if (snapshot.btcXof) return btc * snapshot.btcXof.mid;
      return btc * snapshot.btcUsd.mid * snapshot.usdXof.mid;
    },
  };

  readonly payouts: PayoutsApi = {
    supportedCountries: async () => {
      const payload = unwrap(await this.request("GET", "/api/payouts/supported-countries"));
      return Array.isArray(payload) ? payload : [];
    },
    countryRequirements: async (country) => parseCountry(country, await this.request("GET", `/api/payouts/supported-countries/${encodeURIComponent(country)}`)),
    limits: async () => unwrap(await this.request("GET", "/api/payouts/limits")),
    quote: async (input) => parseQuote(await this.request("POST", "/api/payouts/quotes", { body: quoteBody(input) }), input),
    initialize: async (quoteId, body) => {
      assertBeneficiary(body);
      return parsePayout(
        await this.request("POST", `/api/payouts/${encodeURIComponent(quoteId)}/initialize`, { body: initializeBody(body) }),
        quoteId,
      );
    },
    finalize: async (quoteId) =>
      parsePayout(await this.request("POST", `/api/payouts/${encodeURIComponent(quoteId)}/finalize`, { body: {} }), quoteId),
    get: async (id) => parsePayout(await this.request("GET", `/api/payouts/${encodeURIComponent(id)}`), id),
    list: async (query) => this.request("GET", "/api/payouts", { query }),
  };

  async whoami(): Promise<{ environment: "sandbox" | "live" | string }> {
    const payload = unwrap(await this.request("GET", "/api/whoami"));
    const parsed = z.object({ environment: z.string().optional(), env: z.string().optional(), mode: z.string().optional() }).passthrough().safeParse(payload);
    const environment = parsed.success ? parsed.data.environment || parsed.data.env || parsed.data.mode || "" : "";
    if (!environment) throw new BitnobError("Environnement Bitnob absent.", { status: 502, path: "/api/whoami", body: payload });
    return { environment };
  }

  async request<T>(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<T> {
    const hasBody = opts?.body !== undefined && method !== "GET" && method !== "HEAD";
    const rawBody = hasBody ? JSON.stringify(opts.body) : "";
    const retryable = method === "GET" || method === "HEAD" || (path === "/api/lightning/invoices" && hasReference(opts?.body));
    const attempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.send<T>(method, path, rawBody, opts?.query, attempt);
      } catch (error) {
        lastError = error;
        if (!retryable || attempt === attempts || !isRetryable(error)) throw error;
        await delay(this.retryDelayMs);
      }
    }
    throw lastError;
  }

  private async send<T>(method: string, path: string, rawBody: string, query: Record<string, unknown> | undefined, attempt: number): Promise<T> {
    const timestamp = Math.floor(this.now().getTime() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const signature = signRequest({ clientId: this.clientId, clientSecret: this.clientSecret, timestamp, nonce, body: rawBody });
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const started = this.now().getTime();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(rawBody ? { "Content-Type": "application/json" } : {}),
          "X-Auth-Client": this.clientId,
          "X-Auth-Timestamp": timestamp,
          "X-Auth-Nonce": nonce,
          "X-Auth-Signature": signature,
        },
        body: rawBody || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "réseau";
      this.onRequest?.({ method, path, status: 0, durationMs: this.now().getTime() - started, attempt });
      throw new BitnobError(this.safe(message), { status: 0, path });
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    const correlationId = headerValue(response.headers, "x-correlation-id") || headerValue(response.headers, "x-request-id");
    this.onRequest?.({
      method,
      path,
      status: response.status,
      durationMs: this.now().getTime() - started,
      correlationId,
      attempt,
    });
    if (!response.ok) throw await this.fail(response.status, path, payload, correlationId, response.headers);
    return payload as T;
  }

  private async fail(status: number, path: string, body: unknown, correlationId: string | undefined, headers: Headers): Promise<BitnobError> {
    const message = this.safe(readMessage(body));
    if (status === 403 && /not whitelisted|ip address/i.test(`${message} ${JSON.stringify(body ?? "")}`)) {
      const ip = await this.lookupIp().catch(() => null);
      return new BitnobIpNotWhitelistedError(path, body, ip);
    }
    if (status === 429) {
      const retryAfter = headerValue(headers, "retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      return new BitnobRateLimitError(message, { path, body, correlationId, retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined });
    }
    return new BitnobError(message, { status, path, body, correlationId });
  }

  private parseInvoice(payload: unknown, fallbackSats = 0): LightningInvoice {
    const parsed = invoiceSchema.safeParse(unwrap(payload));
    if (!parsed.success) throw new BitnobError("Réponse facture Bitnob inattendue.", { status: 502, path: "/api/lightning/invoices", body: payload });
    const row = parsed.data;
    const id = row.id !== undefined ? String(row.id) : "";
    if (!id) throw new BitnobError("Identifiant de facture Bitnob absent.", { status: 502, path: "/api/lightning/invoices", body: payload });
    const bolt11 = row.bolt11 || row.request || row.payment_request || "";
    const expiry = row.expires_at ?? row.expiresAt;
    return {
      id,
      bolt11,
      request: bolt11,
      status: invoiceStatus(row.status),
      paymentHash: row.payment_hash || row.paymentHash || "",
      expiresAt: expiry === undefined ? this.now() : parseBitnobDate(expiry),
      reference: row.reference,
      amountSats: num(row.amount_sats ?? row.satoshis ?? row.amount) ?? fallbackSats,
      preimage: row.preimage ?? undefined,
      customerId: row.customer_id,
    };
  }

  private safe(message: string): string {
    if (!message) return "La requête Bitnob a échoué.";
    if (this.clientSecret && message.includes(this.clientSecret)) return "La requête Bitnob a échoué.";
    if (this.clientId && message.includes(this.clientId)) return "La requête Bitnob a échoué.";
    return message;
  }
}

const invoiceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    bolt11: z.string().optional(),
    request: z.string().optional(),
    payment_request: z.string().optional(),
    status: z.string().optional(),
    payment_hash: z.string().optional(),
    paymentHash: z.string().optional(),
    expires_at: z.union([z.string(), z.number()]).optional(),
    expiresAt: z.union([z.string(), z.number()]).optional(),
    reference: z.string().optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    satoshis: z.union([z.string(), z.number()]).optional(),
    amount_sats: z.union([z.string(), z.number()]).optional(),
    preimage: z.string().nullable().optional(),
    customer_id: z.string().optional(),
  })
  .passthrough();

function invoiceStatus(value: string | undefined): InvoiceStatus {
  const normalized = (value ?? "").toLowerCase();
  if (normalized === "paid" || normalized === "settled" || normalized === "completed" || normalized === "success") return "paid";
  if (normalized === "expired") return "expired";
  if (normalized === "failed" || normalized === "cancelled" || normalized === "canceled") return "failed";
  return "pending";
}

function parseBalances(payload: unknown): { assets: BalanceAsset[] } {
  const data = unwrap(payload);
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { assets?: unknown }).assets)
      ? ((data as { assets: unknown[] }).assets)
      : data && typeof data === "object" && Array.isArray((data as { balances?: unknown }).balances)
        ? ((data as { balances: unknown[] }).balances)
        : [];
  const row = z
    .object({
      asset: z.string().optional(),
      currency: z.string().optional(),
      code: z.string().optional(),
      available: z.union([z.string(), z.number()]).optional(),
      balance: z.union([z.string(), z.number()]).optional(),
      amount: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough();
  const assets: BalanceAsset[] = [];
  for (const item of list) {
    const parsed = row.safeParse(item);
    if (!parsed.success) continue;
    const asset = parsed.data.asset || parsed.data.currency || parsed.data.code;
    const available = parsed.data.available ?? parsed.data.balance ?? parsed.data.amount;
    if (!asset || available === undefined) continue;
    assets.push({ asset, available: String(available) });
  }
  return { assets };
}

function extractQuotes(payload: unknown): RateQuote[] {
  const root = unwrap(payload);
  const rows: unknown[] = [];
  if (Array.isArray(root)) rows.push(...root);
  else if (root && typeof root === "object") {
    const record = root as Record<string, unknown>;
    if (Array.isArray(record.rates)) rows.push(...record.rates);
    else if (Array.isArray(record.prices)) rows.push(...record.prices);
    else {
      for (const [key, value] of Object.entries(record)) {
        if (!pairName(key)) continue;
        if (value && typeof value === "object") rows.push({ ...(value as Record<string, unknown>), pair: key });
        else rows.push({ pair: key, mid: value });
      }
      if (pairName(String(record.pair ?? record.symbol ?? ""))) rows.push(record);
    }
  }
  const quotes: RateQuote[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const pair = pairName(String(record.pair ?? record.symbol ?? ""));
    if (!pair) continue;
    const mid = num(record.mid ?? record.price ?? record.rate ?? record.last);
    const sell = num(record.sell ?? record.ask) ?? mid;
    const buy = num(record.buy ?? record.bid) ?? mid;
    const price = sell ?? buy ?? mid;
    if (price === null || price <= 0) continue;
    quotes.push({
      pair,
      mid: mid ?? price,
      buy: buy ?? price,
      sell: sell ?? price,
      validForSeconds: num(record.valid_for_seconds ?? record.validForSeconds) ?? 60,
    });
  }
  return quotes;
}

function pairName(raw: string): "BTCUSD" | "USDXOF" | "BTCXOF" | null {
  const key = raw.replace(/[^a-z]/gi, "").toUpperCase();
  if (key === "BTCUSD" || key === "XBTUSD") return "BTCUSD";
  if (key === "USDXOF") return "USDXOF";
  if (key === "BTCXOF" || key === "XBTXOF") return "BTCXOF";
  return null;
}

function parseCountry(country: string, payload: unknown): CountryRequirements {
  const found = new Set<SnNetwork>();
  const walk = (value: unknown): void => {
    if (typeof value === "string" && isNetwork(value.toLowerCase())) found.add(value.toLowerCase() as SnNetwork);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(unwrap(payload));
  const networks = found.size > 0 ? [...found] : country === "SN" ? [...NETWORKS] : [];
  return {
    networks,
    accountNumberPattern: String.raw`^(\+?221[7]\d{8}|[7]\d{8})$`,
    minAmount: 100,
    maxAmount: 200_000,
    beneficiaryFields: ["account_name", "account_number", "network"],
  };
}

function quoteBody(input: QuoteInput): Record<string, unknown> {
  return {
    amount: input.amount,
    country: input.country,
    from_asset: input.fromAsset,
    to_currency: input.toCurrency,
    source: input.source,
    reference: input.reference,
  };
}

function parseQuote(payload: unknown, input: QuoteInput): PayoutQuote {
  const parsed = z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      quote_id: z.union([z.string(), z.number()]).optional(),
      from_asset: z.string().optional(),
      from_amount: z.union([z.string(), z.number()]).optional(),
      to_currency: z.string().optional(),
      settlement_amount: z.union([z.string(), z.number()]).optional(),
      settlementAmount: z.union([z.string(), z.number()]).optional(),
      received_amount: z.union([z.string(), z.number()]).optional(),
      exchange_rate: z.union([z.string(), z.number(), z.object({ rate: z.union([z.string(), z.number()]).optional(), effective_rate: z.union([z.string(), z.number()]).optional() }).passthrough()]).optional(),
      exchangeRate: z.union([z.string(), z.number()]).optional(),
      rate: z.union([z.string(), z.number()]).optional(),
      fees: z.union([z.string(), z.number()]).optional(),
      fee: z.union([z.string(), z.number()]).optional(),
      expires_at: z.union([z.string(), z.number()]).optional(),
      expiresAt: z.union([z.string(), z.number()]).optional(),
      reference: z.string().optional(),
      country: z.string().optional(),
    })
    .passthrough()
    .safeParse(unwrapPayout(payload));
  if (!parsed.success) throw new BitnobError("Réponse de devis Bitnob inattendue.", { status: 502, path: "/api/payouts/quotes", body: payload });
  const row = parsed.data;
  const id = row.id ?? row.quote_id;
  const expiry = row.expires_at ?? row.expiresAt;
  if (id === undefined || expiry === undefined) {
    throw new BitnobError("Champs du devis Bitnob à constater (id ou échéance).", { status: 502, path: "/api/payouts/quotes", body: payload });
  }
  const settlement = row.settlement_amount ?? row.settlementAmount ?? row.received_amount;
  return {
    id: String(id),
    fromAsset: row.from_asset || input.fromAsset,
    fromAmount: String(row.from_amount ?? input.amount),
    toCurrency: row.to_currency || input.toCurrency,
    settlementAmount: settlement === undefined ? "" : String(settlement),
    exchangeRate: String(
        (typeof row.exchange_rate === "object" ? (row.exchange_rate.effective_rate ?? row.exchange_rate.rate) : row.exchange_rate) ?? row.exchangeRate ?? row.rate ?? "",
      ),
    fees: String(row.fees ?? row.fee ?? "0"),
    expiresAt: parseBitnobDate(expiry),
    reference: row.reference || input.reference,
    country: row.country || input.country,
  };
}

function initializeBody(body: InitializePayoutInput): Record<string, unknown> {
  return omitEmpty({
    reference: body.reference,
    callback_url: body.callbackUrl,
    customer_id: body.customerId,
    beneficiary: body.beneficiary,
  });
}

function assertBeneficiary(body: InitializePayoutInput): void {
  const account = body.beneficiary.account_number;
  const network = body.beneficiary.network;
  if (typeof account !== "string" || !SN_ACCOUNT.test(account)) {
    throw new BitnobError("Numéro mobile money invalide.", { status: 422, path: "/api/payouts/initialize" });
  }
  if (typeof network !== "string" || !isNetwork(network)) {
    throw new BitnobError("Réseau mobile money invalide.", { status: 422, path: "/api/payouts/initialize" });
  }
}

function parsePayout(payload: unknown, quoteId: string): Payout {
  const parsed = z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      payout_id: z.union([z.string(), z.number()]).optional(),
      quote_id: z.union([z.string(), z.number()]).optional(),
      status: z.string().optional(),
      reference: z.string().optional(),
    })
    .passthrough()
    .safeParse(unwrapPayout(payload));
  if (!parsed.success) throw new BitnobError("Réponse payout Bitnob inattendue.", { status: 502, path: "/api/payouts", body: payload });
  const id = parsed.data.id ?? parsed.data.payout_id;
  if (id === undefined) throw new BitnobError("Identifiant de retrait Bitnob absent.", { status: 502, path: "/api/payouts", body: payload });
  return {
    id: String(id),
    quoteId: parsed.data.quote_id !== undefined ? String(parsed.data.quote_id) : quoteId,
    status: payoutStatus(parsed.data.status),
    reference: parsed.data.reference,
  };
}

function payoutStatus(value: string | undefined): PayoutStatus {
  switch ((value ?? "").toUpperCase()) {
    case "QUOTE":
      return "QUOTE";
    case "INITIATED":
      return "INITIATED";
    case "PENDING":
      return "PENDING";
    case "PROCESSING":
      return "PROCESSING";
    case "COMPLETED":
    case "SUCCESS":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "PROCESSING";
  }
}

function isNetwork(value: string): value is SnNetwork {
  return (NETWORKS as readonly string[]).includes(value);
}

function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload && (payload as { data: unknown }).data != null) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

function readId(payload: unknown): string {
  const data = unwrap(payload);
  if (!data || typeof data !== "object") return "";
  const id = (data as { id?: unknown; customer_id?: unknown }).id ?? (data as { customer_id?: unknown }).customer_id;
  return id === undefined || id === null ? "" : String(id);
}

function readMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "La requête Bitnob a échoué.";
  const record = body as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.title === "string") return record.title;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as { message?: unknown; detail?: unknown };
    if (typeof nested.message === "string") return nested.message;
    if (typeof nested.detail === "string") return nested.detail;
  }
  return "La requête Bitnob a échoué.";
}

function hasReference(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && typeof (body as { reference?: unknown }).reference === "string");
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof BitnobError)) return true;
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

function omitEmpty(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== undefined));
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 180) };
  }
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value && value.length > 0 ? value : undefined;
}

async function lookupPublicIp(): Promise<string | null> {
  try {
    const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return null;
    const text = (await response.text()).trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Formes constatï¿½es en sandbox (2026-10-17): exchange-rates = data.rates[{target_currency (CFA = XOF), buy_rate, sell_rate}], trading/prices = data.prices[{base_currency, quote_currency, price}]. */
function extractObservedQuotes(exchange: unknown, prices: unknown): RateQuote[] {
  const out: RateQuote[] = [];
  const rates = (unwrap(exchange) as { rates?: unknown } | null)?.rates;
  if (Array.isArray(rates)) {
    for (const row of rates as Array<Record<string, unknown>>) {
      const target = String(row.target_currency ?? "").toUpperCase();
      if (target !== "CFA" && target !== "XOF") continue;
      const buy = num(row.buy_rate);
      const sell = num(row.sell_rate);
      if (buy === null || sell === null) continue;
      out.push({ pair: "USDXOF", mid: (buy + sell) / 2, buy, sell, validForSeconds: 60 });
    }
  }
  const list = (unwrap(prices) as { prices?: unknown } | null)?.prices;
  if (Array.isArray(list)) {
    for (const row of list as Array<Record<string, unknown>>) {
      const base = String(row.base_currency ?? "").toUpperCase();
      const quote = String(row.quote_currency ?? "").toUpperCase();
      const price = num(row.price);
      if (base === "BTC" && (quote === "USDC" || quote === "USDT" || quote === "USD") && price !== null && price > 0) {
        out.push({ pair: "BTCUSD", mid: price, buy: price, sell: price, validForSeconds: 60 });
      }
    }
  }
  return out;
}

/** Le devis payout arrive sous data.payout (constatï¿½); sinon data. */
function unwrapPayout(payload: unknown): unknown {
  const data = unwrap(payload);
  if (data && typeof data === "object" && "payout" in data) return (data as { payout: unknown }).payout;
  return data;
}
