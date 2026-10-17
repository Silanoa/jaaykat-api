# Jaaykat — workspace Code & Chain Dakar 2026

Produit : **Jaaykat** (« le vendeur » en wolof) — QR Lightning pour petits commerçants + tableau de bord + score de régularité + retrait mobile money (Wave / Orange Money), sur l’API Bitnob sandbox.

## Répartition des repos

| Repo | Qui | Rôle | Dépend de |
|------|-----|------|-----------|
| [`bitnob-lite`](./bitnob-lite) | Collègue (SDK) | Client TypeScript Bitnob, publié npm | Rien |
| [`jaaykat-api`](./jaaykat-api) | Toi (backend) | Fastify + SQLite, webhooks, métier | `bitnob-lite` |
| [`jaaykat-web`](./jaaykat-web) | Toi (web + mobile) | PWA React (marchand + client) | `jaaykat-api` |

Il n’y a **pas** d’app native : mobile = PWA installée (`jaaykat-web`).

## Pourquoi 3 repos (et pas le monorepo du PDF)

- Travail parallèle réel : le SDK peut avancer / publier sans bloquer l’API.
- Contrat clair : npm package → API → PWA.
- Démo demain : l’API **sert** le build de la PWA (même origine HTTPS via tunnel) — voir [DEPLOY.md](./DEPLOY.md).

## Ordre de construction (non négociable)

1. **SDK** vert (`whoami` + facture `autoSettle`) depuis le laptop IP whitelist.
2. **API** tranche verticale (auth + invoice + poll).
3. **PWA** branchée sur l’API (E05→E07 + C1→C3).
4. Webhooks, payouts, score, seed, polish.

## Documents à lire

| Fichier | Contenu |
|---------|---------|
| [DEPLOY.md](./DEPLOY.md) | Tunnel cloudflared, npm, GitHub, démo demain |
| [CONTRACTS.md](./CONTRACTS.md) | Contrats JSON entre API et Web |
| `bitnob-lite/SPEC.md` | Spec complète SDK |
| `jaaykat-api/SPEC.md` | Spec complète backend |
| `jaaykat-web/SPEC.md` | Spec complète PWA / écrans |

## Phrase pitch

> Jaaykat donne au petit commerçant un QR pour encaisser en Lightning, un tableau de bord qui lui dit quand il vend, un score construit sur ses vraies ventes, et un retrait vers Wave ou Orange Money, le tout sur l’API Bitnob.

## Contraintes critiques Bitnob

- Tous les appels Bitnob partent **uniquement** du backend (laptop, IP `41.214.74.162/32`).
- Jamais la clé dans le front (`VITE_*` = public).
- Statut `paid` / `completed` **uniquement** après relecture GET chez Bitnob.
- Sandbox : `auto_settle: true` → paiement simulé ~5 s.
- Pas d’encaissement Wave/OM via Bitnob ; mobile money = **retrait** seulement.
