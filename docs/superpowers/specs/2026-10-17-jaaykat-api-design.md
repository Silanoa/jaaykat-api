# Design — jaaykat-api

Date : 2026-10-17  
Statut : prêt pour implémentation  
Stack : Node 22, Fastify 5, better-sqlite3 (WAL), zod, TypeScript, `@silanoa/bitnob-lite`

Checkpoints démo :
- 20h00 — tunnel → 2500 F → QR → paid &lt; 15 s
- 00h00 — client scanne affiche → paid côté marchand ; payout quote
- 09h00 — parcours complet ; rate-limit ; SDK depuis npm

---

## 1. Responsabilités

- Auth marchand (téléphone + PIN 6 chiffres, sessions opaque)
- Factures Lightning (création, poll, reconcile, webhooks)
- Conversion XOF ↔ sats (taux Bitnob, snapshot figé)
- Ledger interne (solde retirable)
- Payouts Wave / Orange / Free / Expresso
- Analytics dashboard + score de régularité
- Sert `jaaykat-web/dist` en statique (même origine)
- Journal `api_calls` (écran jury)

## 2. Interdits

- Exposer `BITNOB_*` ou `bitnob_customer_id` au front
- Marquer `paid` / `completed` sans GET Bitnob
- Appeler Bitnob depuis une autre IP que le laptop
- CORS ouvert (même origine uniquement en démo)
- Seed ventes marquées `live` / retirables

## 3. Structure

```
jaaykat-api/
├─ src/
│  ├─ server.ts
│  ├─ auth/          # register, login, me, logout, require-auth, pin
│  ├─ routes/        # invoices, public, sales, dashboard, score, payouts, rates, system, health
│  ├─ modules/
│  │  ├─ invoices/
│  │  ├─ rates/
│  │  ├─ analytics/
│  │  ├─ score/
│  │  └─ payouts/
│  ├─ db/            # migrations, seed.ts, client
│  ├─ webhooks.ts
│  ├─ reconciler.ts
│  └─ admin/reset-pin.ts
├─ public/           # copie de jaaykat-web/dist au build
├─ data/             # gitignored — jaaykat.db
├─ test/
├─ Dockerfile
├─ .env.example
├─ SPEC.md
└─ README.md
```

## 4. Variables d’environnement

```env
NODE_ENV=production
PORT=3000
DATABASE_PATH=./data/jaaykat.db
PUBLIC_URL=                 # https://xxxx.trycloudflare.com
BITNOB_BASE_URL=https://api.bitnob.com
BITNOB_CLIENT_ID=
BITNOB_CLIENT_SECRET=
BITNOB_WEBHOOK_SECRET=
PHONE_PEPPER=               # openssl rand -hex 32
PAYER_PEPPER=
NODE_OPTIONS=--dns-result-order=ipv4first
```

Au boot : `whoami()` ; si 403 IP → exit avec message d’aide SDK.

## 5. Auth (§9 dossier)

| Élément | Décision |
|---------|----------|
| ID | Téléphone SN normalisé `+2217XXXXXXXX` |
| Secret | PIN 6 chiffres (refus 111111, 123456, 654321) |
| Hash | scrypt N=2^17 r=8 p=1, sel 16 o, clé 64 o |
| Session | `randomBytes(32)` base64url ; stocker SHA-256 ; 7 jours |
| Transport | `Authorization: Bearer` |
| Lock | 5 échecs → 15 min |
| Rate limit | 10/min/IP sur register+login (header `CF-Connecting-IP`) |
| PIN oublié | `pnpm admin:reset-pin +2217…` uniquement |

### Register (ordre transactionnel)

1. Valider zod ; 409 si phone pris
2. `customers.create` Bitnob (individual, email `m-<merchantId>@merchants.jaaykat.invalid`, …)
3. Si Bitnob fail → **502**, rien en base
4. Si OK → insert users + merchants + sessions → 201

## 6. Routes (implémenter exactement)

Voir [CONTRACTS.md](../CONTRACTS.md). Priorité P0 :

1. `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
2. `POST /api/invoices` + `GET /api/invoices/:id` (Idempotency-Key)
3. Static SPA + `GET /api/health`
4. `POST /api/auth/register`
5. `POST/GET /api/public/invoices`, `GET /api/public/shops/:slug`
6. `POST /webhooks/bitnob`
7. `GET /api/dashboard`, `GET /api/score`, `GET /api/sales`
8. Payouts quote + create + get
9. `GET /api/system`, `POST /api/score/share`

## 7. Facture — flux

1. Lire taux (cache mémoire `valid_for_seconds`)
2. `amount_sats = round(amount_xof / rate_btc_xof * 1e8)` ; clamp 1…20_000_000
3. `reference = jk_<slug>_<ULID>` ; insert status `creating`
4. `lightning.createInvoice({ autoSettle: true, customerId, … })`
5. Update `pending` + bolt11 + bitnob_invoice_id
6. Poll / reconcile : GET Bitnob max 1×/2 s / facture ;→ `paid` + `settle_method`
7. Webhook : raw body → HMAC-SHA512 → dedupe → même GET confirm

**Idempotence :** même `Idempotency-Key` 10 min → même facture ; retry Bitnob avec **même** reference.

## 8. Schéma SQLite (tables minimales)

`users`, `sessions`, `merchants`, `payers`, `invoices`, `payouts`, `webhook_events`, `api_calls`, `rate_snapshots`, `credit_scores`, `score_shares`

DDL exacte : dossier projet §6.6 + §9.4. Mode WAL. Backup `cp data/jaaykat.db data/backup-<heure>.db` avant checkpoints.

### Ledger

```
balance_xof = Σ invoices.amount_xof (paid, source=live)
            − Σ payouts.amount_xof (status ∉ failed,expired)
```

Seed (`source=seed`) **non** retirable ; UI « historique simulé ».

## 9. Score (formules — tests unitaires obligatoires)

Fenêtre 90 j ; éligible si ≥14 j depuis 1ère vente et ≥20 ventes.

```
Score = round(100 × (0.40·S_reg + 0.30·S_cro + 0.10·S_vol + 0.10·S_fid + 0.10·S_qual))
Bandes : A≥75 · B 60–74 · C 45–59 · D<45
```

Détail composantes : dossier §7.3. Exemple seed attendu ~71 bande B.

## 10. Dashboard

Fenêtres : today | 7d | 30d, fuseau `Africa/Dakar`.  
Métriques : CA, Δ%, N, panier moyen, heatmap, meilleur jour, conversion, délai médian, fidèles top 5, conseil du jour (règles §7.2 priorité 1→6).

## 11. Payouts

1. Valider montant 100–200000, regex numéro, solde ledger
2. Quote Bitnob (`from_asset` fixé après test USDT vs USDC bloc 3)
3. Afficher devis (~16 min)
4. Initialize + finalize **une fois** par devis
5. Poll GET jusqu’à terminal + webhooks `payouts.*`

## 12. Webhooks

1. Raw Buffer avant JSON
2. HMAC-SHA512 timingSafeEqual vs `x-bitnob-signature`
3. Dedupe `event_id` / hash
4. 200 immédiat, traitement async
5. Transitions monotones uniquement

## 13. Reconciler

Toutes les 30 s : factures `pending` &gt; 20 s non affichées → GET Bitnob.

## 14. Seed démo

Script `pnpm seed` : « Awa Beauté », 60 j ventes plausibles (pics 12–14h, 18–20h, samedi fort, 12 clients récurrents, +20 % croissance). `source=seed`. Compte démo : phone + PIN documentés dans README (pas secrets Bitnob).

## 15. Tests API

| Zone | Cas |
|------|-----|
| Auth | register OK, phone taken, pin faible, lock 5 essais, logout révoque |
| Invoices | création, idempotency, paid via mock SDK, jamais paid sans get |
| Score | formules sur fixtures |
| Ledger | seed non retirable |
| Webhook | bad sig → 401 ; duplicate → no double process |
| Public | rate limit 10/min |

## 16. Timeline toi (backend)

| Bloc | Focus |
|------|-------|
| 2 (18–20h) | Fastify, SQLite, invoices, auth login/me, static, tunnel |
| 3 (20h45–00h) | public invoices, webhooks, register+customer, api_calls, payouts quote |
| 4 (00–02h30) | seed, dashboard, score, payouts finalize |
| 5–6 | npm SDK, harden, gitleaks, tag |
| 7–8 | README, Dockerfile, soumission |

## 17. Dépendance SDK

```json
"dependencies": {
  "@silanoa/bitnob-lite": "file:../bitnob-lite"
}
```

Après publish → `"0.1.0"`. Ne pas réécrire HMAC localement.
