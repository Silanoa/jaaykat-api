#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="${JAAYKAT_WEB_DIR:-$ROOT/../jaaykat-web}"
DEST="${1:-$ROOT/public}"
if [[ -f "$WEB/scripts/sync-web.sh" ]]; then
  bash "$WEB/scripts/sync-web.sh" "$DEST"
  exit 0
fi
if [[ -d "$WEB/dist" ]]; then
  mkdir -p "$DEST"
  find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$WEB/dist/." "$DEST/"
  printf 'dist copié vers %s\n' "$DEST"
  exit 0
fi
printf 'jaaykat-web introuvable (%s). Classez le dépôt à côté de jaaykat-api, ou passez JAAYKAT_WEB_DIR.\n' "$WEB" >&2
exit 1
