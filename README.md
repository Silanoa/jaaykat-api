# jaaykat-api

Backend Jaaykat — Fastify + SQLite + Bitnob (via `@silanoa/bitnob-lite`).

**Point d’entrée jury / soumission** : ce README + liens vers [bitnob-lite](https://github.com/Silanoa/bitnob-lite) et [jaaykat-web](https://github.com/Silanoa/jaaykat-web).

## Spec

→ [SPEC.md](./SPEC.md)

## Architecture (démo)

Laptop (`:3000`) sert l’API **et** la PWA (`public/` = build de `jaaykat-web`).  
Exposé en HTTPS via `cloudflared`. Seul ce process appelle Bitnob (IP whitelist).

## Setup

```bash
# Prérequis : bitnob-lite clone en ../bitnob-lite (ou npm après publish)
cp .env.example .env   # remplir secrets
pnpm install
pnpm seed
pnpm dev
```

Sync PWA :

```powershell
cd ..\jaaykat-web; pnpm build
Copy-Item -Recurse -Force dist\* ..\jaaykat-api\public\
```

Tunnel :

```bash
cloudflared tunnel --url http://localhost:3000
# PUBLIC_URL=https://….trycloudflare.com + webhook Bitnob
```

## Repos liés

| Repo | Rôle |
|------|------|
| [bitnob-lite](https://github.com/Silanoa/bitnob-lite) | SDK |
| [jaaykat-web](https://github.com/Silanoa/jaaykat-web) | PWA |
| [DEPLOY](https://github.com/Silanoa/jaaykat-api/blob/main/docs/DEPLOY.md) | Déploiement démo |

## Honnêteté démo

- Historique 60 j = `source=seed` (simulé)
- Paiements sandbox = `auto_settle` (simulés)
- Pas d’encaissement Wave/OM via Bitnob — mobile money = retrait
