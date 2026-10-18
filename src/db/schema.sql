CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone_hash TEXT UNIQUE NOT NULL,
  phone_masked TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  category TEXT,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id),
  bitnob_customer_id TEXT UNIQUE,
  quick_amounts TEXT NOT NULL DEFAULT '[500,1000,2500,5000]',
  locale TEXT NOT NULL DEFAULT 'fr',
  created_at TEXT NOT NULL
);

CREATE TABLE payers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  payer_ref TEXT NOT NULL,
  nickname TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (merchant_id, payer_ref)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  payer_id TEXT REFERENCES payers(id),
  reference TEXT UNIQUE NOT NULL,
  idempotency_key TEXT,
  bitnob_invoice_id TEXT UNIQUE,
  payment_hash TEXT UNIQUE,
  bolt11 TEXT,
  amount_sats INTEGER NOT NULL,
  amount_xof INTEGER NOT NULL,
  rate_btc_xof REAL NOT NULL,
  rate_source TEXT NOT NULL,
  description TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('dynamic','static_qr')),
  status TEXT NOT NULL CHECK (status IN ('creating','pending','paid','expired','failed')),
  settle_method TEXT,
  preimage TEXT,
  source TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','seed')),
  simulated_method TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  paid_at TEXT
);
CREATE INDEX idx_inv_merchant_paid ON invoices(merchant_id, status, paid_at);
CREATE INDEX idx_inv_idem ON invoices(merchant_id, idempotency_key);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  reference TEXT UNIQUE NOT NULL,
  idempotency_key TEXT,
  bitnob_quote_id TEXT,
  bitnob_payout_id TEXT UNIQUE,
  network TEXT NOT NULL CHECK (network IN ('wave','orange','free','expresso')),
  account_number_masked TEXT NOT NULL,
  account_name TEXT NOT NULL,
  amount_xof INTEGER NOT NULL CHECK (amount_xof BETWEEN 100 AND 200000),
  from_asset TEXT NOT NULL,
  from_amount TEXT,
  exchange_rate TEXT,
  fees TEXT,
  quote_expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('quoted','initiated','processing','completed','failed','expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payout_idem ON payouts(merchant_id, idempotency_key);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  event_type TEXT,
  signature_valid INTEGER NOT NULL,
  raw_body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

CREATE TABLE api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  duration_ms INTEGER,
  correlation_id TEXT
);

CREATE TABLE rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  pair TEXT NOT NULL,
  mid REAL,
  buy REAL,
  sell REAL,
  valid_for_s INTEGER
);

CREATE TABLE credit_scores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  computed_at TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  score INTEGER,
  band TEXT,
  eligible INTEGER NOT NULL,
  components TEXT NOT NULL
);

CREATE TABLE score_shares (
  token_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  score_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT
);

CREATE VIEW daily_sales AS
SELECT
  merchant_id,
  substr(paid_at, 1, 10) AS day,
  SUM(amount_xof) AS revenue_xof,
  COUNT(*) AS n,
  COUNT(DISTINCT payer_id) AS unique_payers
FROM invoices
WHERE status = 'paid' AND paid_at IS NOT NULL
GROUP BY merchant_id, substr(paid_at, 1, 10);
