#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# LIVE DEMO: add/update PETER CHAN's duty-roster assignment in Atlas and prove
# it's immediately retrievable via Atlas Vector Search (auto-embedding on
# every insert/update).
#
#   ./insert-peter.sh                             # uses demo defaults
#   ./insert-peter.sh --property "Harbour East" --role "Night Duty Manager"
#
# Any --flag is passed straight through to scripts/demo/insert-peter.ts.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
exec ./node_modules/.bin/tsx scripts/demo/insert-peter.ts "$@"
