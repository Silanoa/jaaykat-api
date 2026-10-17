# Contrats inter-repos

Version : `2026-10-17` — alignée sur le dossier projet Jaaykat v2.

## 1. SDK → API

Package : `@silanoa/bitnob-lite` (scope npm à confirmer = `npm whoami`).

```ts
import { BitnobClient } from "@silanoa/bitnob-lite";

const client = new BitnobClient({
  clientId: process.env.BITNOB_CLIENT_ID!,
  clientSecret: process.env.BITNOB_CLIENT_SECRET!,
  onRequest: (log) => { /* journal api_calls */ },
});
```

L’API **ne** réimplémente **pas** HMAC, retries, parse webhooks. Si une méthode manque → issue sur `bitnob-lite`, pas de fork local.

Versions pendant le hackathon :
- Avant publish : `"@silanoa/bitnob-lite": "file:../bitnob-lite"`
- Après publish : `"@silanoa/bitnob-lite": "0.1.0"`

## 2. API → Web (JSON)

Base URL : même origine en prod démo (`https://tunnel…`). Dev web : proxy Vite `/api` → `localhost:3000`.

### Auth

| Méthode | Route | Auth | Corps / réponse |
|---------|-------|------|-----------------|
| POST | `/api/auth/register` | non | `{shopName,category,firstName,lastName,phone,pin}` → `{token,expiresAt,user,merchant}` |
| POST | `/api/auth/login` | non | `{phone,pin}` → idem |
| GET | `/api/auth/me` | Bearer | `{user,merchant,session}` |
| POST | `/api/auth/logout` | Bearer | 204 |

Erreurs : `{ error: "CODE", message: "…", … }` — codes : `VALIDATION`, `PHONE_TAKEN`, `INVALID_CREDENTIALS`, `LOCKED`, `RATE_LIMITED`, `UNAUTHENTICATED`, `BITNOB_UNAVAILABLE`.

### Factures / ventes

| Méthode | Route | Auth | Notes |
|---------|-------|------|-------|
| POST | `/api/invoices` | Bearer + `Idempotency-Key` | `{amountXof, label?}` → `{ invoice }` |
| GET | `/api/invoices/:id` | Bearer | polling 2 s → `{ invoice }` |
| POST | `/api/public/invoices` | non, rate-limit | `{slug, amountXof, payerName?, payerPhone?, deviceId?}` → `{ invoice }` |
| GET | `/api/public/invoices/:id` | non | `{status, amountXof, expiresAt}` seulement |
| GET | `/api/public/shops/:slug` | non | `{name, category}` |
| GET | `/api/public/shares/:token` | non, rate-limit | attestation, voir ci-dessous |
| GET | `/api/sales?from&to` | Bearer | `{ items }` |

### Dashboard / score / solde / payouts

| Méthode | Route | Auth |
|---------|-------|------|
| GET | `/api/dashboard?range=today\|7d\|30d` | Bearer |
| GET | `/api/score` | Bearer |
| POST | `/api/score/share` | Bearer → `{ url }` |
| GET | `/api/balance` | Bearer → `{ balanceXof, balanceSats, lastPayouts }` |
| POST | `/api/payouts/quote` | Bearer → `{ quote }` |
| POST | `/api/payouts` | Bearer + Idempotency-Key, corps `{ quoteId }` → `{ payout }` |
| GET | `/api/payouts/:id` | Bearer → `{ payout }` |
| GET | `/api/rates` | non → `{ btcXof, btcUsd, usdXof, ts, validFor, source }` |
| GET | `/api/system` | Bearer (jury) |
| GET | `/api/health` | non → `{ ok, bitnob, mode }` |
| POST | `/webhooks/bitnob` | HMAC Bitnob (pas le front) |

### Auth (champs)

`user` : `{ id, phoneMasked }`. `merchant` : `{ id, slug, displayName, category, qrUrl }`. `GET /api/auth/me` ajoute `session: { expiresAt }`.

### Forme invoice

`POST` marchand, `GET` marchand et `POST` public renvoient l'enveloppe `{ "invoice": { … } }`. `GET /api/public/invoices/:id` reste plat, sans `bolt11`.

```json
{
  "id": "01J…",
  "status": "creating|pending|paid|expired|failed",
  "amountXof": 2500,
  "amountSats": 4230,
  "bolt11": "lntb…",
  "expiresAt": "2026-10-18T…",
  "paidAt": null,
  "label": null,
  "channel": "dynamic|static_qr",
  "source": "live|seed",
  "paymentHash": null
}
```

`paymentHash` est absent ou nul tant que Bitnob ne l'a pas renvoyé. `reference` et `simulated` peuvent accompagner l'objet ; la PWA peut les ignorer.

### Ventes

`{ items: [{ id, status, amountXof, amountSats, createdAt, paidAt, label, channel, source, payerNickname }] }`. `payerNickname` est un prénom, jamais un numéro.

### Tableau de bord

`kpis` : `revenueXof`, `revenueDeltaPct` (ratio, `null` si la période précédente est à 0), `salesCount`, `averageBasketXof`, `conversionRate` (ratio), `medianPaySeconds`, `bestDay`, `peakLabel`. `heatmap` : `{ weekday, hour, salesCount, revenueXof }[]`, lundi = 0. `loyal` : `{ nickname, purchases, revenueXof }`. `advice` : `{ text, figures }`. `figures` est `null` : les chiffres restent dans `text` (formules du dossier).

### Score

`{ score, band, eligible, computedAt, progress: { daysSinceFirst, salesCount }, components: [{ key, value }], actions: [{ text, points }] }`. `key` : `regularity | growth | volume | loyalty | quality`. `loyalty` est la fidélité du dossier. `value` entre 0 et 1.

### Solde, devis, retrait

`lastPayouts` : `{ id, amountXof, network, status, createdAt }`. `quote` : `{ id, amountXof, receivedXof, exchangeRate, fees, network, accountNumberMasked, accountName, expiresAt }`. `payout` : `{ id, status, amountXof, network, reference, failureReason }`. `network` : `wave | orange | free | expresso`. `status` : `quoted | initiated | processing | completed | failed | expired`. `completed` seulement après un GET Bitnob.

### Attestation

`GET /api/public/shares/:token` → `{ shopName, score, band, period, salesCount, computedAt, expiresAt, status }`. `period` est une chaîne (`"90 jours"`). `status` : `valid | expired | revoked`. Jeton inconnu : 404. Aucun montant, aucun client, aucun téléphone. La page `/s/:token` est servie par la PWA.

### Santé et jury

`/api/health` : `bitnob` est un booléen (client joignable en mock, sandbox ou live) ; `mode` vaut `mock`, `sandbox` ou `live`. `/api/system` : `{ env, platformBalances, lastCalls: [{ at, method, path, status, durationMs, correlationId }], seedHistory }`. `env` suit `BITNOB_MODE` (`mock` ou `live`) tant que `whoami` n'a pas confirmé `sandbox`.

## 3. Web → stockage local

| Clé | Où | Contenu |
|-----|----|---------|
| `jk.session` | localStorage | `{ token, expiresAt }` |
| deviceId | localStorage | UUID anonyme payeur |
| cache dashboard/sales/score | IndexedDB (SW) | stale-while-revalidate |

401 Bearer → supprimer `jk.session` → écran E04.

## 4. Pages hors API JSON

| Path | Qui |
|------|-----|
| `/app/*` | PWA marchand (SPA) |
| `/p/:slug` | Page paiement client |
| `/s/:token` | Attestation score publique |

## 5. Règles d’état (tous les repos)

1. SDK = **sans état** (pas de DB, pas de cache).
2. Bitnob = vérité des statuts paiement / payout.
3. SQLite API = vérité métier (lien boutique↔facture, XOF figé, score, sessions).
4. Téléphone = cache d’affichage uniquement.
