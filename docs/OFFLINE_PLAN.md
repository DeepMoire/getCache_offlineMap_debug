# Offline Map — The Plan (start here)

The single entry point for everything offline. The offline map lets Get Cache
work with **no signal**: a downloaded area shows a satellite photo with roads +
water drawn on it, over a dark **base map**, around the user's own pins/maps —
plus the two **safety layers**, wildfires and hospitals. This doc owns the
*shape of the whole thing*; the device + cloud detail and the TODO are below.

**Two kinds of thing live on this map, and they follow different rules:**

| | TERRAIN — roads, water, land, satellite | SAFETY — fires, hospitals |
|---|---|---|
| Changes | glacially; a snapshot is fine forever | fires change **hourly** |
| Stale is | harmless | **dangerous** |
| Governed by | the wall map + the 5 laws | [§ The two SAFETY layers](#the-two-safety-layers--fires-and-hospitals) |

Most of this document is about terrain, because that is where the hard
engineering is. Don't read that as fires being secondary — they are the reason
somebody opens this app on a bad day.

**Engine: MapLibre GL JS** (5.16.0), for THIS ROUTE ONLY. The online map
(`/map`) stays on **Mapbox** and must not be converted — it needs
Mapbox-only features (globe projection, `setTerrain`, `setFog`, `mapbox://`
styles). Both renderers ship; they coexist.

**Why the offline map diverged:** it must hand the renderer tiles it decoded
from local storage. Mapbox's hook for that is `addTileProvider`, which is
`@experimental @private`, essentially undocumented, and — for a VECTOR source —
runs the provider **inside a Web Worker** (mapbox-gl.d.ts:5553), where it cannot
read main-thread memory. That forced tiles through IndexedDB plus epoch
bookkeeping: ~350 lines. MapLibre's `addProtocol` is documented, stable, and
runs on the **main thread**, so tiles are served straight from an in-memory
`Map` — see `getCache_OfflineMap/lib/onPhone/roads/rawWallProtocol.ts`.

⚠️ **MapLibre is NOT a memory fix, and was never claimed as one.** Both
renderers decode a 1536×1536 satellite WebP into the same ~9.44 MB GPU texture.
The swap buys tile delivery through a documented API instead of a guessed one.
The photo-driven spike is governed by `MAX_MOUNTED_PHOTOS`, which no renderer
change touches.

`MapDrawControls` and the shared map helpers serve BOTH renderers: each takes a
structural map type, or asks the live instance which library built it
(`$lib/mobile/map/rendererOf.ts`). Everything defaults to Mapbox, so the online
map is unaffected.

## The one-paragraph version

**The offline map is the online map with the network cut.** Same engine, same tile
format (MVT), same "load what's on screen, evict what isn't" behaviour. The only
difference is where the tiles come from: online they arrive from Mapbox's servers;
offline they were downloaded earlier, on the user's volition, and are cut into
tiles **on the device**. Mapbox is handed tiles as it asks for them and throws them
away when they scroll off — nothing is held whole in memory. That is the entire
design, and every past memory blowup on this route came from breaking it: something
got flattened into one big object and handed across a boundary instead of staying
in tile space. **Tiles or strings across a boundary — never a parsed object graph.**
([[json-across-worker-boundary-is-the-bug]])

## The Wall Map — the settled technique (V4)

A downloaded area renders like **a paper map pinned to a wall**: it is *there*,
constantly, at every zoom — it never appears at a threshold, never vanishes,
never blinks. That is the whole trick, and it is what satisfies Law 1 (constant
presence). **Call it the "wall map."** It pairs with the Quilt Law: *the quilt
stays whole.*

**The "blobs" = the wall map.** When the user says "the blobs didn't load", they
mean the roads + water + land drawn over the satellite photo. Same thing.

⚠️ **STEPS 2 AND 3 BELOW ARE SUPERSEDED — kept as the record of what was
deleted, not as instructions.** The phone no longer decodes anything: raw MVT
goes from IndexedDB to the renderer untouched, one source per stored zoom
(`rawWallProtocol.ts`). That removed ~2,700 lines and took the route from a
measured 705 MB to ~94 MB at **zero extra download**. Do NOT re-implement a
decode step. See [[wall-map-no-decode-raw-tiles]] and § the viewer's ZOOM BANDS.

How a wall map is built (four steps, all on the user's volition, LAW 0 intact):

1. **DOWNLOAD two detail zooms as concentric RINGS.** The Worker reads the area's
   tiles from the hosted whole-world Protomaps planet (`planet.pmtiles`, z0–15) and
   packs them: an **inner 5 km disc at z15** (full detail) + an **outer 40 km disc
   at z12** (roads + water — see decode). The phone writes the raw MVT bytes into
   IndexedDB. This is the *downloader's* network — never the map's. Two zooms, but
   as **spatial rings** (a small sharp core + a wide road reach), NOT a z-stack
   served to the map. The 2 km **satellite** photo is the tight core of the same set.
2. **DECODE into GeoJSON, in the worker.** `buildV4GeoJSON()` parses every stored
   tile (`@mapbox/vector-tile` + `pbf`; `feature.toGeoJSON(x,y,z)` reprojects tile
   coords → lng/lat) into roads / water / land / poi FeatureCollections. A tile
   **below the inner detail zoom (the z12 outer ring) contributes roads + water**
   (`decodeBucketKind`) — water carries the coastline so roads don't float over the
   ocean; the z15 inner ring keeps the full basemap.
3. **RE-CUT INTO TILES, still in the worker.** `wallFinish.ts` does the
   post-processing (clip water to the satellite blobs, thin the road labels), then
   `wallTiles.ts` cuts the result into a **z6–z14 MVT pyramid** with `geojson-vt` +
   `vt-pbf`. The GeoJSON is a transient intermediate that never leaves the worker.
4. **RENDER as ONE vector source.** The page declares a single `vector` source fed
   those tiles. Mapbox loads the tiles under the viewport, parses only those, and
   evicts the rest through its normal tile cache — exactly what it does on the
   online map.

**Why step 3 exists — read this before you "simplify" it away.** Steps 2→4 used to
be "flatten into six whole-region FeatureCollections and `setData` each one into a
`geojson` source". That is what made this route cost **800–1200 MB** while the
online map idled at 140. A Mapbox `geojson` source has exactly one behaviour: parse
the WHOLE payload, build a geojson-vt index over the WHOLE dataset, and RETAIN that
index for the source's lifetime — all inside Mapbox's own worker, where
`performance.memory` cannot see it. Six sources meant six retained whole-region
indexes, rebuilt from scratch on every rebuild, and nothing was ever evicted because
from Mapbox's side it was one live dataset. **The offline map un-tiled its own
already-tiled data and asked Mapbox to re-tile it.** Step 3 puts it back in tile
space and the cost drops to what the screen holds.

**Constant presence is NOT the same as "one flat layer".** This is the distinction
the old design got wrong. Law 1 says a downloaded area is visible at every zoom.
It does **not** say the renderer may only hold one geometry. A z6–z14 pyramid cut
from OUR OWN complete data satisfies Law 1 because every level is cut from the same
features — nothing is dropped at any level, so nothing can pop. What breaks Law 1
is serving the **planet** `.pmtiles` pyramid, whose low-zoom tiles deliberately
OMIT minor roads: zoom out and features genuinely disappear. The enemy was always
*lossy* low-zoom tiles, never tiles as such.

**Why NOT serve the `.pmtiles` pyramid to Mapbox directly** (we tried; rejected):
the planet's low-zoom tiles omit minor features, so zooming pops them in and out.
The user calls that "unnerving." Our own cut keeps every feature at every level.

**The three-ring model (settled — stop re-deriving this):**
- **Satellite = the ONLY photo.** A raster `image` (WebP), **2 km** centre, from EOX.
  Pixels → goes soft if you zoom way past bake res (accepted). NEVER a tile pyramid.
- **Inner detail ring = 5 km at z15, FULL basemap.** The Protomaps planet `.pmtiles`
  carries the ENTIRE rich basemap — dozens of source-layers (`earth`, `water`,
  `landuse`, `landcover`, `roads`, `transit`, `buildings`, `places`, `pois`,
  `boundaries`…) — already classified, so we paint each in your owned hexes
  (`offlineColors.ts`), styled **DARK** like Mapbox's own dark basemap. V4 draws
  roads + water + landcover/landuse + the dark base; other source-layers are present
  to switch on later.
- **Outer reach ring = 40 km at z12, ROADS + WATER.** A wide, cheap road skeleton
  plus the water layer (ocean + lakes) so the surroundings read land-vs-coastline —
  roads no longer float over the sea — without the data weight of full landcover/
  landuse detail. ~105 tiles per anchor total vs the ~1000 of the old monolithic
  30 km z14 disc.

---

## The viewer's ZOOM BANDS — how the offline page displays it all

The viewer (`src/routes/(getcache)/offline/+page.svelte`) shows **every map's
blobs** (not just the active map's). All constants named here live at the top of
that file.

**THERE IS NO ZOOM BAND. Roads are VECTORS at every zoom.**

| What renders | How |
|------|-------------|
| **Roads, water, land** | Downloaded VECTOR tiles, four rings — z9 regional, z12 ring, z13 mid, z15 core — each its own raw source, handed to the renderer undecoded (`rawWallProtocol.ts`). MapLibre overzooms UP between them, so every zoom from the shallowest ring to z22 is covered. |
| **Satellite photos** | Baked ~2 km chips at each area's pin, hand-mounted as image sources under the road vectors, viewport-budgeted (`MAX_MOUNTED_PHOTOS`). |
| **Below the shallowest ring** | The bundled Natural Earth world base — same as every map app at a continent-wide view. |

### ⛔ The road RASTER is DELETED (2026-08-17). Do not bring it back.

There used to be a second band below `WALL_MIN_Z` that swapped the vectors for
pre-rendered PNG **pictures** of each area's roads (`v4RoadRasters.ts`,
`rasterDecode.ts` — 562 lines). It existed for two reasons, **both now false**:

1. The pack stopped at z12, so z8–z12 had no vectors to draw. → The Worker now
   ships a **z9 regional ring**.
2. Decoding tiles into GeoJSON cost ~705 MB, so vectors could not be live while
   zoomed out. → Raw tiles go to the renderer **undecoded**. That cost is gone.

**What it cost:** ~70 MB of PNGs per device, 4 MB of texture per mounted sheet
(cap 250 → ~250 MB idle main thread), and 78 m per pixel — so its thinnest
possible line was **~8× a real road** (measured in-app: one line 445 m across).
The vectors that replaced it cost **~250 kB** for the same ground.

`purgeRoadRasters.ts` drops the orphaned IndexedDB databases on boot, because
deleting the code does not delete the bytes.

**When a shallow zoom looks empty, the fix is a SHALLOWER RING IN THE PACK**
(`packBuilder.ts` `REGIONAL_RING_Z`) — never a picture. A vector is thin and
sharp at every zoom; that is the entire point of it.

**z9 is the geometric floor.** A tile spans `40075 × cos(lat) / 2^z` km, and the
downloaded area is 80 km across. At 45° N: **z9 = 55 km (fits), z8 = 110 km
(does not)**. A tile wider than the area necessarily paints ground the user never
downloaded — that is the z8 build that shipped and was rejected the same day
("this huge huge in-between layer… an unbelievable tripping hazard"). Pinned by
`v4CloudflareTiles.test.ts`.

**Reconcile invariants (learned the hard way — keep them):**
- **Sweep BEFORE mount.** The unmount sweep runs before any mounting, and every
  mount is per-area try/caught. One throwing mount must never abort the pass —
  that stranded stale 40 km sheets over the street view (and the pins) forever.
- **Viewport render budget.** Only areas near the viewport mount
  (`viewportAreas`, `MOUNT_MARGIN`, caps); the selection re-runs on debounced
  `moveend`. Never mount the full 700-area set — that built GB-scale heap.
- **Force refresh is throttled.** Bake-service generation bumps force a full
  refresh at most every 45 s (there is no band test any more — one band).

**Features are NOT the viewer's business.** Pins, plots, clusters, draw tools
come from the SAME shared machinery as the online map (`MapDrawControls`,
`pinMarkers`, `PlotLayer`) and must render identically in offline mode — the
offline page does NOTHING to features except float draw layers/labels above
freshly-mounted photos (`raiseDrawLayers`).

---

## The two SAFETY layers — fires and hospitals

The wall map is *terrain*. Fires and hospitals are **safety information**, and
they follow different rules from everything above. They are the reason a forestry
worker with no signal opens this app at all, so they get their own section.

### They are on a different clock

| | wall map (roads, water, land) | fires | hospitals |
|---|---|---|---|
| Changes | glacially — a snapshot is fine forever | **hourly** | glacially |
| If stale | harmless | **dangerous** | harmless |
| Source | Protomaps planet, via R2 | NASA FIRMS, via the fire cache | the `pois` source-layer |
| Refresh | only when the area is re-downloaded | **kept refreshing on its own clock** | with the wall map |

That middle column is the whole point. **Fires are PERISHABLE.** The bake
service's "download once, nothing left to do, forever" logic is correct for a
basemap and catastrophic for a hazard layer — so `refreshFires` in
`offlineBakeService.svelte.ts` runs on its own schedule with its own cooldown,
deliberately separate from the photo/tile bake. A NASA outage must not stall
photo bakes, and a slow photo bake must not suppress a fire refresh. Two
tripwire tests pin this; don't merge the passes.

An **honest age stamp beats an empty map** — a map showing nothing reads as "no
fires near you," which is the one wrong answer that gets somebody hurt. And when
the user opens the app *specifically* to check a fire (`takeFireArrival`), a
59-minute-old cached record is not good enough even though it passes the freshness
check, so that path forces a fetch.

### Fires are NEVER opt-in — settled, don't re-litigate

Fire shipped behind a toggle once. That was wrong: **an opt-in hazard layer is
one you discover the day after you needed it.** In practice hotspots downloaded
correctly for hours and were never once seen. The user's ruling:

> "you can't turn them off if there's fires they need to know."

So `OPT_IN_LAYERS` is deliberately **empty** and `fire: true` is a default that
stays. Restraint comes from *how they are styled* — small, muted, clustered,
drawn below the user's own pins — never from hiding them. Context governs
STYLING, not presence.

### Fires do not obey LAW 0 the way the basemap does — and that is correct

The basemap is a snapshot; a stale one is a fine map. A stale fire is a lie. So
fires are fetched whenever there IS signal, cached per-area, and rendered from
cache when there isn't. This is not a LAW 0 violation: the **map** still renders
only on-device bytes. The fetch is the same user-driven downloader path as
everything else — it just runs on a much shorter clock.

⚠️ **The viewer never fetches.** `attachFireLayer` is called with
`canFetch: false` on this route, because `/offline` is a pure VIEWER and
the app-wide `offlineBakeService` owns every download. A second downloader racing
it would double-fetch and fight over the same cache entries.

### 🔬 Fires are currently DISABLED on this route — a bisect, not a decision

`FIRE_LAYER_ENABLED = false` in `+page.svelte`. This is a **temporary
single-variable test**, not a design choice, and it must be restored.

The reason it is worth knowing about: **v1 of the fire layer was measured at
~4,000 MB and 119% CPU on an idle page with nothing moving**, and disabling only
that layer took the same page to 963 MB. A 15× swing from one subsystem. Every
memory number elsewhere in these docs was taken with fires OFF for exactly that
reason — so none of them are contaminated by it, and none of them prove anything
about fire cost.

**Fire v2 is written, typechecked and tested (43 tests) but NOT wired in**, and
its Worker route does not exist yet. Full spec + cutover:
[`WILDFIRE_LAYER_V2.md`](../routes/fires/docs/WILDFIRE_LAYER_V2.md). Its architecture is the same
lesson as this document's: v1 held every raw detection on the phone and
re-derived geometry from them (~36,489 detections for one disc); v2 computes in
the Worker and ships the phone something already reduced. **Same fix, third
subsystem.**

### Hospitals — quiet, and a naming trap

Hospitals are just POIs. They ride in the wall map's `pois` source-layer, drawn
by `v4-poi-hospital` as an icon-only symbol layer sized to match the online
map's marker exactly (`mapInit.ts` `hospitals-osm-icon`). No separate source, no
separate download, no clock of their own — if the area is downloaded, its
hospitals came with it.

⚠️ **`showHospitalMarkers: false` on this route does NOT mean hospitals are
off.** That flag belongs to the *shared online* hospital machinery, which this
route deliberately does not use because it has its own POI layer from local
tiles. Chasing that flag when a hospital doesn't appear is a wrong turn — the
question is whether the `pois` layer made it into the tile cut. Campsites in the
same layer are gated to z10+ to keep the map from becoming a wall of pins; that
gate is decluttering, and is the one sanctioned exception to Law 1's no-zoom-band
rule (which is why `offlineLaws.test.ts` scopes its assertion to roads/water/land).

---

## ⛔ THE LAWS — obey before you touch anything

These are the rules that make the feature worth building. They are not
suggestions and they are not up for re-debate. **If a change breaks one, the
change is wrong — not the law.** The user has explained these hundreds of times;
never make them repeat it.

**LAW 0 — THE MAP NEVER STREAMS. This is the whole point of an offline map.**
The map renders **only** from on-device storage. It NEVER pulls a tile, a style,
or any byte from the internet *into the map*. The flow is one-directional and
**user-driven**: when the user imports a file or draws a feature, the app streams
the data that area needs DOWN into a **local folder / IndexedDB on the phone** —
and the map reads that **local copy**. The map's sources are always local URLs
(`blob:` / `file:` / same-origin), never a remote one. **Even if the rendering
tech changes** — new engine, new tile format, native PMTiles, whatever — and it
would be trivially easy to just hand the map a remote URL: **DON'T.** If anything
is streaming straight into the map, the change is wrong, not the law.
([[offline-map-laws]])

**Tier 1 — what makes it worthwhile (the 5 laws):**
1. **Constant presence** — a downloaded area is visible at EVERY zoom, identically. Zoom out to z1 and it's still there (maybe sub-pixel); zoom in and you see full detail. NEVER appears/disappears at a zoom threshold. **The test of this law is whether features are DROPPED, not how the data is stored.** Our own z6–z14 cut carries every feature at every level, so nothing can pop — it passes. Serving the *planet's* pyramid fails, because its low-zoom tiles omit minor roads by design. Below z6 the pre-rendered road pictures carry presence down to z1 (see "zoom bands").
2. **Jagged frontier** — render the real stair-stepped tile-edge shape; never smooth/mask it to a circle. The imperfection is the trust signal.
3. **No blink on refine** — stays continuously visible through any representation change; no one-frame gap, no vector↔raster swap.
4. **Colours are the user's** — never invent/tune a hex; ask. ([[dont-change-colours-without-permission]])
5. **RAM scales with the SCREEN, not the download.** Held by viewport cull + disk LRU only. **Zoom-culling is BANNED** (it breaks law 1) — the cull is spatial and automatic, done by Mapbox's own tile cache.
   **How to measure it — the panel is not enough.** `performance.memory` (what the MAP DEBUGGER shows) is **main-thread only**, and on this route the Workers hold more than the page — that is precisely why the 800 MB defect hid for weeks. Use **DevTools → Memory → "Total JS heap size"**, or the VM-instances list to attribute per-worker. For a growth bug, use **Allocation sampling sorted by Self size** — never a snapshot Summary ([[profile-allocation-not-snapshot-summary]]).
   **Run-to-run variance is ±100–200 MB with no code change.** A fix worth less than that cannot be validated by eyeball; repeat the unchanged config at least once before believing an A/B.

**Tier 2 — how we build versions (the process laws):**
6. **Reuse the tool chrome — NEVER rebuild it.** A new offline version = duplicate the route + keep the same component imports (`MapTopControls` + `MapDrawControls` + scale) + swap ONLY the base/data layer. Never reconstruct tools or make the user re-add them. ([[offline-reuse-tool-chrome-never-rebuild]])
7. **Verify with TESTS, never eyeballs.** A law that matters gets a test that fails the build when it's violated — that is the only enforcement that actually holds.

Engine guardrails: **this route is MapLibre; the ONLINE map stays Mapbox** (do
not convert it) · **the map reads only on-device
data, never a remote URL (LAW 0)** · satellite = single raster `image` (never a
tile pyramid) · **V4 wall map = ONE `vector` source fed MVT tiles cut on-device** —
Protomaps tiles downloaded as concentric SPATIAL rings (5 km z15 + 40 km z12),
decoded, post-processed, and re-cut z6–z14 in the decode worker. Never a `geojson`
source for the wall map; never the planet's own lossy low-zoom pyramid.

---

## The three layers

The offline map is **one experience built from three independent layers**. They
ship on their own timelines and never block each other. Layer 1 works today with
zero cloud; Layers 2–3 add the cloud *on top*, behind flags, without touching
Layer 1.

> **"Layer" means two different things in this codebase — mind the gap.** Here it
> means a **sourcing tier** (where the bytes come from). Elsewhere — and in
> Mapbox — it means a **map layer** (a thing drawn on screen). The three tiers
> below cover TERRAIN only. The **safety layers** (fires, hospitals) are map
> layers that cut across all three tiers and are governed
> [in their own section](#the-two-safety-layers--fires-and-hospitals), because
> their refresh clock is completely different. Fires being absent from this table
> is not an omission; putting them in it would be the mistake.

| # | Layer | What it is | Where it lives | Status |
|---|-------|-----------|----------------|--------|
| **1** | **On-phone baked satellite + registry** | One masked satellite photo per area, baked **on the phone** (EOX), stored in IndexedDB, tracked by a coverage registry that drives dedup / budget / reconcile. Engine in `getCache_OfflineMap/lib/onPhone/` (`satellite/satelliteImage.ts` + `store/coverageRegistry.ts`). | ships **inside** `/offline` · §"Layer 1" below | **Shipping** |
| **2** | **Cloud globe basemap (wall map)** | The whole planet's OSM vector tiles as one Protomaps `.pmtiles`; the app downloads the area's slice, decodes it, and **re-cuts it into its own z6–z14 MVT pyramid on the device**, served to ONE `vector` source read **locally** — never streams to the map (LAW 0). This is the roads/water you see — it **replaced** Layer 1's old on-phone Overpass vector bake. | `/offline` · §"Layer 2" below | **Shipping — THE offline map** |
| **3** | **Cloud bake + supplement** | Bake each area **once in the cloud** (not per-phone), keep a central registry so nothing is built/sent twice, and supplement areas with better-than-default data (sharper base-map detail, owned high-res) | future · this doc § "Layer 3" | **Vision — design only** |

**Layers 1 and 2 now ship as ONE route, `/offline`** (the crow toggle
from `/map`): on-phone baked satellite (Layer 1) + the R2-downloaded
roads/water wall map (Layer 2). The earlier **standalone `/offlinev3`
route is deleted** — it ran Layer 1 with its OWN on-phone Overpass-baked vector
roads; the satellite + registry it pioneered live on as V4's engine (folded into
`offlineV4/` on 2026-08-07, so **there is no `offlineV3/` folder**; that engine was
then carved into the child at `getCache_OfflineMap/lib/` on 2026-08-23, so there is no `offlineV4/`
folder either), and
roads/water now come from the Layer 2 wall map. The blob debug console
(`/debug/blobs`) inspects the on-device storage.

---

## Layer 1 — on-phone baked satellite + registry (shipping inside V4)

**This is what works right now, and it's good. Don't break it.** It ships
**inside `/offline`**, engine **Mapbox** — the SAME engine as the rest
of the app, using the real `MapDrawControls` (draw drawer, pin tool, zoom pill,
scale) + `MapTopControls`. The satellite is a single baked **image source**.
Inspect on-device storage at **`/debug/blobs`** (the blob console:
per-map nesting, per-area satellite/roads/water sizes, footprint vs budget).

> **⚠️ What's live vs dormant.** In the shipping map (V4) the **satellite** below
> is baked on-phone and is live. **Roads/water are NO LONGER baked on-phone via
> Overpass** — V4 gets them from the Layer 2 R2 wall map. The on-phone vector
> bake (`v3Vectors.ts` `bakeVectorLines`, the Overpass mirrors below) is
> **dormant**: it powered the now-deleted standalone V3 route. The satellite +
> registry are what Layer 1 still contributes.

**Per area, three pieces, baked once, stored on the phone (IndexedDB):**

| Piece | What | Source | IndexedDB | Code |
|-------|------|--------|-----------|------|
| **Satellite** | ONE masked photo, single `image` source | EOX (Sentinel-2) | `retreever-v3-satimg` | `v3SatelliteImage.ts` |
| **Base-map lines** (roads, water, shore) | GeoJSON lines in one stored array tagged `kind: "road"\|"water"\|"coast"` — roads + shore ~30 km, water ~8 km | OSM / Overpass | `retreever-v3-vectors-v7` | `v3Vectors.ts` |
| **Registry** | one record per area (hasPhoto, hasLines, bytes, lastTouched) | — | `retreever-v3-registry` | `v3Registry.ts` |

The `-vN` suffix on the vectors DB bumps on any radius/layer change to force a
clean re-bake (`-v7` added the shore line); stale versions auto-delete on boot. The
dark base under the pieces is Natural Earth land/water/rivers/roads
(`buildOfflineBaseStyle`, `offlineColors` — both in `getCache_OfflineMap/lib/onPhone/render/`).

### Why the satellite never had the roads' bugs — the measured lesson

Worth keeping in front of you, because it is the whole difference between the
two halves of this system. Measured over a full night in the field: the
satellite landed **2–5 m off the pin on every single pin**, while roads were
failing by *tens of kilometres*.

The reason is the KEY. The satellite is an image placed by explicit GPS bounds
and keyed `` `${lng},${lat}` `` — **the pin itself**, never a shared grid
square. Roads were keyed to a shared world grid, and every placement, coverage
and invalidation bug lived in that shared key.

**So: key to the thing, not to the grid it happens to sit on.** (Carried over
from the deleted `offlineV6/SALVAGE.md`, whose file list had gone stale — the
engine has since been carved into the `getCache_OfflineMap` child.)

### The satellite = ONE masked photo — non-negotiable

This has been the source of every loop. READ IT.

- A downloaded region is shown at a **fixed level of detail — the SAME picture at
  every zoom.** We do NOT swap in sharper tiles as you zoom (the Google-Maps
  behaviour we reject).
- **Bake ONCE from the FINE tiles** → composite into ONE image. The transparent
  gaps where tiles don't exist **ARE** the jagged mask. We do NOT draw a mask
  shape; the photo's own alpha IS the mask.
- Render as a **single Mapbox `image` source** (NOT a raster tile source). An
  image source has no min/max zoom → present and identical at every zoom, only
  changing SIZE. Zoom out → the same photo scales to a small jagged circle, still
  there. Zoom in → it scales up and goes soft past bake resolution (ACCEPTED).
- ❌ NEVER a raster tile pyramid for the satellite (swaps tiles + vanishes below
  its min zoom — both the bugs we keep hitting).

### Reconcile — the self-healing guarantee

**The reconcile runs APP-WIDE, not on the offline page.** It lives in
`getCache_OfflineMap/lib/onPhone/bake/bakeService.svelte.ts`, started once from the
Get Cache layout (`src/routes/(getcache)/+layout@.svelte`). So a feature's blob downloads
the moment it's created/touched, regardless of which mini-app is open — a
downloaded area is ALWAYS already on disk before the user ever opens the offline
map. **`/offline` is a pure VIEWER**: it mounts blobs already on disk
(`getSatImageByKey`, a pure read) and NEVER bakes or downloads. The service tells
the viewer (via `subscribeOfflineBake`, the applier pattern) when new blobs land
so it re-decodes. If baking only happened when you opened the offline map, it
would already be too late — that's the whole point.

The registry is the brain: it dedups overlapping pins to one area, enforces the
storage budget (LRU-evict the least-recently-touched over budget), and
**reconciles** — re-checks on load, on pin changes, on tab focus, and on a 20 s
timer, re-baking anything missing. Bakes are idempotent (cached if present,
retried if a prior bake failed), so a cache wipe or a flaky-network failure
self-heals instead of leaving an area half-baked.

**🔒 ENSHRINED — newest-last-touched bakes FIRST.** Whenever the reconcile has a
backlog of areas to bake, it processes them in **most-recently-touched-first**
order (the active map's freshest features, then other maps sorted by
`lastTouched` desc). Overpass is slow and rate-limits, so a freshly-dropped or
just-opened pin must never wait behind a stale backlog of hundreds of old areas.
Eviction is the mirror image — **least**-recently-touched goes first. Never bake
oldest-first. (Reconcile order in `getCache_OfflineMap/lib/onPhone/bake/bakeService.svelte.ts`.)

**🔒 ENSHRINED — a blob is ONE indivisible unit (satellite + roads together).** An
area's satellite photo and its wall-map tiles (roads/water) are a single blob keyed
by one `areaKey` with ONE `lastTouched` timestamp. They download together and they
**evict together** — `pruneArea` always drops the photo, the vectors, AND the
registry record in one call. There is exactly one clock; "last touched" means last
touched, full stop. The budget must NEVER leave one half without the other (a photo
with no roads, or roads with no photo). If you ever see that asymmetry, it is NOT
eviction splitting a blob — it's a DOWNLOAD bug (one half failed/was skipped); fix
the download path, never special-case eviction. (Tripwires in
`offlineBakeService.test.ts` pin both halves of this.)

**🔒 ENSHRINED — TWO SIMPLE LISTS (the whole brain, every 20 s).** `bakeAll` in
`getCache_OfflineMap/lib/onPhone/bake/bakeService.svelte.ts` is just two independent passes over ONE
list ranked by last-touched. Keep it this simple; if either grows extra branches,
you've taken a wrong turn.

```
First: a guard. Any maps loaded?  ──NO──▶ do NOTHING this pass.
  (On a cold reload the in-memory map list is briefly empty; evicting then would make
   every pin look unowned and wipe everything — the 1 GB → 70 MB crash. Wait for it.)

Rank EVERY feature's blob by LAST-TOUCHED, newest on top. (the demo is pinned on top.)

LIST A — KEEP-OR-EVICT
  add up blob sizes from the top; the moment the total passes 1 GB, draw the line.
    • above the line → KEEP
    • below the line → EVICT the WHOLE blob (the feature stays; image+roads+water+base
                       are deleted together as ONE unit — never half)

LIST B — DOWNLOAD-WHAT'S-MISSING  (separate pass over the same kept list)
  for each KEPT feature: does it have its blob?
    • yes → leave it
    • no  → download it: image (bakeSatelliteImage) + roads/water/base (downloadV4Area)
            └ image came back mostly EMPTY (source throttled)? → FAIL, retry next pass;
              NEVER store the ~30 KB transparent dud.
```

**Last-touched is the ONLY clock.** Size never changes the order — it only decides
WHERE the 1 GB line falls. A blob is one indivisible unit. Being briefly over 1 GB is
fine (the two lists don't have to finish in the same instant). The `/debug/blobs` badges read
the result: 🟢 has its blob · 🟠 roads but the image bake FAILED (a download problem,
never an eviction bug) · 🟡 evicted (fell below the line).

**Overpass is throttle-prone — bake fans out across mirrors.** `bakeVectorLines`
tries `overpass.kumi.systems` → `private.coffee` → `overpass-api.de` in order; a
busy/rate-limited endpoint (HTTP 429, or a wall of failed `interpreter` requests
in the network tab) falls through to the next mirror instead of returning empty.

**Source services are external + free.** Today every phone fetches EOX + Overpass
itself and bakes its own copy. That's the thing Layers 2–3 improve.

---

## Layer 2 — the cloud globe basemap (V4)

The **prebuilt Protomaps planet** (`~120 GB`, all of OSM, every zoom, already
rendered to vector tiles) is one hosted `.pmtiles` file. V4 turns the area's
slice of it into a **wall map** (see "The Wall Map" at the top). `/offline`
is the route: a clone of V3 (same chrome) with the dark Protomaps basemap rendered
as a wall map. The pipeline lives in `getCache_OfflineMap/lib/r2Worker/local_dev/roads/packDownload.ts`:

```js
// ── IN THE DECODE WORKER (v4DecodeWorker.ts) ─────────────────────────────
// 1) DOWNLOAD the concentric rings into IndexedDB (downloader's network, not the map).
//    ONE request to the offline-tiles Worker's /pack endpoint: it computes the same
//    RINGS (5 km z15 + 40 km z12), reads every tile from the owned R2 archive edge-side,
//    and packs them into one blob; the phone unpacks it into IndexedDB in a single tx.
await downloadV4Area(lng, lat);            // fetch https://tiles.retreever.org/pack?lng=&lat=
// 2) DECODE every stored tile into GeoJSON (z12 outer ring = roads + water)
const gj = await buildV4GeoJSON();         // @mapbox/vector-tile + pbf
// 3) POST-PROCESS, then RE-CUT into an MVT pyramid. Never leaves the worker.
const wall = finishWall(gj, satAnchors);   // wallFinish.ts → wallTiles.ts
                                           // geojson-vt + vt-pbf, z6→z14

// ── ON THE MAIN THREAD (offline/+page.svelte) ──────────────────────────
// 4) RENDER as ONE vector source. Six sources became six SOURCE-LAYERS in one tile.
map.addSource('v4-wall', { type: 'vector', tiles: [url], minzoom: 6, maxzoom: 14 });
map.addLayer({ id: 'v4-roads-major', source: 'v4-wall', 'source-layer': 'roads', ... });
map.addLayer({ id: 'v4-water-fill',  source: 'v4-wall', 'source-layer': 'water', ... });
// 15 layers, all painted per offlineColors.ts, all pointing at the one source
```

**One tile carries many named layers** — that is native MVT, not a trick. The six
wall kinds (`water`, `roads`, `roadlabels`, `land`, `pois`, `places`) became six
`source-layer`s inside each tile, so the style's layer definitions survived the
rewrite unchanged apart from `source` + `source-layer`. It is a data-shape change,
not a restyle.

**`maxzoom: 14` does not cull.** Mapbox OVERZOOMS its deepest tile, so a z14 tile
keeps rendering at z22 by reusing its geometry. Cutting deeper would multiply tile
count ×4 per level for detail that isn't in the source data anyway (it came from
cached z12–z15 tiles). Same trap the world base hit: built at z8 it was 164 MB and
unshippable; z6 looked identical.

- **Source:** the **owned** whole-world Protomaps planet (`planet.pmtiles`, z0–15)
  parked on **Cloudflare R2** in the `offline-tiles` bucket. The phone never reads it
  directly — it calls the `offline-tiles` **Worker's** `/pack` endpoint
  (`tiles.retreever.org/pack`), which reads the archive edge-side via its R2 binding
  and returns the area's two rings in one response. Worker source + deploy:
  `/Users/chrisharris/DEV/fetch/ReTreever/workers/offline-tiles/`. Whole-world means
  no regional-edge holes (the cause of the old "weird partial shapes"). Changing the
  rings = keep `RINGS` in lockstep on both sides (client `v4CloudflareTiles.ts` +
  Worker `index.ts`).
- **Freshness = a snapshot.** Each build is frozen at its date — fine for a
  basemap (roads/water change glacially). No per-user sync, no cache invalidation.

### How tiles reach the renderer — the delivery mechanism

Cutting the tiles was the easy half. **Getting them into the renderer without a
web server is the hard half**, and it is what drove this route onto MapLibre.

Implementation: **`getCache_OfflineMap/lib/onPhone/roads/rawWallProtocol.ts`** (~160 lines).

```
decode worker              main thread                MapLibre
─────────────              ───────────                ────────
cutWallTiles()  ──────▶  Map<"z/x/y", bytes>  ◀──get── addProtocol handler
                         (wallProtocol.ts)             └─▶ {data: ArrayBuffer}
```

`maplibregl.addProtocol(scheme, handler)` is documented and stable (it is what
Protomaps/PMTiles ships on), and the handler runs on the **main thread**
(maplibre-gl.d.ts:14578: *"This will happen in the main thread, and workers
might call it if they don't know how to handle the protocol"*). Vector tiles are
loaded by MapLibre's worker, which finds the scheme absent from its own registry
and posts the request back to the main thread — so the handler reads a plain
`Map` directly. Registering a protocol *in* the worker is a separate, explicit
opt-in (`importScriptInWorkers`) that MapLibre itself flags as experimental; we
do not use it.

No IndexedDB. No epochs. No generation sweep. `installWallTiles()` clears and
refills the `Map` — that clear IS the eviction — then
`map.refreshTiles(WALL_SOURCE)` makes the renderer re-ask.

**Three contracts that fail SILENTLY if you get them wrong.** Each is pinned by
a test in `wallProtocol.test.ts` that goes red without the fix:

| # | Contract | Why |
|---|---|---|
| 1 | A miss must **throw with `status === 404`** | The pyramid is deliberately sparse, so misses are the common path. 404 is the only signal that is both silent *and* preserves parent-tile fallback (`SourceCache._loadTile`, maplibre-gl-dev.js:48778-48788 — a non-404 fires an `ErrorEvent`; a 404 calls `this.update()` "to try loading parent/children tiles"). This is exactly Mapbox's old *"return nullish to overzoom the parent"* behaviour. **Do NOT** return `{data: null}` or a zero-byte buffer: legal, throws nothing, and yields a *loaded-blank* tile that BLOCKS the parent fallback and punches holes in the map. |
| 2 | Return `buf.slice(0)`, never the cached buffer | The returned ArrayBuffer is **transferred** to the worker, not copied. Hand back the same cached buffer twice — which happens the moment the user pans away and back — and the second return is a detached 0-byte buffer. Symptom: tiles blank out at random, unreproducibly. MapLibre does this same defensive clone internally (maplibre-gl-dev.js:44218). |
| 3 | The air-gap guard must pass `rtwall://` through | Mapbox's provider *bypassed* `transformRequest`; MapLibre runs it **first**, then dispatches to the protocol handler. Without `rtwall://` in `LOCAL_PREFIXES`, `v4TransformRequest` answers every wall tile with `BLANK_PNG` — PNG bytes into a protobuf parser, the "Unimplemented type: 4" corruption its own comment warns about. LAW 0 still holds: the scheme resolves to main-thread memory and cannot reach the network. |

The MVT bytes must be **uncompressed** — MapLibre throws an explicit
"please make sure the data is not gzipped" if not. `wallTiles.ts` already emits
raw protobuf.

**Considered and rejected:** the `map-gl-offline` and `maplibre-offline-pmtiles`
plugins from MapLibre's plugins page. Both snapshot tiles *from a remote tile
server* into IndexedDB — LAW 0 means there is no remote to snapshot (tiles are
cut on-device from already-downloaded packs), and adopting one would reintroduce
the exact IndexedDB round-trip this design deletes. MapLibre GL JS ships no
offline pack manager; `addProtocol` **is** the offline story. (MapLibre *Native*
for iOS/Android has `MLNOfflinePack` — different product, not applicable.)

### Making it work offline (no signal) — obeying LAW 0

The **downloader** (NOT the map) is the only thing that touches the network: on
the user's volition it makes **one** request to the Worker's `/pack` endpoint for
the area's two tile rings and writes them into IndexedDB. Decode, cut, and render
then happen from that on-device copy — so with no signal it renders identically.

The air-gap guard (`v4TransformRequest` in `getCache_OfflineMap/lib/r2Worker/local_dev/roads/packDownload.ts`) is the
backstop: every tile the map asks for resolves to on-device bytes, and the guard
blocks any stray glyph/sprite/style fetch that isn't local, so a future code change
can't accidentally start streaming into the map.

> **⚠️ The blob-worker URL trap — this cost a whole debug round.** Mapbox's worker
> is constructed from a **Blob**, so its `self.location` is a `blob:` URL. A
> root-relative URL like `/worldBase/base/tiles/6/18/22.pbf` **cannot resolve
> there** — there is no origin to resolve it against, and the failure surfaces as
> a confusing world-base error far from its cause. `v4TransformRequest` therefore
> ABSOLUTISES root-relative URLs (`new URL(url, location.href).href`) before
> handing them back. Do not "simplify" that to returning `{url}` unchanged.

> The earlier **zoom-banded tiered-tile download design** (World-floor / linework /
> big-tile / small-tile buckets at fixed z-ranges) is **retired** — banding by
> zoom violates law 1 (constant presence). Parked in
> [`OFFLINE_HISTORY.md`](./OFFLINE_HISTORY.md) in case the wall-map path ever
> proves insufficient offline.

---

## Layer 3 — cloud bake + supplement (the vision)

This is the part that was only ever in our heads; it lives here now. Three moves,
each independent, all on Cloudflare, all leaving Layer 1 working as a fallback.

### 3a. Bake once in the cloud, not on every phone

Today each phone fetches EOX + Overpass and bakes its own area. Instead: a
**Cloudflare Worker bakes an area once**, stores the finished pieces in R2, and
every phone just **downloads the finished result**. No duplicate work, no
dependence on EOX/Overpass staying up per-device, faster restore. The phone's
on-device bake stays as the offline fallback when the cloud doesn't have an area
yet.

### 3b. Central registry — "don't build or send it twice"

A **cross-user index** in the cloud (the cloud sibling of `v3Registry`) records
which areas are already baked and at what quality. When a phone needs an area, it
asks the registry first:

- **Already baked?** → **download** the finished pieces from R2 into on-device
  storage (the map reads them locally). The phone never re-bakes or re-uploads.
- **New area?** → trigger one cloud bake, register it, then **download** it. The
  next user who wants that ground gets it for free (cross-user dedup).

This is the "decide what to send, handle the overlap, maybe you've already sent
it" idea — a central brain over a shared store.

### 3c. Supplement with better data per area

Because the cloud composes each area, we can **swap in better-than-default data
for specific areas** without changing the phone code:

- **Shore edge — a minor base-map line, done on-device.** A thin
  `natural=coastline` line bakes into each V3 area (~30 km) as part of the base
  map — empty inland, a crisp sea edge on the coast. The cloud could later refine
  it where the OSM line is coarse, but the basic edge ships today.
  (A forest/landcover layer was considered and **rejected** — the satellite photo
  already shows forest, so it's redundant and big. See the source table.)
- **Owned high-res imagery.** Where we have genuinely better aerial/satellite for
  an area, **download** *that* into local storage in place of the default; fall back to the standard photo
  everywhere else. The architecture is identical either way.
  - **Licensing is the only constraint, and it's hard:** Esri/Mapbox/Google
    satellite **Terms of Service forbid** caching/storing/re-hosting their tiles
    for offline use. This is **contractual, not criminal** — but it's a real
    breach (their business is per-load billing), enforced by **API-key revocation
    + account termination**, with breach-of-contract exposure. Mapbox *does* allow
    offline, but only via its own sanctioned mobile SDK (tile caps + their token),
    not by stuffing tiles in our IndexedDB. So the clean version uses **owned or
    openly-licensed** imagery only — OSM/Protomaps (ODbL) + EOX Sentinel-2 (open)
    **explicitly permit** offline storage + redistribution (with attribution).
    Same pipeline, just a sourcing line we don't cross.

---

## Data sources — kept deliberately small

A tight set of sources is the win; don't drown the area in layers. The honest
grouping — these are **different kinds of thing**, not equal options:

**A. The four we have (core — done, working, don't touch):**

| Layer | Provider | Licence | Format |
|-------|----------|---------|--------|
| Satellite photo | EOX (Sentinel-2 cloudless) | open | raster `image` |
| Roads | OpenStreetMap / Overpass | ODbL | GeoJSON lines |
| Water (rivers/lakes) | OpenStreetMap / Overpass | ODbL | GeoJSON lines |
| Coastline edge (ocean only) | OpenStreetMap / Overpass (`natural=coastline`) | ODbL | GeoJSON lines |

The coastline is **just one thin ocean-shore edge line** (a few KB), baked
on-device (v3 vectors `-v7`, ~30 km), that snaps the sea edge crisp where the
satellite is coarse. **It is NOT the base map** — that's the Protomaps land vector
in B below. It's empty for inland areas (`natural=coastline` is sea-only; lakes
are water polygons). A minor edge, not the foundation.

**B. The base map (the land foundation under everything):**
The **Protomaps planet** `.pmtiles` (ODbL) IS **the base map** — the full dark
vector map of **land, roads, water, landuse, buildings and places** (what Mapbox
calls a base map; it is **NOT** a "coast" — a base map is mostly land). On the
user's volition the downloader pulls the area's slice into on-device storage and
the map reads the **local** copy (PMTiles, native to Mapbox ≥ 3.24.0). On V4
(`/offline`).

**C. Rejected / parked (and why):**
- **Forest / landcover** (ESA WorldCover, OSM landuse) — **rejected.** The
  satellite photo *already shows the forest* — a green landcover layer is
  redundant with the photo and, as a raster, **big**. Fails the keep-it-small
  rule. Don't add it.
- **Owned high-res imagery** — not an *addition*; it's a *replacement* for the
  satellite where we own something sharper. Same slot, better photo. Later.
- **Terrain / contours** — brainstorm only. We don't need it. Cut.

The discipline: a layer earns its place only if it's **small AND shows something
the satellite photo can't.** Coastline passed (crisp edge, few KB) and now ships;
forest fails (redundant with the photo, big), so it stays out. An enriched area is
a **satellite photo over a vector base map (roads + water)** and stops there. Open-licence only;
colours are the **user's**, never tint without asking
([[dont-change-colours-without-permission]]).

---

## Staged rollout — small steps, never break Layer 1

The working device map is the floor. Every cloud step is additive, flag-gated,
and reversible. Suggested order (each a shippable stage on its own):

1. **Move the wall map's source to owned R2.** ✅ Done. The owned `ontario.pmtiles`
   lives on Cloudflare R2 and the phone downloads each area's tile disc in one request
   to the `offline-tiles` Worker's `/pack` endpoint (no Protomaps dependency, no
   expiry). Layer 2 obeys LAW 0 throughout (the map renders in-memory GeoJSON; only
   the downloader hits the network). (Layer 1 untouched.)
2. **Cloud read-through for Layer 1.** Before the phone bakes an area, ask the
   cloud registry; if it's there, download instead of baking. Phone bake stays as
   fallback. (§3a + §3b, read path only.)
3. **Cloud bake-on-miss.** When the registry has no area, the Worker bakes +
   registers it. (§3a write path.)
4. **(later) Sharper base-map detail.** The base map ships on-device today; the
   cloud can later refine thin edges (e.g. the sea shore) where OSM is coarse. (§3c.)
5. **(later) High-res supplement** for hand-picked areas — a *replacement* for
   the satellite, not a new layer. (§3c, owned imagery.)

Rule: **a cloud layer never deletes or rewrites the device path** until it has
fully replaced it in production behind a flag. If the cloud is unreachable, the
phone still bakes and the map still works.

---

## What's built vs what's next

- **Built + shipping:** the Layer 1 engine (satellite + registry, reconcile,
  budget/eviction, the `/debug/blobs` console) ships **inside `/offline`**
  and now *lives* in `getCache_OfflineMap/lib/onPhone/` too — `satellite/satelliteImage.ts`,
  `store/coverageRegistry.ts`, `satellite/satBakeWorker.ts`. The standalone `/offlinev3`
  route and the `offlineV3/` folder are both gone; there is ONE offline engine.
- **Working:** Layer 2 — the `/offline` **wall map** (`getCache_OfflineMap/lib/r2Worker/local_dev/roads/packDownload.ts`):
  each anchor downloads ONE 30 km disc saved at EVERY zoom (`roadBlob.ts`
  `BLOB_ZOOMS`) from the owned R2 archive via the `offline-tiles` Worker's
  `/pack` endpoint, and stores the raw MVT in IndexedDB. LAW 0 intact — the
  tiles never leave the device and the map never streams. **Satellite photo and
  the jagged frontier ARE on this route** (`getCache_OfflineMap/lib/onPhone/satellite/satelliteImage.ts`).
  VERIFIED 2026-08-18 in a clean browser: 4,373 tiles / 5.6 MB in 367 ms, roads
  painting from `rtraw://`, ~58 MB heap, and the ONLY remote request the
  downloader's own `/pack` call.
- **Done:** the decode/re-cut pipeline is **DELETED**, not merely bypassed.
  `wallTiles` / `wallFinish` / `wallProtocol` / `v4Decode` / `v4DecodeWorker` /
  `v4WallMapCache` are gone (~2,700 lines). Raw tiles reach the renderer through
  MapLibre `addProtocol` straight from IndexedDB — no parse, no merge, no cut,
  and nothing to invalidate when new tiles land.
- **Next:** everything in [`TODO.md`](../../ReTreever/src/lib/mobile/docs/TODO.md) under the offline section.
- **Reusable now (rule 3 — no blink):** the PDF import path renders a raw local
  raster instantly, then swaps in the optimized server WebP via
  `mobMapOverlay.swapMapOverlayImage` (Mapbox `updateImage`) — gap-free, the same
  no-blink discipline as the placeholder→detail swap. Planned overlay tiling
  (N×N quadrants, `MAP_IMPORTS_UNIFIED.md` (retired 28 Aug 2026) §3.1) is a
  client-side sibling of Layer 1's masked photo; offline overlay coverage can
  mount the same tiles.

---

## Do-nots (settled)

- **Don't convert the ONLINE map to MapLibre, and don't convert this route back
  to Mapbox.** The split is deliberate and each side needs what it has: the
  online map uses globe projection / `setTerrain` / `setFog` / `mapbox://`
  styles, none of which MapLibre has; this route needs `addProtocol`, which
  Mapbox has not got. `typeof mapboxgl.addProtocol === "undefined"` on 3.24.0 —
  it is a MapLibre API, and calling it on Mapbox fails as a **silent no-op**
  (the map renders nothing, with no error). That trap is real; it is just no
  longer relevant here, because this route no longer runs on Mapbox.
- **Don't put a Mapbox `Marker`/`Popup`/control on the MapLibre map, or vice
  versa.** It does not fail politely: `new mapboxgl.Marker().addTo(maplibreMap)`
  throws `TypeError: e2._addMarker is not a function` from inside Mapbox's own
  `addTo`, and the map renders **black**. Worse when it does NOT throw — a Popup
  from the wrong library gets the other namespace's DOM classes, so its
  close-button wiring finds nothing and none of its CSS applies, silently. Ask
  the live instance which library built it: `$lib/mobile/map/rendererOf.ts`.
- **Don't add a `mapboxgl-*` CSS selector without its `maplibregl-*` twin.**
  MapLibre emits zero `mapboxgl-` classes, so a mapbox-only selector silently
  stops matching on this route — and the map still renders, so a smoke test
  passes; only the controls are unstyled and in the wrong corner.
- **No serving the PLANET `.pmtiles` pyramid to the map** — the planet's low-zoom
  tiles drop minor features, so zooming pops them in/out (breaks Law 1). Our OWN
  z6–z14 cut is fine and is what ships: every level carries every feature.
  The rule is about *lossy* pyramids, not about tiles. ([[offline-map-laws]])
- **No `geojson` source for the wall map, ever again.** It re-parses and re-indexes
  the whole dataset on every `setData` and retains the index for the source's
  lifetime, inside Mapbox's worker where `performance.memory` cannot see it. This
  cost 800–1200 MB. Two remaining `geojson` sources on the route are legitimate and
  tiny (selection highlight, coverage overlay) — they hold a handful of features.
- **No tile pyramid for the satellite** — it swaps tiles + vanishes below its min
  zoom, the exact bugs we escaped.
- **No zoom-culling** — a downloaded area is visible identically at every zoom
  ([[offline-map-constant-presence-no-zoom-culling]]).
- **Jagged frontier stays raw** — never smooth/mask the tile-edge boundary
  ([[offline-map-no-smoothing-jagged-boundary]]).
- **Colours are the user's** — never invent/tune a hex
  ([[dont-change-colours-without-permission]]).
- **No caching provider satellite** (Esri/Mapbox/Google) for offline — their ToS
  forbid storing tiles offline (contractual, enforced by key revocation; Mapbox
  offline is allowed only via its own SDK). Owned/open data only — OSM/Protomaps
  (ODbL) + EOX (open) **permit** offline storage, which is exactly why we use them.

---

## Appendix A — the owned-archive + pack Worker (live)

V4's tiles are an **owned** `.pmtiles` extract on **Cloudflare R2** (R2 has `$0`
egress; ~2 GB storage ≈ pennies/mo, reads under free tiers), served to the phone by
the `offline-tiles` Worker. The phone makes **one** `/pack?lng=&lat=` request per
area; the Worker computes the two rings, reads every tile from R2 via its binding, and
returns them packed in one blob (then edge-caches it — repeat hits on the same area
are ~0.15s). This replaced the phone reading the archive tile-by-tile. Worker source
+ deploy + cost notes:
`/Users/chrisharris/DEV/fetch/ReTreever/workers/offline-tiles/` (`README.md`).
The source is whole-world `planet.pmtiles`; changing the rings = keep `RINGS`
matched on both sides (client + Worker).

---

## Cross-links

- Earlier approaches (deprecated, the history footnote): [`OFFLINE_HISTORY.md`](./OFFLINE_HISTORY.md)
- **The fire layer — v2 spec + cutover:** [`WILDFIRE_LAYER_V2.md`](../routes/fires/docs/WILDFIRE_LAYER_V2.md)
  (v1, still what runs: [`WILDFIRE_LAYER.md`](../routes/fires/docs/WILDFIRE_LAYER.md); the data
  sources: [`fireAPIs.md`](../routes/fires/docs/fireAPIs.md))
- Measured memory receipts for this route: [`../offline/MEMORY_FINDINGS.md`](../../ReTreever/src/lib/mobile/offline/MEMORY_FINDINGS.md)
- Import pipeline this reuses: `MAP_IMPORTS_UNIFIED.md` (retired 28 Aug 2026)
- Forward work: [`TODO.md`](../../ReTreever/src/lib/mobile/docs/TODO.md)
- Memories: `offline-blob-naming-and-model`, `offline-download-guard`,
  `offline-map-constant-presence-no-zoom-culling`,
  `offline-map-no-smoothing-jagged-boundary`, `mapbox-pmtiles-not-supported`,
  `big-map-storage-split`, `offline-hydrology-design`,
  `vector-source-layer-name-must-match`, `no-silent-fallbacks`.
