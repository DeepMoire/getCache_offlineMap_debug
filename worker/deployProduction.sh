#!/usr/bin/env bash
#
# ⚠️ The ONLY sanctioned way to deploy to prod — `wrangler deploy` alone has no confirmation and can hit tiles-prod.getcache.org by muscle memory. Don't remove or auto-answer this prompt.
#
# --yes is the deliberate opt-out for non-interactive callers (no TTY, e.g. Claude Code's `!` prefix) — don't auto-answer via `echo deploy |` instead, that bypasses the guard invisibly.
#
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

npx wrangler deploy
