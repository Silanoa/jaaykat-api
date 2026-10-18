# Contrats inter-repos

Version : `2026-10-17` — alignée sur le dossier projet Jaaykat v2.

## 1. Client Bitnob

Le client signé de ce dépôt est `src/bitnob/live.ts` (signature HMAC sortante, `onRequest` vers le journal `api_calls`, voir ci-dessous). Le package `@silanoa/bitnob-lite` n'est pas branché : la procédure de remplacement est dans `docs/SDK_SWAP.md`.

Reprises automatiques côté Bitnob (2 reprises, sur erreur réseau, 429 ou 5xx) : les lectures GET, et la création de facture Lightning parce qu'elle porte une `reference` (même référence, même facture, constaté en sandbox). Devis, initialisation et finalisation de retrait ne sont jamais rejoués automatiquement. Le journal `api_calls` garde les 500 derniers appels.

## 2. API → Web (JSON)

Base URL : même origine en prod démo (`https://tunnel…`). Dev web : proxy Vite `/api` → `localhost:3000`.

### Auth

| Méthode | Route | Auth | Corps / réponse |
|---------|-------|------|-----------------|
| POST | `/api/auth/register` | non | `{shopName,category,firstName,lastName,phone,pin}` → `{token,expiresAt,user,merchant}` |
| POST | `/api/auth/login` | non | `{phone,pin}` → idem |
| GET | `/api/auth/me` | Bearer | `{user,merchant,session}` |
| POST | `/api/auth/logout` | Bearer | 204 |

Erreurs : `{ error: "CODE", message: "…", … }`.

| Code | HTTP | Cas |
|------|------|-----|
| `VALIDATION` | 400 | champ invalide (`fields` possible), `Idempotency-Key` absente, moyen de paiement invalide |
| `UNAUTHENTICATED` | 401 | jeton absent, inconnu ou expiré |
| `INVALID_CREDENTIALS` | 401 | téléphone ou PIN incorrect, avec `attemptsLeft` |
| `NOT_FOUND` | 404 | facture, boutique, retrait, devis ou jeton inconnu ; `POST …/pay` en `DEMO_PAY_MODE=auto` |
| `PHONE_TAKEN` | 409 | numéro déjà inscrit |
| `EXPIRED` | 409 | facture expirée (`…/pay`) |
| `ALREADY_PAID` | 409 | facture déjà payée (`…/pay`) |
| `QUOTE_EXPIRED` | 409 | devis de retrait expiré |
| `INSUFFICIENT_BALANCE` | 422 | montant supérieur au solde retirable ; `message` indique le solde disponible et `retirableXof` le donne en nombre |
| `NOT_ELIGIBLE` | 422 | attestation demandée avant 14 jours et 20 ventes payées ; `remaining: { days, sales }` |
| `LOCKED` | 423 | compte verrouillé après des PIN erronés |
| `RATE_LIMITED` | 429 | quota dépassé, avec `retryAfterSeconds` |
| `INTERNAL` | 500 | erreur non prévue |
| `BITNOB_UNAVAILABLE` | 502 | Bitnob injoignable ou refus, rien n'est enregistré pour une création |

Webhook `POST /webhooks/bitnob` : 401 `INVALID_SIGNATURE` (signature absente ou fausse), 200 `{ ok: true, duplicate: true }` pour un événement déjà traité, 500 `WEBHOOK_FAILED` si le traitement échoue (l'événement est alors retiré de `webhook_events` pour que Bitnob puisse le rejouer).

Quotas par minute et par IP : `POST /api/auth/register` et `POST /api/auth/login` 10. Les routes publiques sont dans le tableau ci-dessous.

### Factures / ventes

| Méthode | Route | Auth | Notes |
|---------|-------|------|-------|
| POST | `/api/invoices` | Bearer + `Idempotency-Key` | `{amountXof, label?}` → `{ invoice }` |
| GET | `/api/invoices/:id` | Bearer | polling 2 s → `{ invoice }` |
| POST | `/api/public/invoices` | non, 10/min par IP | `{slug, amountXof, payerName?, payerPhone?, deviceId?}` → `{ invoice }` |
| GET | `/api/public/invoices/:id` | non, 150/min par IP et facture | plat, sans `bolt11` : `{status, amountXof, expiresAt, demoPayment, payMethod}` |
| POST | `/api/public/invoices/:id/pay` | non, 10/min par IP et facture | `DEMO_PAY_MODE=manual` seulement, réponse 202 immédiate. Corps `{ method: "lightning"\|"wave"\|"orange"\|"yas"\|"expresso" }` → plat `{status, amountXof, expiresAt, demoPayment, payMethod}` |
| GET | `/api/public/shops/:slug` | non, 60/min par IP | `{name, category}` |
| GET | `/api/public/shares/:token` | non, 60/min par IP | attestation, voir ci-dessous |
| GET | `/api/sales?from&to` | Bearer | `{ items }` |

### Dashboard / score / solde / payouts

| Méthode | Route | Auth |
|---------|-------|------|
| GET | `/api/dashboard?range=today\|7d\|30d` | Bearer |
| GET | `/api/score` | Bearer |
| POST | `/api/score/share` | Bearer → `{ url }`, 422 `NOT_ELIGIBLE` si le marchand n'est pas éligible |
| GET | `/api/balance` | Bearer → `{ balanceXof, balanceSats, demoRevenueXof, demoSalesCount, lastPayouts }` |
| POST | `/api/payouts/quote` | Bearer → `{ quote }` |
| POST | `/api/payouts` | Bearer + Idempotency-Key, corps `{ quoteId }` → `{ payout }` |
| GET | `/api/payouts/:id` | Bearer → `{ payout }` |
| GET | `/api/rates` | non → `{ btcXof, btcUsd, usdXof, ts, validFor, source }` |
| GET | `/api/system` | Bearer (jury) |
| GET | `/api/health` | non → `{ ok, bitnob, mode, demoPayMode }` |
| POST | `/webhooks/bitnob` | HMAC Bitnob (pas le front) |

### Auth (champs)

`user` : `{ id, phoneMasked }`. `merchant` : `{ id, slug, displayName, category, qrUrl }`. `GET /api/auth/me` ajoute `session: { expiresAt }`.

### Forme invoice

`POST` marchand, `GET` marchand et `POST` public renvoient l'enveloppe `{ "invoice": { … } }`. `GET /api/public/invoices/:id` et `POST /api/public/invoices/:id/pay` restent plats, sans `bolt11`.

```json
{
  "id": "01J…",
  "status": "creating|pending|paid|expired|failed",
  "amountXof": 2500,
  "amountSats": 6457,
  "bolt11": "lntb…",
  "expiresAt": "2026-10-17T18:15:00.000Z",
  "paidAt": null,
  "label": null,
  "channel": "dynamic|static_qr",
  "source": "live|seed",
  "reference": "jk_awa-beaute_01J…",
  "paymentHash": null,
  "simulated": true,
  "demoPayment": false,
  "payMethod": null,
  "payUrl": null
}
```

`paymentHash` est nul tant que Bitnob ne l'a pas renvoyé. `simulated` est vrai pour une vente `live` si `BITNOB_AUTO_SETTLE` n'est pas `false`, et pour toute vente `live` en `DEMO_PAY_MODE=manual`.

`DEMO_PAY_MODE` vaut `auto` (défaut) ou `manual`.

- `auto` : création inchangée (facture Bitnob immédiate). `demoPayment` est `false`, `payMethod` et `payUrl` sont `null`. `POST …/pay` répond 404 `{ "error": "NOT_FOUND", "message": "Paiement simulé indisponible." }`.
- `manual` : `POST /api/invoices` et `POST /api/public/invoices` n'appellent pas `lightning.createInvoice`. La ligne est `pending`, `bolt11` est `null`, `amountSats` suit le taux courant, `expiresAt` = création + 15 min. `simulated` et `demoPayment` sont `true`. `payMethod` est `null` tant que le client n'a pas payé. `payUrl` = `${PUBLIC_URL}/p/${slug}?facture=${id}` (chemin seul si `PUBLIC_URL` est vide).

`POST /api/public/invoices/:id/pay` (manual) crée alors la facture Bitnob avec `auto_settle: true`, la `reference` déjà prévue, et une expiry égale au temps restant. La réponse 202 part dès que le moyen choisi est enregistré ; la facture Bitnob est créée ensuite en arrière-plan (3 essais, reprise par le polling public ou le réconciliateur si elle n'a pas abouti, y compris après un redémarrage). Réponse 202 :

```json
{
  "status": "pending",
  "amountXof": 2500,
  "expiresAt": "2026-10-17T18:15:00.000Z",
  "demoPayment": true,
  "payMethod": "wave"
}
```

`lightning` représente le portefeuille Lightning de l'acheteur : `GET /api/public/invoices/:id` ajoute alors `bolt11` dès que la facture Bitnob existe (créée avec `auto_settle`), absent pour les autres moyens. En sandbox le règlement est simulé : l'API `lightning/pay` n'est pas activée, la facture se règle par `auto_settle`. Un second appel ne recrée rien et renvoie 202 avec le `payMethod` déjà choisi. `paid` n'est posé que par le GET Bitnob (polling, webhook ou reconciler). 400 `{ "error": "VALIDATION" }` si `method` est invalide. 409 `{ "error": "EXPIRED", "message": "Cette facture a expiré." }` si `expiresAt` est passé ou le statut est `expired`. 409 `{ "error": "ALREADY_PAID", "message": "Cette facture est déjà payée." }` si le statut est `paid`. Facture inconnue : 404. `yas` désigne Yas Sénégal (ex-Free, Free Money devenu Mixx by Yas). `free` reste accepté comme alias de `yas` : l'API le range en `yas` dans `payMethod`, et les anciennes lignes enregistrées avec `free` sont relues en `yas`. Le `network` des retraits reste `free`, valeur attendue par Bitnob.

`GET /api/public/invoices/:id` :

```json
{
  "status": "pending",
  "amountXof": 2500,
  "expiresAt": "2026-10-17T18:15:00.000Z",
  "demoPayment": false,
  "payMethod": null
}
```

### Ventes

`{ items: [{ id, status, amountXof, amountSats, createdAt, paidAt, label, channel, source, payerNickname }] }`. `payerNickname` est un prénom, jamais un numéro.

### Tableau de bord

`demo` est vrai quand le compte porte un historique de démonstration (`source = seed`) : les chiffres incluent alors des ventes simulées. `kpis` : `revenueXof`, `revenueDeltaPct` (ratio, `null` si la période précédente est à 0), `salesCount`, `averageBasketXof`, `conversionRate` (ratio), `medianPaySeconds`, `bestDay`, `peakLabel`. `heatmap` : `{ weekday, hour, salesCount, revenueXof }[]`, lundi = 0. `loyal` : `{ nickname, purchases, revenueXof }`. `advice` : `{ text, figures }`. `figures` est `null` : les chiffres restent dans `text` (formules du dossier).

### Score

`{ score, band, eligible, demo, windowDays, thresholds: { days, sales }, remaining: { days, sales }, computedAt, progress: { daysSinceFirst, salesCount }, components: [{ key, value }], actions: [{ text, points }] }`. Le score ne compte que les ventes payées des `windowDays` (90) derniers jours. `eligible` exige `thresholds.days` (14) jours depuis la première vente payée et `thresholds.sales` (20) ventes payées ; `score` et `band` valent `null` tant que `eligible` est faux, et `remaining` dit ce qu'il manque. `demo` est vrai si une vente payée de la fenêtre vient de l'historique de démonstration. `key` : `regularity | growth | volume | loyalty | quality`. `value` entre 0 et 1. `GET /api/score` ne persiste rien : seule une attestation émise écrit une ligne dans `credit_scores`.

### Solde, devis, retrait

`balanceXof` est le solde retirable : ventes payées de source `live` moins les retraits qui ne sont ni `failed` ni `expired`. `demoRevenueXof` et `demoSalesCount` donnent le chiffre d'affaires et le nombre de ventes de l'historique de démonstration (`source = seed`) : ils ne font jamais partie de `balanceXof` et ne sont pas retirables. `lastPayouts` : `{ id, amountXof, network, status, createdAt }`. `quote` : `{ id, amountXof, receivedXof, exchangeRate, fees, network, accountNumberMasked, accountName, expiresAt }`. `payout` : `{ id, status, amountXof, network, reference, failureReason }`. `network` : `wave | orange | free | expresso` (`free` est la valeur Bitnob de Yas ; `POST /api/payouts/quote` accepte aussi `yas`, converti en `free`). `status` : `quoted | initiated | processing | completed | failed | expired`. `completed` seulement après un GET Bitnob.

### Attestation

`POST /api/score/share` fige une attestation : le contenu est copié dans `score_shares.snapshot` à l'émission et ne change plus. Refus 422 `NOT_ELIGIBLE` (`message` : « Attestation indisponible. Encore X ventes payées et Y jours pour être éligible. », `remaining: { days, sales }`) tant que le marchand n'est pas éligible. Le lien est valable 7 jours.

`GET /api/public/shares/:token` →

```json
{
  "attestationId": "JK-7KQ2-M9XA",
  "shopName": "Chez Awa",
  "status": "valid",
  "issuedAt": "2026-10-17T18:00:00.000Z",
  "expiresAt": "2026-10-24T18:00:00.000Z",
  "demo": false,
  "environment": "sandbox",
  "windowDays": 90,
  "score": 71,
  "band": "B",
  "period": { "from": "2026-09-27", "to": "2026-10-17" },
  "salesCount": 25,
  "totalXof": 62500
}
```

`period` va de la date (Dakar) de la première vente payée de la fenêtre à la date d'émission. `salesCount` et `totalXof` ne comptent que les ventes payées de la fenêtre. `demo` est vrai si l'une d'elles vient de l'historique de démonstration : l'attestation est alors étiquetée « Démonstration » et n'atteste rien de réel. `environment` est l'environnement Bitnob lu par `whoami` à l'émission (`sandbox`, `live`…), `mock` en `BITNOB_MODE=mock`, `unknown` si `whoami` échoue : la page publique signale tout environnement autre que `live` ou `production`. `status` : `valid | expired | revoked`. Pour `revoked`, `score`, `band`, `period`, `salesCount` et `totalXof` valent `null`. Jeton inconnu : 404. Aucun téléphone, aucun client, aucun jeton dans la réponse. `attestationId` est tiré au hasard à l'émission (`JK-XXXX-XXXX`) ; il identifie le document imprimé, la vérification se fait par le lien ou le QR de la page `/s/:token`, servie par la PWA.

Il n'existe pas encore de route pour révoquer une attestation : `revoked` se pose en base (`score_shares.revoked = 1`). La migration `user_version` 3 révoque les liens émis avant l'ajout de `snapshot`, qui n'avaient ni identifiant ni périmètre vérifiable. Aucun PDF ni image n'est généré.

### Santé et jury

`/api/health` : `bitnob` est un booléen (client joignable en mock, sandbox ou live) ; `mode` vaut `mock` ou `live` (mode de l'API, pas l'environnement Bitnob : celui-ci est dans `/api/system`) ; `demoPayMode` vaut `auto` ou `manual`. `/api/system` : `{ env, demoPayMode, platformBalances, lastCalls: [{ at, method, path, status, durationMs, correlationId }], seedHistory }`. En `BITNOB_MODE=live`, `env` vient de `whoami` (cache 60 s) et retombe sur `live` si l'appel échoue. En mock, `env` reste `mock`.

## 3. Web → stockage local

| Clé | Où | Contenu |
|-----|----|---------|
| `jk.session` | localStorage | `{ token, expiresAt }` |
| deviceId | localStorage | UUID anonyme payeur |
| cache dashboard/sales/score | IndexedDB (SW) | stale-while-revalidate |

401 avec jeton : efface `jk.session`, `jk.profile` et `jk.cachedAt`, puis redirige vers `/app/login` (message de session expirée).

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
