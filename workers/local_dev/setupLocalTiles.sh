#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# CANADIAN sample, extracted from the Protomaps daily planet build (ODbL, no auth).
# The old seed was a Firenze city sample — every North American pin came back with
# empty roads while satellite (worldwide) worked, which read as "the map is broken".
# The bbox covers the northern-BC test area (?at=58.7986,-122.6761).
BBOX="-126.0,57.0,-120.0,60.0"
SAMPLE_FILE="sampleBasemap.pmtiles"

# ⚠️ must match PMTILES_KEY / PACK_PMTILES_KEY in wrangler.toml — a mismatch silently reads as "no tiles", no error.
OBJECT_KEY="planet.pmtiles"
BUCKET="offline-tiles"

# go-pmtiles CLI (single static binary) — needed once, only to extract the sample.
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
		*) echo "❌ unsupported OS for the extract step — put any .pmtiles file at $SAMPLE_FILE yourself (see README)." >&2; exit 1 ;;
	esac
	case "$(uname -m)" in
		arm64 | aarch64) arch="arm64" ;;
		x86_64) arch="x86_64" ;;
		*) echo "❌ unsupported CPU for the extract step — put any .pmtiles file at $SAMPLE_FILE yourself (see README)." >&2; exit 1 ;;
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

if [ ! -f "$SAMPLE_FILE" ]; then
	fetch_pmtiles_cli
	BUILD_URL=$(latest_build_url) || {
		echo "❌ could not find a Protomaps daily build (network?). Retry, or put any .pmtiles at $SAMPLE_FILE (see README)." >&2
		exit 1
	}
	echo "Extracting the Canadian sample from ${BUILD_URL} (bbox ${BBOX})…"
	echo "One-time, a few minutes — it reads only the slice it needs, never the whole planet."
	"$PMT_BIN" extract "$BUILD_URL" "$SAMPLE_FILE" --bbox="$BBOX"
else
	echo "Sample basemap already present — skipping extract."
fi

# ⚠️ fail loud on a non-PMTiles file — a bad extract must not silently load into R2 as a blank map.
if [ "$(head -c 7 "$SAMPLE_FILE")" != "PMTiles" ]; then
	echo "❌ $SAMPLE_FILE is not a PMTiles archive (wrong magic bytes)." >&2
	echo "   Delete it and retry:" >&2
	echo "   rm $SAMPLE_FILE && npm run dev:local" >&2
	exit 1
fi

echo "Loading into the LOCAL R2 simulator (.wrangler/state — never the cloud)…"
npx wrangler r2 object put "$BUCKET/$OBJECT_KEY" --file "$SAMPLE_FILE" --local

echo
echo "✅ Local tiles ready (northern BC sample). No Cloudflare account, no API token, no secret."
echo "   Worker:  http://127.0.0.1:8787"
echo "   In the app's CONFIG panel, pick local_dev."
