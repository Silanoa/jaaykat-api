# Brancher `@silanoa/bitnob-lite`

Le client signé de ce dépôt est `src/bitnob/live.ts`. Le seul fichier à changer pour le remplacer par le package est `src/bitnob/factory.ts`.

## Avant publication

```json
"@silanoa/bitnob-lite": "file:../bitnob-lite"
```

Dans `src/bitnob/factory.ts`, remplacer l'import local par :

```ts
import { BitnobClient as LiveBitnobClient } from "@silanoa/bitnob-lite";
```

Le constructeur attendu est `new BitnobClient({ clientId, clientSecret, baseUrl, onRequest })`. Le reste de `createBitnobClient` ne change pas.

## Après `npm publish`

```json
"@silanoa/bitnob-lite": "0.1.0"
```

Même diff d'import. Ne pas copier le SDK dans ce dépôt.

`BITNOB_MODE=mock` continue d'utiliser `MockBitnobClient` pour les tests et la CI. `BITNOB_MODE=live` utilise le client branché dans la factory. Les secrets restent dans `.env`.
