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
| POST | `/api/invoices` | Bearer + `Idempotency-Key` | `{amountXof, label?}` |
| GET | `/api/invoices/:id` | Bearer | polling 2 s |
| POST | `/api/public/invoices` | non, rate-limit | `{slug, amountXof, payerName?, payerPhone?, deviceId?}` |
| GET | `/api/public/invoices/:id` | non | `{status, amountXof, expiresAt}` |
| GET | `/api/public/shops/:slug` | non | `{name, category}` |
| GET | `/api/sales?from&to` | Bearer | |

### Dashboard / score / solde / payouts

| Méthode | Route | Auth |
|---------|-------|------|
| GET | `/api/dashboard?range=today\|7d\|30d` | Bearer |
| GET | `/api/score` | Bearer |
| POST | `/api/score/share` | Bearer → `{url}` |
| GET | `/api/balance` | Bearer |
| POST | `/api/payouts/quote` | Bearer |
| POST | `/api/payouts` | Bearer + Idempotency-Key |
| GET | `/api/payouts/:id` | Bearer |
| GET | `/api/rates` | non |
| GET | `/api/system` | Bearer (jury) |
| GET | `/api/health` | non → `{ok, bitnob}` |
| POST | `/webhooks/bitnob` | HMAC Bitnob (pas le front) |

### Forme invoice (réponse type)

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
  "source": "live|seed"
}
```

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
