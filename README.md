# jaaykat-api

Backend Jaaykat : Fastify, SQLite et Bitnob via le paquet npm `bitnob-lite` (client Bitnob non officiel, dépôt `Silanoa/bitnob-lite`). `jaakat-client` de Dar-rius est un client de cette API, pas du SDK Bitnob. Détails dans `docs/SDK_SWAP.md`.

Dépôts liés : [bitnob-lite](https://github.com/Silanoa/bitnob-lite) et [jaaykat-web](https://github.com/Silanoa/jaaykat-web).

## Docs

- [DEPLOY.md](./docs/DEPLOY.md)
- [CONTRACTS.md](./docs/CONTRACTS.md)

## Run

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Le process sert aussi la PWA depuis `public/` (build de `jaaykat-web`).  
Démo : `cloudflared tunnel --url http://localhost:3000` — seule cette machine appelle Bitnob (IP whitelist).

`DEMO_PAY_MODE=auto` (défaut) crée la facture Bitnob tout de suite. `DEMO_PAY_MODE=manual` laisse la facture locale `pending` : le QR pointe vers `payUrl`, et `POST /api/public/invoices/:id/pay` simule le paiement (Lightning, Wave, Orange, Yas, Expresso ; `free` reste accepté comme alias de `yas`) en créant alors la facture sandbox avec `auto_settle`. Le statut `paid` arrive ensuite par relecture Bitnob. En mode `manual`, `simulated` vaut `true`.

## Historique de démonstration (seed)

`pnpm seed` charge le compte « Awa Beauté » (77 123 45 67, PIN 482915) avec 60 jours de ventes payées simulées (`source = seed`). À lancer sur une base séparée (`DATABASE_PATH=/chemin/test.db pnpm seed`, puis `pnpm dev` avec la même variable) pour ne pas toucher aux données live.

- Ces ventes ne sont jamais retirables : `balanceXof` (solde retirable) les exclut, `GET /api/balance` les expose à part (`demoRevenueXof`, `demoSalesCount`), et un devis au-delà du retirable répond 422 `INSUFFICIENT_BALANCE`.
- Le score et l'attestation de ce compte sont marqués `demo: true` : ils sont calculés sur des ventes simulées et la page publique l'écrit.
- Un marchand sans seed est éligible à partir de 14 jours et 20 ventes payées ; avant, `POST /api/score/share` répond 422 `NOT_ELIGIBLE`.
