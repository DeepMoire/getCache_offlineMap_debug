#!/usr/bin/env bash
# Populate static/mobileAssets/ for this child's demo.
# See ASSETS.md. Fails loud — no silent fallbacks.
set -euo pipefail

DEST="${1:-static/mobileAssets}"
NEEDED=(worldBase getcache_DT_bg.webp pin_library_small hand_phoneV3.webp)

# Candidates derive from THIS SCRIPT's location — never from the caller's
# working directory, never from a home directory. Two things were wrong before:
#
#   "../../../../../../static/mobileAssets"  was relative to $PWD, not to this
#       file, so what it resolved to depended entirely on where you stood. It is
#       also a relic of the layout where children lived under rapper/src/lib/.
#   "$HOME/DEV/fetch/ReTreever/static/mobileAssets"  exists on one machine.
#
# ReTreever and this child are FLAT SIBLINGS in the same parent folder, which
# holds both in the fetch workspace and in anything `npm create` scaffolds — so
# ReTreever is one level up and across from here.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# RETREEVER_ASSETS is FIRST. It used to be checked LAST, so an explicit override
# was only consulted after the guesses had already failed — the opposite of what
# an override is for.
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
    # The repo ships these paths as symlinks into a ReTreever checkout. In a
    # bare clone they DANGLE, and `cp -R` onto a dangling symlink fails with
    # "Not a directory". Clear whatever is there (dead link or stale copy)
    # first. SvelteKit walks static/ at build time and dies on a dangling
    # link, so this is what makes a fresh clone buildable at all.
    unlink "$DEST/$n" 2>/dev/null || true
    cp -R "$guess/$n" "$DEST/"
    echo "  ✓ $n"
  done
  echo "Done. Assets are in $DEST"
  exit 0
done

echo "ERROR: could not find the mobileAssets source." >&2
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
echo "  - ask Ground Truth Data for the asset bundle." >&2
echo "" >&2
echo "See ASSETS.md." >&2
exit 1
