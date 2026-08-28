#!/usr/bin/env bash
#
# GIVE A CONTRACTOR A WORKING MAP WITH NO CLOUDFLARE ACCOUNT, NO API TOKEN,
# AND NO SECRET FROM US.
#
# `npm run dev:local` runs this and then starts the Worker. That is the whole
# onboarding: clone, npm install, npm run dev:local. Nothing to ask Chris for.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────
#
# The local tier could not serve a single tile. MEASURED 27 Aug 2026: the
# checked-in planet.pmtiles was a 0-BYTE PLACEHOLDER, and .gitignore line 2 is
# `*.pmtiles` — so the local tier was never ABLE to carry its own data. The
# workaround was `wrangler dev --remote`, which reads the real R2 bucket and
# therefore needs OUR Cloudflare credentials. That is the entire reason an
# outside developer was blocked, and it was never a permissions decision — it
# was an empty file.
#
# This script gives the local tier its own data, so `--remote` is no longer
# the only way to see a map. deployDev.sh used to say a Cloudflare API token
# was "the ONLY deploy command an outside developer should ever need"; that
# sentence is now wrong on purpose.
#
# ── WHY NO KEY IS HANDED OUT ─────────────────────────────────────────────
#
# Because there is nothing here worth keying. The sample basemap below is
# Protomaps' own public ODbL demo extract — public data, not ours. And the
# production hostname is already committed in a PUBLIC GitHub repo
# (getCache_offlineMap), so a "secret" URL would be secret from nobody.
#
# Rate limiting on the Cloudflare side is the real control for abuse of the
# deployed Worker. A shared credential would add rotation work and protect
# nothing.
#
# ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
#
# Not the planet. It is one city, ~6 MB, enough to render a real map and
# develop against. Anyone who needs planet-scale data still needs R2 — that is
# a genuine infrastructure cost, not an onboarding step.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Protomaps' public ODbL sample extract (Firenze). Public data, no auth.
# Verified 27 Aug 2026: HTTP 206 on a range probe, 6.3 MB, magic bytes
# "PMTiles". If this URL ever dies, ANY .pmtiles works — see README.
SAMPLE_URL="https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles"
SAMPLE_FILE="sampleBasemap.pmtiles"

# Must match PMTILES_KEY / PACK_PMTILES_KEY in wrangler.toml — the Worker
# looks the archive up by this key, so a mismatch reads as "no tiles" with no
# error. Kept in one variable so it cannot drift silently.
OBJECT_KEY="planet.pmtiles"
BUCKET="offline-tiles"

if [ ! -f "$SAMPLE_FILE" ]; then
	echo "Downloading sample basemap (~6 MB, public ODbL data, no account needed)…"
	curl -fSL --retry 3 -o "$SAMPLE_FILE" "$SAMPLE_URL"
else
	echo "Sample basemap already present — skipping download."
fi

# FAIL LOUD ON A FILE THAT IS NOT A PMTILES ARCHIVE. A 404 page saved to disk
# is still a "successful" download to curl -L, and it produced a 27 KB HTML
# file on the first attempt at this (MEASURED). Without this check that file
# would load into R2 and the map would come back blank with no explanation —
# the exact silent failure this whole script exists to remove.
if [ "$(head -c 7 "$SAMPLE_FILE")" != "PMTiles" ]; then
	echo "❌ $SAMPLE_FILE is not a PMTiles archive (wrong magic bytes)." >&2
	echo "   The download probably returned an error page. Delete it and retry:" >&2
	echo "   rm $SAMPLE_FILE && npm run dev:local" >&2
	exit 1
fi

echo "Loading into the LOCAL R2 simulator (.wrangler/state — never the cloud)…"
npx wrangler r2 object put "$BUCKET/$OBJECT_KEY" --file "$SAMPLE_FILE" --local

echo
echo "✅ Local tiles ready. No Cloudflare account, no API token, no secret."
echo "   Worker:  http://127.0.0.1:8787"
echo "   In the app's CONFIG panel, pick local_dev."
