# Client Bitnob : état des paquets

Le client Bitnob est le paquet `bitnob-lite` (dépôt `Silanoa/bitnob-lite`). `src/bitnob/live.ts`, `types.ts`, `errors.ts` et `webhooks.ts` ne font que le réexporter sous les noms historiques de l'API.

## jaakat-client (Dar-rius), analysé le 2026-10-18

Dépôt `https://github.com/Dar-rius/jaakat-client`, commit `ac7b1ae`, paquet `jaaykat-client` 0.1.0 (MIT).

Ce n'est pas un client Bitnob. C'est un client HTTP typé de l'API jaaykat (22 méthodes : `auth`, `invoices`, `public`, `sales`, `dashboard`, `score`, `balance`, `payouts`, `health`, `rates`, `system`), avec validation zod des réponses. Il ne contient ni signature HMAC-SHA256, ni appel à `api.bitnob.com`, ni lecture de webhook HMAC-SHA512, ni facture Lightning, ni devis, initialisation ou finalisation de retrait. Il ne peut donc pas remplacer `src/bitnob/live.ts`.

Usage possible : couche d'appel de `jaaykat-web`, à la place de `src/lib/api.ts`. Son contrat était en retard sur l'API actuelle : attestation (`attestationId`, `issuedAt`, `period` en objet, `totalXof`, `demo`, `environment`), score (`demo`, `thresholds`, `remaining`), solde (`demoRevenueXof`, `demoSalesCount`) et moyen de paiement `yas`. Sur une API actuelle, `public.pay("yas")` et `public.attestation()` échouent en `UNEXPECTED`. Un correctif est préparé sur une branche locale `jk-contract-sync` (69 tests verts) et n'est pas poussé sur le dépôt de Dar-rius.

## bitnob-lite (le SDK Bitnob)

Extrait de l'ancien `src/bitnob/live.ts` : signature HMAC-SHA256, requêtes avec reprises (GET, HEAD et création de facture Lightning par `reference` seulement), factures avec `auto_settle` et relecture, clients, soldes, taux, retraits (devis, `initialize` et `finalize` par `quote_id`), `quoteForSettlement` (nouveau devis avec `ceil`), vérification de webhook HMAC-SHA512 (`x-bitnob-signature`), erreurs typées. Le paquet ne contient ni secret ni référence à ce projet.

État : `bitnob-lite` 0.1.0 est publié sur npm (https://www.npmjs.com/package/bitnob-lite, tag `v0.1.0` sur `Silanoa/bitnob-lite`). `package.json` dépend de `"bitnob-lite": "^0.1.0"`, résolu depuis le registre dans `pnpm-lock.yaml`.

Ce qui reste dans l'API : `factory.ts` (mode mock ou live), `mock.ts`, `journal.ts` (journal `api_calls` branché sur `onRequest`), `environment.ts` (lecture de `whoami`) et `setDefaultResultOrder("ipv4first")` dans `live.ts` : Bitnob autorise les IP en IPv4 et le paquet n'impose pas ce réglage. Le re-devis du retrait passe par `quoteForSettlement`.

Les tests `test/live-client.test.ts` et `test/live-payouts.test.ts` restent dans l'API et passent contre le paquet ; les tests du paquet sont dans son dépôt.

`BITNOB_MODE=mock` utilise `MockBitnobClient` pour les tests et la CI. `BITNOB_MODE=live` utilise le client de la factory. Les secrets restent dans `.env`.
