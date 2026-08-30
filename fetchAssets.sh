#!/usr/bin/env bash
# Populate static/mobileAssets/ for this child's demo.
# See ASSETS.md. Fails loud — no silent fallbacks.
set -euo pipefail

DEST="${1:-static/mobileAssets}"
NEEDED=(worldBase getcache_DT_bg.webp pin_library_small hand_phoneV3.webp fire_icon.webp fire_intensity)

# ⚠️ HERE must derive from this script's location — never the caller's cwd or a home directory.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ⚠️ RETREEVER_ASSETS must be checked FIRST, or the override is only consulted after the guesses already failed.
CANDIDATES=(
  "${RETREEVER_ASSETS:-}"
  "$HERE/../ReTreever/static/mobileAssets"
  "$HERE/../../ReTreever/static/mobileAssets"
)

tried=()
for guess in "${CANDIDATES[@]}"; do
  [ -n "$guess" ] || continue
  tried+=("$guess")
  [ -d "$guess" ] || continue
  ok=1
  for n in "${NEEDED[@]}"; do [ -e "$guess/$n" ] || ok=0; done
  [ "$ok" = 1 ] || continue
  mkdir -p "$DEST"
  echo "Copying assets from $guess"
  for n in "${NEEDED[@]}"; do
    # ⚠️ clear dangling symlinks first — cp -R onto one fails, and SvelteKit dies on a dangling link at build time.
    unlink "$DEST/$n" 2>/dev/null || true
    cp -R "$guess/$n" "$DEST/"
    echo "  ✓ $n"
  done
  echo "Done. Assets are in $DEST"
  exit 0
done

# no local ReTreever — pull the public bundle (a GitHub release on this repo)
ASSETS_URL="${ASSETS_URL:-https://github.com/Ground-Truth-Data/getCache_offlineMap/releases/download/assets-v1/mobileAssets.tar.gz}"
echo "No local asset source — downloading $ASSETS_URL"
mkdir -p "$DEST"
if curl -fsSL "$ASSETS_URL" | tar -xz -C "$DEST"; then
  for n in "${NEEDED[@]}"; do [ -e "$DEST/$n" ] || { echo "ERROR: bundle is missing $n" >&2; exit 1; }; echo "  ✓ $n"; done
  echo "Done. Assets are in $DEST"
  exit 0
fi

echo "ERROR: could not find or download the mobileAssets source." >&2
echo "" >&2
echo "This child needs ~50 MB of basemap assets that are not in git." >&2
echo "Looked in (in order):" >&2
for t in "${tried[@]}"; do
  if [ -d "$t" ]; then
    echo "  - $t   (exists, but is missing one of: ${NEEDED[*]})" >&2
  else
    echo "  - $t   (no such directory)" >&2
  fi
done
echo "" >&2
echo "Either:" >&2
echo "  - set RETREEVER_ASSETS=/path/to/ReTreever/static/mobileAssets, or" >&2
echo "  - set ASSETS_URL to a reachable copy of the bundle, or ask Ground Truth Data for it." >&2
echo "" >&2
echo "See ASSETS.md." >&2
exit 1
