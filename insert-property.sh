#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# LIVE DEMO: insert a NEW PROPERTY into Atlas and prove it's immediately
# searchable via Atlas Vector Search (auto-embedding on write).
#
#   ./insert-property.sh                          # uses demo defaults
#   ./insert-property.sh --name "Harbour East" --region "Kowloon East"
#
# Any --flag is passed straight through to scripts/demo/insert-property.ts.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
exec ./node_modules/.bin/tsx scripts/demo/insert-property.ts "$@"
