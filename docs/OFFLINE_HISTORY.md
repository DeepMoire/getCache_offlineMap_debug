# Offline Map — History (the footnote)

The current offline map is the one and only live plan:
[`OFFLINE_PLAN.md`](./OFFLINE_PLAN.md). **Start there.** This file is the
deprecated record — the approaches we tried and **removed** — kept so nobody
re-walks a dead end. Nothing here is on disk or the source of truth for new work.

The 5 laws (constant presence · jagged frontier · no blink · colours are the
user's · RAM ≤ 150 MB) carried through every version and now live, in full, in
`OFFLINE_PLAN.md`. Only the *machinery* below changed.

---

## V2 — the baked 2-level image pyramid (`/lite`) — DELETED

V3 (one masked photo per area) superseded V2, and V2 has since been **removed
entirely** — no fallback. Its route (`/mobile/offlinev2/lite` + `preview`), its
folder (`src/lib/mobile/offlineV2/`), and its 15-test suite
(`tests/smoke/offline-lite.spec.ts`, `offline-blob.spec.ts`) are gone. Two
files survived *the V2 cull*, lifted out to **`src/lib/mobile/offlineShared/`**
because the live V3/V4 routes import them: `offlineBaseStyle.ts` (the dark
Natural Earth base) and `offlineColors.ts` (the user's road/water hexes).
(`offlineShared/` has since grown to 9 files — `dbCatalog`, `downloadGuard`,
`geo`, `idbRename`, `keyedIdbStore`, `offlineLaws.test` — those are newer, not
V2 survivors.) **`src/lib/mobile/offlineShared/` no longer exists as of
2026-08-23** — the engine was carved into the child at `getCache_OfflineMap/lib/`; the two survivors
now live at `getCache_OfflineMap/lib/onPhone/render/offlineBaseStyle.ts` and
`getCache_OfflineMap/lib/onPhone/render/offlineColors.ts`.

> **Not to be confused with `static/worldBase/`** (renamed from
> `static/offlineV2/` on 2026-08-07). Despite the old name, that folder was
> never V2 machinery and is **live today**: it holds the bundled Natural Earth
> WORLD BASE GeoJSON + gazetteer and the Noto Sans glyph set that the current
> V4 map loads via `getCache_OfflineMap/lib/onPhone/render/offlineBaseStyle.ts`. Deleting it
> black-screens the offline map and strips every label. Only the *source*
> folder above (`src/lib/mobile/offlineV2/`) was removed.

What V2 was, for the record:

- **The patch = TWO baked PNG `image` sources** (no min/max zoom, present at every
  zoom): a sharp satellite **core** (~10 km) + a wide transparent **line image**
  (roads/water out to ~30 km, below the core). One HARD SWAP at `TILE_ZOOM` (13):
  below it the baked placeholder only; at/above it live z15 satellite tiles + a
  vector mound mounted over it, placeholder hidden (never both on screen).
- **Memory was the whole V2 saga.** The fix that mattered: the mound geometry
  (~97k features) was read from IndexedDB lazily on patch-mount and dropped on
  unmount — never hoarded. Lazy images + `volatile: true` tiles too. Result:
  ~65 MB retained after heavy panning (was 596 MB). The cull was always working;
  the HOARD was the bug. V3 carries this lesson forward.

V3 kept V2's wins (single `image` source, the 5 laws, the user's colours) and
dropped the two-tier swap for one masked photo — simpler, same constant presence.

---

## Dead ends — do NOT reintroduce

Each was tried and failed against the 5 laws. Listed so the reason survives the
deletion of the code.

- **Un-gated vector mound** — live 30 km OSM GeoJSON on EVERY pin, always in
  memory (~27k ways / ~137 MB *per pin*). The original leak. Fix was *gating*
  (zoom + viewport + unload), not banning vectors.
- **World base GeoJSON** — global roads (16 MB) + urban (4.2 MB) → ~450 MB heap,
  and globe-wide roads break constant presence. Trimmed to land/water/rivers.
- **MapLibre offline tiles** — dropped with MapLibre itself. Note the lasting
  trap this left: `addProtocol` is a **MapLibre** API and does not exist on
  mapbox-gl at any version (verified `undefined` on 3.24.0), yet it keeps
  getting reached for because it is the obvious name. Mapbox's equivalent is
  `addTileProvider(name, moduleUrl)`. It has cost a debugging round more than
  once — it fails as a silent no-op, so the map just renders nothing.
- **PMTiles on Mapbox** — never worked end-to-end
  ([[mapbox-pmtiles-not-supported]]). The satellite became a single baked image.
  **Reopened and re-closed 2026-08-11.** Worth recording so it stops coming
  back: PMTiles is built on **HTTP range requests**, and `capacitor://` /
  `file://` don't reliably honour `Range` — so it fails for an ENVIRONMENT
  reason, not a version one, and a newer mapbox-gl cannot fix it. It would also
  only change *which library parses tile bytes*; it does nothing about getting
  tiles to the renderer, which was the actual gap. Don't re-litigate.
- **Wall map as six `geojson` sources** — the design that shipped from the first
  V4 build until 2026-08-11. Cost **800–1200 MB** on interaction, against ~140
  for the online map, because a `geojson` source re-parses and re-indexes its
  whole dataset on every `setData` and retains the index for the source's
  lifetime, inside Mapbox's worker where `performance.memory` cannot see it.
  Replaced by an on-device MVT cut. Full receipts:
  [`../offline/MEMORY_FINDINGS.md`](../../ReTreever/src/lib/mobile/offline/MEMORY_FINDINGS.md).
- **Raster tile pyramid for the satellite** — swaps tiles + vanishes below its
  min zoom (the exact bugs the masked single image escapes).
- **Smooth-circle mask of the boundary** — banned; the jagged tile-edge is the
  trust signal ([[offline-map-no-smoothing-jagged-boundary]]).

---

## Parked: the zoom-banded tiered-tile download design (revive only if needed)

An on-device download plan that bucketed offline tiles by **zoom band** — a
bundled dark world floor (z0–7), vector **linework** (z8–11, ~30 km), **big
tiles** (z9–10, ~3 km), **small tiles** (z15, ~0.4 km) — each with its own byte
budget and LRU eviction, planned via `@turf/union` + `@mapbox/tile-cover` into a
manifest, fetched from the Worker into `mobMapStorage`.

**Why parked:** banding data by zoom means a layer appears/disappears at a zoom
threshold — a direct violation of **law 1 (constant presence)**. The live plan
streams the planet and downloads a per-feature buffer rendered identically at
every zoom instead. The planner code (`offlinePlan.ts` / `offlineBudget.ts`) is
**deleted** — recover from git history if ever needed. Revive this **only** if
live-streaming + a flat per-feature buffer proves insufficient for true-offline
coverage — and even then, strip the zoom bands first.

---

Memories: `offline-blob-naming-and-model`, `offline-map-laws`,
`offline-map-constant-presence-no-zoom-culling`,
`offline-map-no-smoothing-jagged-boundary`, `mapbox-pmtiles-not-supported`.
