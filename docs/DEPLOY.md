# Stratégie de déploiement — démo dimanche 15h

## Décision (hackathon)

| Quoi | Où | Pourquoi |
|------|----|----------|
| Backend + PWA | **Laptop** + tunnel `cloudflared` | Seule IP whitelist Bitnob = laptop |
| SDK | **npm** public `@silanoa/bitnob-lite` (confirmer scope npm) | Livrable open source jury |
| Code | **GitHub** public (3 repos) | Soumission codeandchain.xyz |
| Railway | **Pas pendant le hackathon** | IP fixe = plan Pro (test R1 après soumission) |

## Architecture runtime démo

```
Téléphone A (PWA installée) ──┐
Téléphone B (navigateur /p/) ─┼── HTTPS https://<nom>.trycloudflare.com
Bitnob webhooks ──────────────┘              │
                                             ▼
                              Laptop : jaaykat-api :3000
                              ├─ /api/*  /webhooks/bitnob
                              └─ sert jaaykat-web/dist (statique)
                                             │ HMAC sortant
                                             ▼
                                    api.bitnob.com (sandbox)
                                    depuis IP 41.214.74.162
```

## Checklist laptop (avant démo)

```powershell
# 1. IP whitelist
curl -4 https://api.ipify.org
# doit afficher 41.214.74.162 — sinon WARP/VPN OFF + maj dashboard Bitnob

# 2. Build chaîne
cd bitnob-lite && pnpm install && pnpm test && pnpm build
# (après publish) ou file: link local
cd ../jaaykat-web && pnpm install && pnpm build
cd ../jaaykat-api
# copier le dist web dans public/
# Copy-Item -Recurse ..\jaaykat-web\dist\* .\public\
pnpm install && pnpm build
node --env-file=.env dist/server.js

# 3. Tunnel (laisser tourner)
cloudflared tunnel --url http://localhost:3000
# noter https://XXXX.trycloudflare.com

# 4. Reporter l'URL aux 4 endroits
# - PUBLIC_URL dans .env (redémarrer API)
# - DEMO_PAY_MODE=manual si le client doit scanner le QR puis choisir Wave/Orange/Yas/Expresso
#   (auto, défaut : la facture Bitnob est créée tout de suite, auto_settle)
# - Webhook Bitnob dashboard → .../webhooks/bitnob
# - Réinstaller PWA téléphone A depuis cette URL
# - Régénérer / imprimer affiche A6 QR
```

## Publication SDK (collègue, bloc 5 ~06h30–09h00)

```bash
npm login   # 2FA auth-and-writes
cd bitnob-lite
npm pack --dry-run   # pas de .env, pas de secrets
npm publish --access public
# puis dans jaaykat-api : remplacer file: par @silanoa/bitnob-lite@0.1.0
```

## Ordre GitHub / soumission

1. Push des 3 repos publics + LICENSE MIT + `.env.example` sans valeurs.
2. `gitleaks git .` sur chaque repo avant push final.
3. Tag `v1.0-demo` sur `jaaykat-api` et `jaaykat-web` (et `v0.1.0` npm pour SDK).
4. Soumission codeandchain.xyz : lien repo principal (README workspace ou api), URL démo tunnel, vidéo.

## Repo principal pour le jury

Mettre un README « hub » dans `jaaykat-api` (ou un 4e repo `jaaykat` docs-only) qui pointe vers les 3 repos + démo. **Recommandation** : README de `jaaykat-api` = point d’entrée soumission (architecture complète + liens SDK + Web).

## Fallback si tunnel tombe pendant le pitch

1. Relancer `cloudflared` → nouvelle URL.
2. MAJ `PUBLIC_URL` + webhook Bitnob.
3. Sur téléphone A : ouvrir la nouvelle URL (réinstaller PWA si besoin).
4. Affiche A6 : avoir un QR de secours généré 30 min avant, ou montrer E08 à l’écran.

## Après soumission (optionnel R1)

Railway Pro + Static Outbound IPs → 3 IP en /32 dans Bitnob → Dockerfile déjà dans `jaaykat-api`.
