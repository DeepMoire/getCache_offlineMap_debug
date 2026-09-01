#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# CANADIAN samples, extracted from the Protomaps daily planet build (ODbL, no auth).
# ⚠️ A pin OUTSIDE every bbox gets a loud 422 from the Worker (index.ts bounds
# guard), never a silent empty pack. Two seeds have burned us by not covering
# where anyone actually tested: Firenze, then northern BC (57–60°N) while every
# fixture pin — Ottawa valley 45°N, Vancouver 49°N, Prince George 54°N — sat
# outside it and "the map looked broken".
# ⚠️ EVERY floor fixture pin in lib/OfflineMapPage.svelte PINS must fall inside
# one of these boxes. One "name|bbox" per line; the Worker reads them all
# (.dev.vars below). Testing elsewhere? Add or widen a box, restart — a sample
# re-extracts when its bbox changes.
#   sampleOttawa — Ottawa/Montreal corridor incl. the Ottawa-valley fixture pin
#   sampleWest   — Vancouver, Prince George, and the northern-BC test area (?at=58.7986,-122.6761)
SAMPLES="
sampleOttawa|-78.0,44.0,-72.5,46.5
sampleWest|-126.5,48.5,-119.5,60.5
"

BUCKET="offline-tiles"

# go-pmtiles CLI (single static binary) — needed once, only to extract the samples.
PMT_VERSION="1.31.2"
PMT_DIR=".pmtiles-cli"
PMT_BIN="$PMT_DIR/pmtiles"

fetch_pmtiles_cli() {
	[ -x "$PMT_BIN" ] && return 0
	mkdir -p "$PMT_DIR"
	local os arch asset
	case "$(uname -s)" in
		Darwin) os="Darwin" ;;
		Linux) os="Linux" ;;
		*) echo "❌ unsupported OS for the extract step — put any .pmtiles file at <sample>.pmtiles yourself (see README)." >&2; exit 1 ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch="arm64" ;;
		x86_64) arch="x86_64" ;;
		*) echo "❌ unsupported CPU for the extract step — put any .pmtiles file at <sample>.pmtiles yourself (see README)." >&2; exit 1 ;;
	esac
	echo "Fetching pmtiles CLI v${PMT_VERSION} (${os}/${arch}, one small binary, no account)…"
	# asset naming differs per OS: Darwin ships -NAME_….zip, Linux ships _NAME_….tar.gz
	if [ "$os" = "Darwin" ]; then
		asset="go-pmtiles-${PMT_VERSION}_${os}_${arch}.zip"
		curl -fSL --retry 3 -o "$PMT_DIR/$asset" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMT_VERSION}/${asset}"
		unzip -o -q "$PMT_DIR/$asset" -d "$PMT_DIR"
	else
		asset="go-pmtiles_${PMT_VERSION}_${os}_${arch}.tar.gz"
		curl -fSL --retry 3 -o "$PMT_DIR/$asset" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMT_VERSION}/${asset}"
		tar -xzf "$PMT_DIR/$asset" -C "$PMT_DIR"
	fi
	[ -x "$PMT_BIN" ] || { echo "❌ pmtiles binary missing after unpack." >&2; exit 1; }
}

# Daily builds are named YYYYMMDD.pmtiles with no listing endpoint — probe back from today (UTC).
latest_build_url() {
	local d url
	for i in 0 1 2 3 4 5; do
		d=$(date -u -v-"${i}"d +%Y%m%d 2>/dev/null || date -u -d "-${i} days" +%Y%m%d)
		url="https://build.protomaps.com/${d}.pmtiles"
		if curl -sfI "$url" >/dev/null; then
			echo "$url"
			return 0
		fi
	done
	return 1
}

# The pre-multi-sample era left a single sampleBasemap under the planet.pmtiles
# key (and a stray 0-byte planet.pmtiles on disk) — sweep so nothing stale answers.
if [ -f "sampleBasemap.pmtiles" ] || [ -f "planet.pmtiles" ]; then
	echo "Removing the old single-sample files (superseded by the samples below)…"
	rm -f sampleBasemap.pmtiles sampleBasemap.bbox planet.pmtiles
	npx wrangler r2 object delete "$BUCKET/planet.pmtiles" --local >/dev/null 2>&1 || true
fi

KEYS=""
for entry in $SAMPLES; do
	name="${entry%%|*}"
	bbox="${entry##*|}"
	file="${name}.pmtiles"
	marker="${name}.bbox"

	# Re-extract when the box changes — the sample on disk is only valid for the
	# bbox it was cut with.
	if [ -f "$file" ] && [ "$(cat "$marker" 2>/dev/null)" != "$bbox" ]; then
		echo "$name bbox changed ($(cat "$marker" 2>/dev/null || echo none) → $bbox) — re-extracting."
		rm -f "$file"
	fi

	if [ ! -f "$file" ]; then
		fetch_pmtiles_cli
		BUILD_URL=${BUILD_URL:-$(latest_build_url)} || {
			echo "❌ could not find a Protomaps daily build (network?). Retry, or put any .pmtiles at $file (see README)." >&2
			exit 1
		}
		echo "Extracting $name from ${BUILD_URL} (bbox ${bbox})…"
		echo "One-time, a few minutes — it reads only the slice it needs, never the whole planet."
		"$PMT_BIN" extract "$BUILD_URL" "$file" --bbox="$bbox"
		printf '%s' "$bbox" > "$marker"
	else
		echo "$name already present — skipping extract."
	fi

	# ⚠️ fail loud on a non-PMTiles file — a bad extract must not silently load into R2 as a blank map.
	if [ "$(head -c 7 "$file")" != "PMTiles" ]; then
		echo "❌ $file is not a PMTiles archive (wrong magic bytes)." >&2
		echo "   Delete it and retry:" >&2
		echo "   rm $file && npm run dev:local" >&2
		exit 1
	fi

	echo "Loading $name into the LOCAL R2 simulator (.wrangler/state — never the cloud)…"
	npx wrangler r2 object put "$BUCKET/$file" --file "$file" --local
	KEYS="${KEYS:+$KEYS,}$file"
done

# World hospitals pack (workers/bakeHospitals.mjs output) — /hospitals answers
# a loud 502 without it; tiles and packs are unaffected.
if [ -f "../hospitals-world.v1.pack" ]; then
	echo "Loading hospitals-world.v1.pack into the LOCAL R2 simulator…"
	npx wrangler r2 object put "$BUCKET/hospitals-world.v1.pack" --file ../hospitals-world.v1.pack --local
else
	echo "ℹ️ no ../hospitals-world.v1.pack — /hospitals will 502 locally (bake it with: node ../bakeHospitals.mjs)"
fi

# `wrangler dev` reads .dev.vars over wrangler.toml [vars] — so the keys the
# Worker serves are exactly the samples this run uploaded, defined once, here.
cat > .dev.vars <<EOF
# GENERATED by setupLocalTiles.sh — do not edit; add samples there instead.
PMTILES_KEY=$KEYS
PACK_PMTILES_KEY=$KEYS
EOF

echo
echo "✅ Local tiles ready ($KEYS). No Cloudflare account, no API token, no secret."
echo "   Worker:  http://127.0.0.1:8787"
echo "   In the app's CONFIG panel, pick worker-local-dev."
