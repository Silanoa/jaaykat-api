# jaaykat-api Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. REQUIRED: superpowers:test-driven-development for métier (auth, invoices, score, webhooks).

**Goal:** API Fastify + SQLite qui encaisses Lightning via bitnob-lite, sert la PWA, prêt démo tunnel.

**Architecture:** Même origine HTTPS ; Bitnob uniquement serveur ; vérité statut = GET Bitnob ; métier en SQLite.

**Tech Stack:** Node 22, Fastify 5, better-sqlite3, zod, `@silanoa/bitnob-lite`

## Global Constraints

- Secrets uniquement `.env` (jamais `VITE_*`)
- Jamais `paid`/`completed` sans GET Bitnob
- IP Bitnob = laptop whitelist
- Idempotency-Key 10 min ; `reference` stable pour retries
- SDK : ne pas réimplémenter HMAC — attendre / mocker bitnob-lite
- Pas de commentaires filler

---

### Task 1: DB + migrations

**Files:** `src/db/*` — tables users, sessions, merchants, invoices, … (design §6/§9)

- [ ] Schéma + migrations
- [ ] Tests smoke insert/select
- [ ] Commit

### Task 2: Auth (PIN + sessions)

**Files:** `src/auth/*`

- [ ] Tests scrypt, lock 5 échecs, Bearer
- [ ] register/login/me/logout (register peut mocker customers.create)
- [ ] Commit

### Task 3: Rates + invoices

**Files:** `src/modules/rates`, `src/modules/invoices`

- [ ] Conversion XOF→sats figée
- [ ] POST/GET invoices + Idempotency-Key
- [ ] Poll/reconcile → paid seulement après GET Bitnob
- [ ] Checkpoint 20h00 jouable avec tunnel
- [ ] Commit

### Task 4: Public + static PWA

**Files:** routes public, `@fastify/static`

- [ ] `/api/public/*`, servir `public/`
- [ ] Commit

### Task 5: Webhooks

**Files:** `src/webhooks.ts`

- [ ] Raw body + HMAC-SHA512 + dedupe + GET confirm
- [ ] Commit

### Task 6: Dashboard + score + seed

**Files:** analytics, score, `seed.ts`

- [ ] Formules design §7 — tests unitaires
- [ ] Seed 60 j `source=seed`
- [ ] Commit

### Task 7: Payouts

**Files:** `src/modules/payouts`

- [ ] quote → initialize/finalize → poll
- [ ] Ledger : seed non retirable
- [ ] Commit

### Task 8: Harden + docs

- [ ] rate-limit, scrub logs, `/api/system`
- [ ] README final, Dockerfile, gitleaks
- [ ] Branchement SDK npm `0.1.0` quand publié
- [ ] Tag `v1.0-demo`

## Sync SDK

| Quand | Action |
|-------|--------|
| M1 bitnob-lite | Brancher createInvoice/getInvoice |
| M2 | Brancher webhooks helpers |
| M3 | Brancher payouts |
| M4 npm | Remplacer `file:` par `0.1.0` |

Design : `docs/superpowers/specs/2026-10-17-jaaykat-api-design.md`
