#!/usr/bin/env bash
# ⛔ NO CONFIRMATION PROMPT, ON PURPOSE — r2_dev is unreachable from any shipped phone.
# ⚠️ scope CLOUDFLARE_API_TOKEN to THIS Worker only — that is what makes deployProduction.sh fail for a contractor.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Deploying to r2_dev — https://tiles-dev.getcache.org"
echo "(no shipped phone can read this Worker; r2_prod is untouched)"
echo

npx wrangler deploy --env dev
