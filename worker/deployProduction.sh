#!/usr/bin/env bash
#
# The ONLY sanctioned way to push this Worker to tiles-prod.getcache.org — the
# hostname every shipped phone talks to. `wrangler deploy` run bare does the
# same thing with NO confirmation; this script exists so that a moment of
# "just testing locally" muscle memory can't accidentally reach production.
#
# Chris's ruling, 24 Aug 2026: a separate cloud staging Worker was
# considered and dropped (see tilesHost.ts "TWO TIERS" note) — this typed
# confirmation is where the friction against an accidental prod push
# actually lives now. Don't remove or auto-answer this prompt.
#
# ── --yes, ADDED 27 Aug 2026 ─────────────────────────────────────────────
#
# The prompt above is STILL the default and still the thing that catches
# muscle memory. What changed is that it had no escape hatch, and there is a
# caller that genuinely cannot answer it: Claude Code's `!` prefix runs
# commands with NO TTY, so `read` gets EOF, the script aborts, and the deploy
# silently does not happen. MEASURED three times in a row on 27 Aug — each
# attempt printed the banner and exited without deploying, while the fix sat
# ready on disk and production kept serving the old build.
#
# `--yes` is the DELIBERATE opt-out: it is a flag you have to type, so it
# cannot be reached by the muscle memory this guard exists to stop. Piping
# `echo deploy |` would have worked too, but that AUTO-ANSWERS the prompt —
# exactly what the note above forbids — and it does so invisibly. A named
# flag says out loud that the human chose to skip the question.
#
# Same shape as the web side's `deploy.sh --yes`, so there is one convention.
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
	# NO TTY, NO GUESS. Without this the script hits EOF on `read` and, under
	# `set -e`, exits looking like a clean abort — which reads as "I ran the
	# deploy and nothing happened" rather than "nothing could be typed".
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
