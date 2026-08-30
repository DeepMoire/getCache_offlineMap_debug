# Offline Map — History (the footnote)

The live plan is [`OFFLINE_PLAN.md`](./OFFLINE_PLAN.md). **Start there.** This
file is the record of approaches tried and **removed**, kept so nobody re-walks
a dead end. Nothing here is on disk. The 5 laws carried through every version;
only the machinery changed.

---

## V2 — the baked 2-level image pyramid — DELETED

Two baked PNG `image` sources per area: a sharp satellite **core** (~10 km) + a
wide transparent **line image** (roads/water to ~30 km), with one HARD SWAP at
z13 to live satellite tiles + a vector mound. Two files survived the cull and
still ship: `lib/onPhone/render/offlineBaseStyle.ts` and `offlineColors.ts`.

**Memory was the whole V2 saga.** The fix that mattered: mound geometry (~97k
features) read from IndexedDB lazily on mount and dropped on unmount — never
hoarded. ~65 MB retained after heavy panning (was 596 MB). The cull was always
working; the HOARD was the bug.

> **`static/worldBase/`** (once `static/offlineV2/`) was never V2 machinery
> and is **live**: the bundled Natural Earth world base + gazetteer + Noto Sans
> glyphs. Deleting it black-screens the offline map and strips every label.

## V3 — one masked photo per area + on-phone Overpass vector bake — DELETED

Kept V2's wins (single `image` source, the laws, the user's colours) and
dropped the two-tier swap for one masked photo. Its satellite + registry live
on as the current engine; its Overpass road/water/coastline bake
(`bakeVectorLines`, three mirrors, the `-vN` vectors DB) is gone —
`store/tombstones/legacyVectorCleanup.ts` drops the databases.

## V4 rings, decode and re-cut — DELETED

- **Six `geojson` sources** for the wall map — 800–1200 MB on interaction
  (a `geojson` source re-parses and re-indexes its whole dataset on every
  `setData`, inside the renderer's worker). Receipts:
  [`MEMORY_FINDINGS.md`](../../ReTreever/src/lib/mobile/offline/MEMORY_FINDINGS.md).
- **Decode → GeoJSON → re-cut z6–z14 pyramid** in a worker (`wallTiles`,
  `wallFinish`, `v4Decode*`, ~2,700 lines) — 705 MB. Replaced by raw tiles
  served undecoded.
- **Concentric rings** (5 km z15 + 40 km z12, later z9/z12/z13/z15, one source
  per ring) — tiles fell between declared bands and rendered nothing; the
  archive's per-zoom content differs so roads vanished on zoom-out. Replaced by
  one stored zoom.
- **Road RASTER below the vector floor** (`v4RoadRasters`, `rasterDecode`) —
  ~70 MB of PNGs per device, lines 8× a real road's width. Deleted 2026-08-17;
  `purgeRoadRasters.ts` drops the orphaned databases.
- **Bare `z/x/y` road keys** — two pins in one z8 square served each other's
  roads (a Yellowstone pin drew a box 36.6 km south of itself). Keys are now
  pin-prefixed (`grid.ts` `pinTileKey`).
- **`pinFrame`** — wrote pin-box coords into a tile-addressed blob; MapLibre
  stretched the roads 1.86× anchored top-left. Centring belongs to `radiusBox`.

---

## Dead ends — do NOT reintroduce

- **Un-gated vector mound** — live 30 km OSM GeoJSON on EVERY pin, always in
  memory (~137 MB *per pin*). Fix was *gating*, not banning vectors.
- **World base GeoJSON with global roads** — 16 MB roads + 4.2 MB urban →
  ~450 MB heap. Trimmed to land/water/rivers.
- **`addProtocol` on Mapbox** — a MapLibre API; `undefined` on mapbox-gl
  (verified 3.24.0) and fails as a silent no-op, so the map renders nothing.
  Mapbox's equivalent is `addTileProvider`. The route is on MapLibre now.
- **PMTiles on Mapbox** — never worked end-to-end. PMTiles needs HTTP range
  requests, and `capacitor://` / `file://` don't reliably honour `Range` — an
  ENVIRONMENT reason, not a version one. Don't re-litigate.
  ([[mapbox-pmtiles-not-supported]])
- **Raster tile pyramid for the satellite** — swaps tiles + vanishes below its
  min zoom.
- **Smooth-circle mask of the boundary** — the jagged tile edge is the trust
  signal ([[offline-map-no-smoothing-jagged-boundary]]).
- **Serving the planet's own pyramid** — low-zoom tiles omit minor roads, so
  zooming pops them in and out ("unnerving").
- **A second radius / a second shape** — tried three times; always reads as a
  confusing second shape appearing and vanishing across zooms.

---

## Parked: the zoom-banded tiered-tile download design

Bucketed offline tiles by **zoom band** — a world floor (z0–7), linework
(z8–11), big tiles (z9–10), small tiles (z15) — each with its own byte budget
and LRU eviction, planned via `@turf/union` + `@mapbox/tile-cover` into a
manifest. **Parked because banding by zoom is a direct violation of law 1
(constant presence).** The planner code (`offlinePlan.ts` / `offlineBudget.ts`)
is deleted — git history if ever needed. Revive only if a flat per-feature
buffer proves insufficient, and strip the zoom bands first.

---

Memories: `offline-blob-naming-and-model`, `offline-map-laws`,
`offline-map-constant-presence-no-zoom-culling`,
`offline-map-no-smoothing-jagged-boundary`, `mapbox-pmtiles-not-supported`.
