import { randomBytes } from "node:crypto";
import { BitnobError } from "./errors.js";
import { ulid } from "../ids.js";
import type {
  BitnobClient,
  BitnobClientOptions,
  CountryRequirements,
  CreateInvoiceInput,
  CustomerInput,
  InitializePayoutInput,
  LightningInvoice,
  Payout,
  PayoutQuote,
  QuoteInput,
  SnNetwork,
} from "./types.js";

interface MockInvoice extends LightningInvoice {
  settleAt: number | null;
}

interface MockQuote extends PayoutQuote {
  finalized: boolean;
  payoutId?: string;
  payoutStatus: Payout["status"];
}

export interface MockBitnobOptions extends BitnobClientOptions {
  settleAfterMs?: number;
  failCustomers?: boolean | BitnobError;
  failNextInvoices?: number;
  now?: () => number;
}

const MOCK_BTC_USD = { pair: "BTCUSD", mid: 65_000, buy: 66_000, sell: 64_000, validForSeconds: 60 };
const MOCK_USD_XOF = { pair: "USDXOF", mid: 600, buy: 605, sell: 595, validForSeconds: 60 };

export class MockBitnobClient implements BitnobClient {
  readonly customersCreated: CustomerInput[] = [];
  readonly invoiceGets: string[] = [];
  readonly payoutGets: string[] = [];
  readonly references: string[] = [];
  invoiceCreates = 0;
  private failNextInvoices: number;
  private readonly invoices = new Map<string, MockInvoice>();
  private readonly byReference = new Map<string, MockInvoice>();
  private readonly quotes = new Map<string, MockQuote>();
  private readonly customerRows = new Map<string, CustomerInput & { id: string }>();
  private readonly settleAfterMs: number;
  private readonly failCustomers: boolean | BitnobError;
  private readonly now: () => number;

  constructor(opts: MockBitnobOptions = { clientId: "mock", clientSecret: "mock" }) {
    this.settleAfterMs = opts.settleAfterMs ?? 5_000;
    this.failCustomers = opts.failCustomers ?? false;
    this.failNextInvoices = opts.failNextInvoices ?? 0;
    this.now = opts.now ?? Date.now;
  }

  readonly lightning = {
    createInvoice: async (input: CreateInvoiceInput): Promise<LightningInvoice> => {
      this.references.push(input.reference);
      if (this.failNextInvoices > 0) {
        this.failNextInvoices -= 1;
        throw new BitnobError("Bitnob indisponible", { status: 503, path: "/api/lightning/invoices", correlationId: "corr_inv" });
      }
      const existing = this.byReference.get(input.reference);
      if (existing) return this.publicInvoice(existing);
      this.invoiceCreates += 1;
      const id = `inv_${ulid()}`;
      const created = this.now();
      const expiresAt = new Date(created + (input.expirySeconds ?? 900) * 1000);
      const settleAt = input.autoSettle ? created + this.settleAfterMs : null;
      const invoice: MockInvoice = {
        id,
        bolt11: `lntb${input.amountSats}n1mock${id.toLowerCase()}`,
        request: "",
        status: "pending",
        paymentHash: randomBytes(32).toString("hex"),
        expiresAt,
        reference: input.reference,
        amountSats: input.amountSats,
        customerId: input.customerId,
        settleAt,
      };
      invoice.request = invoice.bolt11;
      this.invoices.set(id, invoice);
      this.byReference.set(input.reference, invoice);
      return this.publicInvoice(invoice);
    },
    getInvoice: async (id: string): Promise<LightningInvoice> => {
      this.invoiceGets.push(id);
      const invoice = this.invoices.get(id);
      if (!invoice) throw new BitnobError("Invoice not found", { status: 404, path: `/api/lightning/invoices/${id}` });
      return this.publicInvoice(invoice);
    },
    listInvoices: async () => [...this.invoices.values()].map((invoice) => this.publicInvoice(invoice)),
    decode: async (bolt11: string) => {
      const invoice = [...this.invoices.values()].find((item) => item.bolt11 === bolt11);
      if (!invoice) throw new BitnobError("Invoice not found", { status: 404, path: "/api/lightning/decode" });
      return {
        amountSats: invoice.amountSats,
        expiresAt: invoice.expiresAt,
        isExpired: invoice.expiresAt.getTime() <= this.now(),
      };
    },
    waitForPaid: async (id: string, options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }) => {
      const timeoutMs = options?.timeoutMs ?? 15_000;
      const intervalMs = options?.intervalMs ?? 200;
      const started = this.now();
      for (;;) {
        if (options?.signal?.aborted) throw new BitnobError("Aborted", { status: 499, path: `/api/lightning/invoices/${id}` });
        const invoice = await this.lightning.getInvoice(id);
        if (invoice.status === "paid") return invoice;
        if (this.now() - started >= timeoutMs) return invoice;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };

  readonly customers = {
    create: async (customer: CustomerInput): Promise<{ id: string }> => {
      if (this.failCustomers instanceof BitnobError) throw this.failCustomers;
      if (this.failCustomers) {
        throw new BitnobError("Bitnob indisponible", {
          status: 503,
          path: "/api/customers",
          correlationId: "corr_mock_down",
        });
      }
      const id = `cus_${ulid()}`;
      this.customerRows.set(id, { ...customer, id });
      this.customersCreated.push(customer);
      return { id };
    },
    get: async (id: string) => {
      const customer = this.customerRows.get(id);
      if (!customer) throw new BitnobError("Customer not found", { status: 404, path: `/api/customers/${id}` });
      return customer;
    },
  };

  readonly balances = {
    get: async () => ({
      assets: [
        { asset: "BTC", available: "0.00000000" },
        { asset: "USDT", available: "100.00" },
        { asset: "USDC", available: "50.00" },
      ],
    }),
  };

  readonly rates = {
    get: async () => ({
      btcUsd: MOCK_BTC_USD,
      usdXof: MOCK_USD_XOF,
      fetchedAt: new Date(this.now()),
    }),
    btcTo: async (fiat: "XOF" | "USD", btc: number) => {
      if (fiat === "USD") return btc * MOCK_BTC_USD.mid;
      return btc * MOCK_BTC_USD.sell * MOCK_USD_XOF.buy;
    },
  };

  readonly payouts = {
    supportedCountries: async () => ["SN"],
    countryRequirements: async (country: string): Promise<CountryRequirements> => {
      if (country !== "SN") throw new BitnobError("Pays non supporté", { status: 422, path: `/api/payouts/supported-countries/${country}` });
      const networks: SnNetwork[] = ["wave", "orange", "free", "expresso"];
      return {
        networks,
        accountNumberPattern: String.raw`^(\+?221[7]\d{8}|[7]\d{8})$`,
        minAmount: 100,
        maxAmount: 200_000,
        beneficiaryFields: ["account_name", "account_number", "network"],
      };
    },
    limits: async () => ({ min: 100, max: 200_000, currency: "XOF" }),
    quote: async (input: QuoteInput): Promise<PayoutQuote> => {
      const id = `qt_${ulid()}`;
      const fromAmount = Number(input.amount);
      const settlement = input.toCurrency === "XOF" ? (fromAmount * 590).toFixed(2) : input.amount;
      const quote: MockQuote = {
        id,
        fromAsset: input.fromAsset,
        fromAmount: input.amount,
        toCurrency: input.toCurrency,
        settlementAmount: settlement,
        exchangeRate: "590",
        fees: "0",
        expiresAt: new Date(this.now() + 16 * 60 * 1000),
        reference: input.reference,
        country: input.country,
        finalized: false,
        payoutStatus: "QUOTE",
      };
      this.quotes.set(id, quote);
      return quote;
    },
    initialize: async (quoteId: string, _body: InitializePayoutInput): Promise<Payout> => {
      const quote = this.requireQuote(quoteId);
      if (quote.finalized) throw new BitnobError("Devis déjà finalisé", { status: 409, path: `/api/payouts/${quoteId}/initialize` });
      quote.payoutStatus = "INITIATED";
      quote.payoutId ??= `po_${ulid()}`;
      return { id: quote.payoutId, quoteId, status: "INITIATED", reference: quote.reference };
    },
    finalize: async (quoteId: string): Promise<Payout> => {
      const quote = this.requireQuote(quoteId);
      if (quote.finalized) throw new BitnobError("Devis déjà finalisé", { status: 409, path: `/api/payouts/${quoteId}/finalize` });
      quote.finalized = true;
      quote.payoutStatus = "PROCESSING";
      quote.payoutId ??= `po_${ulid()}`;
      return { id: quote.payoutId, quoteId, status: "PROCESSING", reference: quote.reference };
    },
    get: async (id: string): Promise<Payout> => {
      this.payoutGets.push(id);
      const quote = [...this.quotes.values()].find((item) => item.payoutId === id || item.id === id);
      if (!quote || !quote.payoutId) throw new BitnobError("Payout not found", { status: 404, path: `/api/payouts/${id}` });
      if (quote.finalized && this.settleAfterMs <= 0) quote.payoutStatus = "COMPLETED";
      return { id: quote.payoutId, quoteId: quote.id, status: quote.payoutStatus, reference: quote.reference };
    },
    list: async () => [...this.quotes.values()],
  };

  async whoami(): Promise<{ environment: "sandbox" | "live" | string }> {
    return { environment: "sandbox" };
  }

  async request<T>(): Promise<T> {
    throw new BitnobError("request() non utilisé en mock", { status: 500, path: "/" });
  }

  private requireQuote(quoteId: string): MockQuote {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new BitnobError("Quote not found", { status: 404, path: `/api/payouts/${quoteId}` });
    if (quote.expiresAt.getTime() <= this.now()) {
      quote.payoutStatus = "EXPIRED";
      throw new BitnobError("Quote expired", { status: 409, path: `/api/payouts/${quoteId}` });
    }
    return quote;
  }

  private publicInvoice(invoice: MockInvoice): LightningInvoice {
    const status = invoice.settleAt !== null && this.now() >= invoice.settleAt ? "paid" : invoice.status;
    if (status === "paid") {
      invoice.status = "paid";
      invoice.preimage ??= randomBytes(32).toString("hex");
    }
    return {
      id: invoice.id,
      bolt11: invoice.bolt11,
      request: invoice.request,
      status: invoice.status,
      paymentHash: invoice.paymentHash,
      expiresAt: invoice.expiresAt,
      reference: invoice.reference,
      amountSats: invoice.amountSats,
      preimage: invoice.preimage,
      customerId: invoice.customerId,
    };
  }
}
