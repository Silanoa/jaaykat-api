# Sandbox Bitnob — à constater

Ce fichier décrit la procédure. Il ne contient **aucun résultat observé** : chaque ligne reste « à constater » tant que le laptop autorisé n'a pas lancé le script. Ne pas inventer de statut, de taux ou de nom d'événement.

La VM d'intégration n'a pas l'IP autorisée sur la clé Bitnob. Elle ne doit pas appeler `https://api.bitnob.com`.

## Lancer le constat

Sur le laptop, WARP et VPN coupés, `.env` local (jamais commité) :

```bash
curl -4 https://api.ipify.org
# doit égaler l'IP déclarée sur la clé
NODE_OPTIONS=--dns-result-order=ipv4first pnpm sandbox:check
```

`BITNOB_MODE=live` est obligatoire. Le script affiche l'IPv4 sortante, interroge Bitnob, écrit `docs/sandbox-findings.local.md` (ignoré par git) et quitte avec un code non nul si une vérification échoue. Il ne journalise ni `BITNOB_CLIENT_SECRET`, ni `BITNOB_CLIENT_ID`, ni le secret de webhook.

`SANDBOX_PAYOUT_NUMBER` (numéro SN de test) est optionnel. Sans lui, le devis est tenté et `initialize` / `finalize` restent « à constater ».

## Vérifications

| # | Vérification | Résultat |
|---|--------------|----------|
| 1 | `whoami` = `sandbox` | à constater |
| 2 | Facture `auto_settle: true` puis GET `paid` en moins de 15 s | à constater |
| 3 | Signature webhook HMAC-SHA512 (`x-bitnob-signature`) et nom d'événement | à constater |
| 4 | Taux BTC/USD et USD/XOF (`/api/exchange-rates`, `/api/trading/prices`) | à constater |
| 5 | Devis payout SN (USDT, USDC ou BTC → XOF, `source: offchain`), puis initialize/finalize si possible | à constater |
| 6 | Même `reference` de facture → même identifiant | à constater |
| 7 | `customers.create` individual, e-mail `…@merchants.jaaykat.invalid` | à constater |

## Formes de réponse encore ouvertes

Le client valide avec zod en mode tolérant (`passthrough`, enveloppe `data` ou racine). Tant que le script n'a pas tourné, ces formes sont **à constater** :

- `whoami` : champ `environment`, `env` ou `mode`
- facture : `request` / `bolt11` / `payment_request`, `expires_at` en epoch secondes ou RFC 3339, `amount` en sats
- taux : tableau `{ pair, buy, sell }` ou objet indexé par paire ; présence de BTC/XOF direct
- devis : `settlement_amount` ou `received_amount`, nom du taux, format de l'échéance
- payout : `id` / `payout_id`, statut renvoyé par initialize et finalize
- nom exact de l'événement Lightning et secret de webhook qui correspond

`auto_settle` est envoyé en snake_case, comme le champ `autoSettle` du design SDK. Son refus hors sandbox est à constater.

IPv4 : `NODE_OPTIONS=--dns-result-order=ipv4first` (déjà dans `.env.example`). Le client appelle aussi `dns.setDefaultResultOrder("ipv4first")`.
