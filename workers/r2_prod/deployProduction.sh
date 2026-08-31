#!/usr/bin/env bash
# ⚠️ the ONLY sanctioned prod deploy — bare `wrangler deploy` has no confirmation; don't remove or auto-answer this prompt.
# ⚠️ --yes is the opt-out for no-TTY callers — never `echo deploy |` it, that bypasses the guard invisibly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ASSUME_YES=0
for arg in "$@"; do
	case "$arg" in
	--yes | -y)
		ASSUME_YES=1
		;;
	*)
		echo "Unknown argument: $arg" >&2
		echo "Usage: ./deployProduction.sh [--yes]" >&2
		exit 2
		;;
	esac
done

echo "This deploys workers/offline-tiles to PRODUCTION:"
echo "  tiles-prod.getcache.org — every shipped phone, right now."
echo

if [ "$ASSUME_YES" -eq 1 ]; then
	echo "--yes given — skipping the confirmation prompt."
else
	# ⚠️ NO TTY, NO GUESS — without this check, EOF on `read` under `set -e` looks like a clean abort, not a failed prompt.
	if [ ! -t 0 ]; then
		echo "Refusing to deploy: no terminal to read the confirmation from." >&2
		echo "Run this in a real terminal, or pass --yes to skip the prompt." >&2
		exit 1
	fi
	read -r -p "Type 'deploy' to continue: " confirm
	if [ "$confirm" != "deploy" ]; then
		echo "Aborted — nothing deployed."
		exit 1
	fi
fi

# THIS FOLDER IS THE RECORD OF WHAT tiles-prod IS RUNNING. Code is edited in
# ../local_dev only; the sync runs AFTER the confirmation so an aborted deploy
# leaves the folder still matching the cloud. Replace, never merge.
rm -rf src
(cd ../local_dev && find src -type d) | while read -r d; do mkdir -p "$d"; done
for f in $(cd ../local_dev && find src -type f) wrangler.toml package.json package-lock.json tsconfig.json .gitignore; do
	cp "../local_dev/$f" "$f"
done

[ -d node_modules ] || npm install --no-audit --no-fund

npx wrangler deploy
