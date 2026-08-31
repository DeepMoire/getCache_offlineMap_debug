#!/usr/bin/env bash
# ⛔ NO CONFIRMATION PROMPT, ON PURPOSE — r2_dev is unreachable from any shipped phone.
# ⚠️ scope CLOUDFLARE_API_TOKEN to THIS Worker only — that is what makes deployProduction.sh fail for a contractor.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# THIS FOLDER IS THE RECORD OF WHAT tiles-dev IS RUNNING. Code is edited in
# ../local_dev only; the sync below runs as part of every deploy, so this copy
# can only differ from the cloud when a deploy has not happened yet — which is
# exactly what the folder exists to show. Replace, never merge: a stale file
# surviving a sync resolves on one box and nowhere else.
rm -rf src
(cd ../local_dev && find src -type d) | while read -r d; do mkdir -p "$d"; done
for f in $(cd ../local_dev && find src -type f) wrangler.toml package.json package-lock.json tsconfig.json .gitignore; do
	cp "../local_dev/$f" "$f"
done

[ -d node_modules ] || npm install --no-audit --no-fund

echo "Deploying to r2_dev — https://tiles-dev.getcache.org"
echo "(no shipped phone can read this Worker; r2_prod is untouched)"
echo

npx wrangler deploy --env dev
