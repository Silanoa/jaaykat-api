export interface RequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  correlationId?: string;
  requestId?: string;
  attempt: number;
}

export interface BitnobClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  onRequest?: (log: RequestLog) => void;
}

export type InvoiceStatus = "pending" | "paid" | "expired" | "failed";

export interface LightningInvoice {
  id: string;
  bolt11: string;
  request: string;
  status: InvoiceStatus;
  paymentHash: string;
  expiresAt: Date;
  reference?: string;
  amountSats: number;
  preimage?: string;
  customerId?: string;
}

export interface CreateInvoiceInput {
  amountSats: number;
  description: string;
  reference: string;
  customerId?: string;
  expirySeconds?: number;
  autoSettle?: boolean;
}

export interface LightningApi {
  createInvoice(input: CreateInvoiceInput): Promise<LightningInvoice>;
  getInvoice(id: string): Promise<LightningInvoice>;
  listInvoices(): Promise<unknown>;
  decode(bolt11: string): Promise<{ amountSats: number; expiresAt: Date; isExpired: boolean }>;
  waitForPaid(
    id: string,
    options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<LightningInvoice>;
}

export interface CustomerInput {
  customerType: "individual" | "business";
  email: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  countryCode?: string;
  reference?: string;
}

export interface CustomersApi {
  create(customer: CustomerInput): Promise<{ id: string }>;
  get(id: string): Promise<unknown>;
}

export interface RateQuote {
  pair: string;
  mid: number;
  buy: number;
  sell: number;
  validForSeconds: number;
}

export interface RatesSnapshot {
  btcUsd: RateQuote;
  usdXof: RateQuote;
  btcXof?: RateQuote;
  fetchedAt: Date;
}

export interface RatesApi {
  get(): Promise<RatesSnapshot>;
  btcTo(fiat: "XOF" | "USD", btc: number): Promise<number>;
}

export interface BalanceAsset {
  asset: string;
  available: string;
}

export interface BalancesApi {
  get(): Promise<{ assets: BalanceAsset[] }>;
}

export type SnNetwork = "wave" | "orange" | "free" | "expresso";
export type PayoutAsset = "USDT" | "USDC" | "BTC";
export type PayoutStatus = "QUOTE" | "INITIATED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "EXPIRED";

export interface PayoutQuote {
  id: string;
  fromAsset: string;
  fromAmount: string;
  toCurrency: string;
  settlementAmount: string;
  exchangeRate: string;
  fees: string;
  expiresAt: Date;
  reference: string;
  country: string;
}

export interface Payout {
  id: string;
  quoteId: string;
  status: PayoutStatus;
  reference?: string;
}

export interface QuoteInput {
  amount: string;
  country: string;
  fromAsset: PayoutAsset;
  toCurrency: string;
  source: "offchain" | "onchain";
  reference: string;
}

export interface InitializePayoutInput {
  reference: string;
  callbackUrl: string;
  paymentReason?: string;
  customerId?: string;
  beneficiary: Record<string, unknown>;
}

export interface CountryRequirements {
  networks: SnNetwork[];
  accountNumberPattern: string;
  minAmount: number;
  maxAmount: number;
  beneficiaryFields: string[];
}

export interface PayoutsApi {
  supportedCountries(): Promise<unknown[]>;
  countryRequirements(country: string): Promise<CountryRequirements>;
  limits(): Promise<unknown>;
  quote(input: QuoteInput): Promise<PayoutQuote>;
  initialize(quoteId: string, body: InitializePayoutInput): Promise<Payout>;
  finalize(quoteId: string): Promise<Payout>;
  get(id: string): Promise<Payout>;
  list(query?: { status?: string; limit?: number }): Promise<unknown>;
}

export interface BitnobClient {
  readonly lightning: LightningApi;
  readonly customers: CustomersApi;
  readonly balances: BalancesApi;
  readonly rates: RatesApi;
  readonly payouts: PayoutsApi;
  whoami(): Promise<{ environment: "sandbox" | "live" | string }>;
  request<T>(method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }): Promise<T>;
}
