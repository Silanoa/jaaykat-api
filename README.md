# jaaykat-api

Backend Jaaykat — Fastify + SQLite + Bitnob via `@silanoa/bitnob-lite`.

Repos d’entrée soumission : ce repo + [bitnob-lite](https://github.com/Silanoa/bitnob-lite) + [jaaykat-web](https://github.com/Silanoa/jaaykat-web).

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

`DEMO_PAY_MODE=auto` (défaut) crée la facture Bitnob tout de suite. `DEMO_PAY_MODE=manual` laisse la facture locale `pending` : le QR pointe vers `payUrl`, et `POST /api/public/invoices/:id/pay` simule le paiement (Wave, Orange, Free, Expresso) en créant alors la facture sandbox avec `auto_settle`. Le statut `paid` arrive ensuite par relecture Bitnob. En mode `manual`, `simulated` vaut `true`.
