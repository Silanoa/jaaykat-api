# Sandbox Bitnob — à constater

Ce fichier décrit la procédure ; les résultats constatés sont en bas.  Les lignes du tableau ci-dessous restent la liste de contrôle d'origine. Ne pas inventer de statut, de taux ou de nom d'événement.

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

## Constaté le 2026-10-17 (laptop autorisé, sandbox, `BITNOB_MODE=live`)

| # | Vérification | Résultat constaté |
|---|--------------|-------------------|
| 1 | `whoami` | `environment = sandbox` |
| 2 | Facture `auto_settle: true` puis GET `paid` | `paid` en 8 à 10 s sur 6 essais |
| 3 | Webhook | Événement `deposit.success` (feature « Crypto » dans les logs Bitnob), signé HMAC-SHA512 avec le secret saisi à la création du webhook, valide ; reçu 8 à 12 s après le règlement. Corps : `data.{amount (sats), chain: "lightning", currency: "BTC", fee, invoice, reference, timestamp, transaction_id}`. « Send test event » envoie `webhook.test` (`{message, test: true, webhook_id}`). |
| 4 | Taux | `/api/exchange-rates` : `data.rates[{target_currency, buy_rate, sell_rate, inverse_rate}]`, base USD, le XOF s'appelle `CFA`. `/api/trading/prices` : `data.prices[{base_currency, quote_currency, price}]`. Pas de paire BTC/XOF directe. |
| 5 | Devis payout SN (USDT et USDC vers XOF, `source: offchain`) | Réponse sous `data.payout` : `id` (UUID), `quote_id` (`QT2_…`), `settlement_amount`, `exchange_rate.{rate, effective_rate}`, `expires_at` (environ 16 min). 10 USDT donnent 5 895 à 5 901 XOF. initialize/finalize : à constater (portefeuille à 0 $). |
| 6 | Même `reference` de facture | Même identifiant de facture |
| 7 | `customers.create` individual, e-mail `.invalid` | Accepté |

## Piège constaté : Content-Type dupliqué

Bitnob envoie ses webhooks avec l'en-tête `Content-Type: application/json, application/json`. Fastify répond alors 500 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) et Bitnob met la livraison en « Retrying ». L'API normalise cet en-tête pour `/webhooks/bitnob` (test de non-régression dans `test/webhooks.test.ts`).

## Webhook : configuration constatée

Le formulaire « Create a webhook » du dashboard n'a que quatre champs : Name, Endpoint URL, Signing secret (à saisir soi-même), Retry count. Aucun choix d'événements : tous les événements arrivent sur l'URL.

## Arrondi du devis de retrait : 2 000 F devenait 2 001 F, puis 2 002 F

Le devis envoyait `montant / 590` USDT. Le taux effectif de Bitnob varie (589,5 à 590,6 constaté le 2026-10-17) et reste au-dessus de 590 : 2 000 F donnaient 2 001,01 puis 2 002,02 F de `settlement_amount`. Ce n'est ni un arrondi ni un problème de formatage : le marchand aurait reçu plus que le solde débité.

Correction : après le premier devis, si `settlement_amount` s'écarte de 0,5 F ou plus du montant demandé, l'API redemande un devis avec `ceil(montant / exchange_rate, 6 décimales)` USDT, ce qui donne le montant demandé à moins de 0,01 F près. Bitnob refuse une `reference` déjà utilisée (409 `payout with reference ... already exists`) : le second devis porte la référence suffixée `_r`, et la ligne `payouts` garde cette référence. Le premier devis expire seul.
