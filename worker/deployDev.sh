#!/usr/bin/env bash
#
# Deploy this Worker to r2_dev — https://tiles-dev.getcache.org
#
# ⛔ NO CONFIRMATION PROMPT, ON PURPOSE — nothing reaches a shipped phone from here (r2_dev is unreachable from any Capacitor build); breaking this Worker is the intended use.
#
# scope the CLOUDFLARE_API_TOKEN to THIS Worker only — that's what makes deployProduction.sh fail at Cloudflare's edge for a contractor, not people remembering which script is which.
#
# same R2 bucket as production — a difference between the two Workers is always CODE, never data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Deploying to r2_dev — https://tiles-dev.getcache.org"
echo "(no shipped phone can read this Worker; r2_prod is untouched)"
echo

npx wrangler deploy --env dev
