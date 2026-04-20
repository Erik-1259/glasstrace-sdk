#!/usr/bin/env bash
#
# Verifies `@glasstrace/sdk/node` resolves cleanly under both ESM and CJS.
#
# Runs from packages/sdk/ at the `postbuild` hook so a broken exports-map
# or a missing `dist/node-subpath.*` artifact fails CI instead of shipping
# to npm.
#
set -euo pipefail

cd "$(dirname "$0")/.."

node -e "import('@glasstrace/sdk/node').then(m => {
  if (Object.keys(m).length === 0) { process.exit(1); }
}).catch(e => { console.error('[verify-subpath] ESM resolution failed:', e.message); process.exit(1); })"

node -e "const m = require('@glasstrace/sdk/node');
if (Object.keys(m).length === 0) { process.exit(1); }"

echo "[verify-subpath] @glasstrace/sdk/node resolves under ESM and CJS"
