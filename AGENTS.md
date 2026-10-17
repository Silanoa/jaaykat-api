# AGENTS.md — jaaykat-api

## Avant tout code

1. Lire `docs/superpowers/specs/2026-10-17-jaaykat-api-design.md`
2. Suivre `docs/superpowers/plans/2026-10-17-jaaykat-api-implementation.md`
3. TDD (`test-driven-development`)
4. Exécution : `executing-plans` ou `subagent-driven-development`
5. Fin de branche : `verification-before-completion` puis `finishing-a-development-branch`

## Dépendance SDK

Le package `@silanoa/bitnob-lite` est implémenté dans un autre repo.  
Tant qu’il n’est pas prêt : mocker l’interface dans les tests ; ne pas réécrire HMAC ici.

## Interdits

- Secrets dans le front ou dans git
- `paid` / `completed` sans relecture GET Bitnob
- Appels Bitnob hors laptop (IP whitelist)
- Commentaires filler / narratifs inutiles

## Démo

Voir `docs/DEPLOY.md` — tunnel cloudflared, même origine que la PWA.
