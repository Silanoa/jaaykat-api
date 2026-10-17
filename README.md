# jaaykat-api

Backend Jaaykat — Fastify + SQLite + Bitnob via `@silanoa/bitnob-lite`.

Repos d’entrée soumission : ce repo + [bitnob-lite](https://github.com/Silanoa/bitnob-lite) + [jaaykat-web](https://github.com/Silanoa/jaaykat-web).

## Docs

- [AGENTS.md](./AGENTS.md)
- [Design](./docs/superpowers/specs/2026-10-17-jaaykat-api-design.md)
- [Plan](./docs/superpowers/plans/2026-10-17-jaaykat-api-implementation.md)
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
