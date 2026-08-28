#!/usr/bin/env bash
#
# Deploy this Worker to r2_dev — https://tiles-dev.getcache.org
#
# ⛔ NO CONFIRMATION PROMPT, ON PURPOSE. `deployProduction.sh` asks before it
# runs because a mistake there reaches every shipped phone. Nothing reaches a
# phone from here: no App Store build can even select r2_dev (the CONFIG
# toggle is behind `import.meta.env.DEV`, a compile-time constant, so the
# branch is dropped from any Capacitor build). Breaking this Worker is the
# INTENDED use of it. Friction on a sandbox teaches people to skip friction
# everywhere, which is how a prod guard gets worn down.
#
# ── FOR A CONTRACTOR ─────────────────────────────────────────────────────
#
# This is the ONLY deploy command an outside developer should ever need.
#
#   1. They need a Cloudflare API token, set as CLOUDFLARE_API_TOKEN in their
#      shell (or `npx wrangler login` if they have their own account seat).
#   2. Scope that token to THIS Worker. Then `deployProduction.sh` fails for
#      them at Cloudflare's edge — the separation is enforced by the token,
#      not by everyone remembering which script is which.
#   3. They deploy here, flip the CONFIG panel to r2_dev, and see their change
#      against the real R2 data with no way to touch what users read.
#
# Same R2 bucket as production, so a difference between the two Workers is
# always CODE and never data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Deploying to r2_dev — https://tiles-dev.getcache.org"
echo "(no shipped phone can read this Worker; r2_prod is untouched)"
echo

npx wrangler deploy --env dev
