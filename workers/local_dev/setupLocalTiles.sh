#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Protomaps public ODbL sample (Firenze), no auth needed — if this URL ever dies, any .pmtiles file works, see README.
# one city (~6 MB) — not the planet; planet-scale data still needs R2.
SAMPLE_URL="https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles"
SAMPLE_FILE="sampleBasemap.pmtiles"

# ⚠️ must match PMTILES_KEY / PACK_PMTILES_KEY in wrangler.toml — a mismatch silently reads as "no tiles", no error.
OBJECT_KEY="planet.pmtiles"
BUCKET="offline-tiles"

if [ ! -f "$SAMPLE_FILE" ]; then
	echo "Downloading sample basemap (~6 MB, public ODbL data, no account needed)…"
	curl -fSL --retry 3 -o "$SAMPLE_FILE" "$SAMPLE_URL"
else
	echo "Sample basemap already present — skipping download."
fi

# ⚠️ fail loud on a non-PMTiles file — curl -L "succeeds" on a 404 HTML page too, and that silently loads into R2 as a blank map.
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
