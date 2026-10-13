#!/usr/bin/env bash
# Mutation check for the uncertain-receipt safeguard: serve a copy of the app
# with the per-worker block removed and REQUIRE the recovery test to catch the
# duplicate. Exits 0 only when the mutant is caught. Disposable database only.
#   test_d3/env.sh up && test_d3/mutation_receipt_guard.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
MUT="$(mktemp -d)"; trap 'rm -rf -- "${MUT:?}"' EXIT
cp "$ROOT"/*.html "$ROOT"/*.js "$ROOT"/*.json "$MUT"/
sed -i -e 's/    if (rcvBlocked(emp)) return;//' -e 's/if (rcvBusy || rcvBlocked(emp)) return;/if (rcvBusy) return;/' "$MUT/d3-hisab.js"
if cmp -s "$ROOT/d3-hisab.js" "$MUT/d3-hisab.js" || grep -qE '(if \(|\|\| )rcvBlocked\(emp\)' "$MUT/d3-hisab.js"; then echo "mutation not applied"; exit 2; fi
OUT="$(APP_DIR="$MUT" node "$HERE/test_receipts_recovery_browser.js" 2>&1 || true)"
echo "$OUT" | grep -E '^FAIL' || true
if echo "$OUT" | grep -q '^FAIL 1c'; then echo "mutant caught: without the block a second -14,000 is written"; exit 0; fi
echo "MUTANT SURVIVED"; exit 1
