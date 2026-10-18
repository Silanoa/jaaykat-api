# Client Bitnob : état des paquets

Le client signé de ce dépôt est `src/bitnob/live.ts`. Aucun paquet ne le remplace aujourd'hui.

## jaakat-client (Dar-rius), analysé le 2026-10-18

Dépôt `https://github.com/Dar-rius/jaakat-client`, commit `ac7b1ae`, paquet `jaaykat-client` 0.1.0 (MIT).

Ce n'est pas un client Bitnob. C'est un client HTTP typé de l'API jaaykat (22 méthodes : `auth`, `invoices`, `public`, `sales`, `dashboard`, `score`, `balance`, `payouts`, `health`, `rates`, `system`), avec validation zod des réponses. Il ne contient ni signature HMAC-SHA256, ni appel à `api.bitnob.com`, ni lecture de webhook HMAC-SHA512, ni facture Lightning, ni devis, initialisation ou finalisation de retrait. Il ne peut donc pas remplacer `src/bitnob/live.ts`.

Usage possible : couche d'appel de `jaaykat-web`, à la place de `src/lib/api.ts`. Son contrat était en retard sur l'API actuelle : attestation (`attestationId`, `issuedAt`, `period` en objet, `totalXof`, `demo`, `environment`), score (`demo`, `thresholds`, `remaining`), solde (`demoRevenueXof`, `demoSalesCount`) et moyen de paiement `yas`. Sur une API actuelle, `public.pay("yas")` et `public.attestation()` échouent en `UNEXPECTED`. Un correctif est préparé sur une branche locale `jk-contract-sync` (69 tests verts) et n'est pas poussé sur le dépôt de Dar-rius.

## @silanoa/bitnob-lite

Pas branché. Si le paquet est un jour utilisé, le seul fichier à changer est `src/bitnob/factory.ts` :

```ts
import { BitnobClient as LiveBitnobClient } from "@silanoa/bitnob-lite";
```

Le constructeur attendu est `new BitnobClient({ clientId, clientSecret, baseUrl, onRequest })`. Avant de le brancher, rejouer `test/live-client.test.ts` et `test/live-payouts.test.ts` contre lui : ils fixent la signature, les reprises (GET et création de facture par `reference` seulement), le `quote_id` des retraits et le bénéficiaire complet.

`BITNOB_MODE=mock` utilise `MockBitnobClient` pour les tests et la CI. `BITNOB_MODE=live` utilise le client de la factory. Les secrets restent dans `.env`.
