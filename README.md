# Get Cache offline map — handoff

**Watch first:** https://youtu.be/ksRR6UpchDc

## Day one

```bash
npm create -y @retreever/rapper@latest <folder> -- --child offline
cd <folder> && npm install && npm run dev
```

That git-clones this repo beside a copied `rapper/` and writes `rapper/.env`
(`VITE_TILES_HOST=https://tiles-prod.getcache.org` + `VITE_TILES_DEV_HOST`).
The ~50 MB basemap ships in this repo (`mobileAssets/`, proprietary — see
`mobileAssets/LICENSE.md`); the first `npm run dev` copies it into place.
No key, no account, no npm login. `getCache_OfflineMap/` is a real clone:
edit, branch, push and open PRs from inside it.

**You are set up when:** `http://localhost:5174/offline` (the port is
rapper's `package.json` `dev` script) shows the map, you drop a pin near
Ottawa (`?at=45.42,-75.70&z=11`), and roads appear inside the circle within a
minute. If the satellite photo appears but roads never do, `rapper/.env` is
missing or wrong — the console says so on the first line
(`VITE_TILES_HOST is not set`).

`/` lands on the offline map too — see `hooks.ts`. The debug rails are a
toggle on the map itself, not a second URL. One view, one address.

The Cloudflare Worker that serves tiles lives in this repo at `worker/`. To
run it locally: `cd worker && npm run dev:local`, then pick the `local_dev`
tier in the map's CONFIG panel (`lib/r2Worker/README.md`).

Repos:

- https://github.com/Ground-Truth-Data/rapper
- https://github.com/Ground-Truth-Data/getCache_offlineMap

## What this is

An offline map. It downloads map tiles and satellite photos for areas around
pins, stores them in the browser's IndexedDB, and renders them (MapLibre GL)
with no network. Tiles come from a Cloudflare Worker; satellite photos from
EOX Sentinel-2.

**The debugger IS the map.** Same component, one `cards` prop, panels beside it.
Instruments attached to a stand-in produce confident wrong answers.

## Where the data comes from

| Layer | Source | Always on? | Radius per pin |
|---|---|---|---|
| Vector roads — plus water, town labels, hospital/campsite POIs, all in the same blob | One Cloudflare R2 bucket (`offline-tiles`) holding a full-planet OpenStreetMap extract (`planet.pmtiles`); the Worker in `worker/` range-reads it and serves one `/pack` blob per pin | yes | 30 km (`lib/contract/grid.ts`) |
| Satellite photo | EOX Sentinel-2 cloudless (public WMTS, no key, ~10 m/px), baked on the phone | yes | 2 km per photo; photos along a line overlap into a ribbon (`lib/onPhone/satellite/satelliteImage.ts`) |
| Fires | NASA FIRMS — VIIRS on NOAA-20, NOAA-21 and Suomi-NPP, last 48 h, proxied through the same Worker's `/fires` route so the API key stays a Worker secret | **not yet** — fetch/store runs, render is Known broken #6 | 500 km (`lib/shared/fireContract.ts`) |

Everything lands in IndexedDB under a 1 GB budget (`OFFLINE_BUDGET_BYTES`)
and renders with no network.

## The blobs — what good looks like

A blob is the jagged disc of data around a pin: satellite photo at the
centre, vector roads out to the edge. The bar, in order:

1. **Always on.** Nothing appears or disappears as you zoom. One radius, one
   packed zoom level (overzoomed above it) — a second radius was tried three
   times and always reads as a phantom shape (`lib/contract/roadBlob.ts`).
2. **Arrive fast.** The dl badge is a stopwatch from *asked* to *painted on
   screen* — that number is the score, never bytes on disk or an open port.
3. **Render fast, stay small in RAM.** Speed vs memory is the standing
   trade-off: pack only the layers worth their bytes (~92 kB of water, labels
   and POIs on a 445 kB roads blob — measured in `lib/contract/packLayers.ts`),
   hand the renderer URLs instead of live object graphs, and drop parsed data
   the moment it is stored.

## THE ONE RULE

There is ONE offline map component:

```
getCache_OfflineMap/lib/OfflineMapPage.svelte
```

Everything renders THAT FILE. Not a copy, not a "shared base", not a wrapper
with logic in it. Reach it through the `$parent` alias:

```ts
import OfflineMap from "$parent/siblings/getCache_OfflineMap/lib/OfflineMapPage.svelte";
```

A route file is a mount: the import and `<OfflineMap />`. Map code outside
that component is the bug this project spent a day removing.

**Do NOT use a symlink.** SvelteKit follows it, but the child's internal
relative imports then trip rapper's `noEscapePlugin` guard. The alias is the
one mechanism.

## Where things are

All map code belongs in THIS repo. Not in ReTreever, not split across both.
"Offline map" is a narrow name for a folder that also holds fires, hospitals
and places — deliberate: this repo has the debugger, so code here can be
watched while it runs. Do not propose renaming it or a second "shared map" repo.

| What | Where |
|---|---|
| The map component | `lib/OfflineMapPage.svelte` |
| Fires engine (v1 + v2 + masks) | `routes/fires/` — read `routes/fires/docs/FIRES.md` before touching v2 |
| Fires Worker half | `lib/r2Worker/firesWorker.ts` — `worker/src/index.ts` imports it relatively |
| Tile Worker (Cloudflare, R2) | `worker/` — `worker/README.md` |
| Worker client (tiers, `/pack` download, fires fetch) | `lib/r2Worker/` — `lib/r2Worker/README.md` |
| Offline map docs (plan, spec, history) | `docs/` — start at `docs/README.md` |
| Fires docs | `routes/fires/docs/` |
| Map assets (basemap, pins, `fire_icon.webp`, `fire_intensity/`) | `mobileAssets/` (committed, proprietary — `mobileAssets/LICENSE.md`); `fetchAssets.sh` copies it to the serving dir |
| Storage, bake service, renderer, roads, satellite | `lib/onPhone/` |
| Tile contract (byte-identical to `workers/local_dev/src/`) | `lib/contract/` |
| `assetRegion`, `anchors`, `mapKeepOut`, `rendererOf`, `pinDrift`, `ensureMapboxGuards` | `lib/shared/` |
| Places index + reference | `lib/places/` |
| `MapPopoverShell`, `mapPopoverGeom`, `measureFormat`, the debug panels | `lib/panels/` |
| `MapLegend`, `SnakeRuler`, `DrawPalette`, `SelfCoordPill`, `TrackingStrip`, `MapTopControls`, `FeatureMapPopover`, `PlotMapPopoverV2` | `lib/mapUi/` |
| `mapViewport`, `lastMapRoute`, `onlineMapHitchState`, `overlayVisibility`, `overlayOpacity`, `mapFraming`, `overlayManager`, `pinMarkers`, `vertexDrag`, `tracking`, `userLocation` | `lib/mapState/` |
| Engine door — `HostPorts` | `lib/shared/hostPorts.ts` — ReTreever's implementation: `ReTreever/src/lib/mobile/offline/host/retreeverPorts.ts` |
| Map-UI door — `MapHostPorts { store, ui, gps, scenes?, q704? }` | `lib/shared/mapHostPorts.ts` — ReTreever's implementation: `ReTreever/src/lib/mobile/offline/host/retreeverMapPorts.ts` |

The parent reaches all of it as `$parent/siblings/getCache_OfflineMap/...`.

Every `lib/mapUi` component takes a required `ports: MapHostPorts` prop; every
store factory that needs the host takes it as a parameter
(`createOverlayManager(getMap, store, ports)`, `createUserLocator(getMap,
onDotTap, ports)`, `PinMarkersDeps.ports`, `tracking.start(store, name)`).
ReTreever's real `MapStore` is ASSIGNED to `MapHostStore` in
`retreeverMapPorts.ts` — that assignment is the type-check at the boundary.

**The one thing still in ReTreever on purpose:** `mapStore.svelte.ts` — it IS
the database (TinyBase, the snapshot uploader, the schema, the importers). It
comes in as `ports.store`.

**Declared pair:** this child imports `getCache_OnlineMap` (mapDraw, areaLabels,
safeMap, coord, safeMarker, …) — listed in `deps.json` and in ReTreever's
`childBoundary.test.ts` `DECLARED_CHILD_DEPS`, so the offline child ships WITH
the online child.

## Standing rules

1. **ONE COPY.** Move files, don't copy them.
2. **THE HOST COMES IN AS A PROP.** This repo never imports `$lib`, never
   names a parent (`lib/noParentNames.test.ts`), never climbs out of itself.
   Two doors: `lib/shared/hostPorts.ts` (data for the engine) and
   `lib/shared/mapHostPorts.ts` (store, icons, share sheet, GPS, q704 for the
   map UI). Add a member the day a file needs it.
3. **THE ALIAS IS THE MECHANISM.** Never a raw `../` climb (rapper's
   `noEscapePlugin` throws during build), never a symlink.

## Known broken — pick any of these up

1. **LOCAL WORKER SERVES ITALY.** `worker/setupLocalTiles.sh` seeds the local
   R2 with a Florence sample archive, so the `local_dev` tier returns empty
   packs for every North American pin. Replace with a Canadian extract.

2. **AN EMPTY ANSWER LOOKS LIKE SUCCESS.** The Worker returns HTTP 200 with an
   empty pack when it has nothing. A miss is indistinguishable from a hit at
   every layer above. Make it error.

3. **NO PROGRESS DURING A BAKE.** ~8 s per area, ~39 areas — about 5 minutes of
   black rectangle. "Still downloading" and "broken" look identical.

4. **COVERAGE NEVER EVICTS BELOW 1 GB** (`OFFLINE_BUDGET_BYTES`), and stores
   no pin or map identity — areas from deleted pins accumulate forever and are
   unattributable. A real session showed 392 areas across the continent while
   the map was over Ontario.

5. **DEAD EXPORTS.** Written, exported, never called: `setCoverageMirror`,
   `parseCellKey`, `tileHoldsRadius`, `idbDeleteMany`,
   `offlineDownloadGateStats`, `wallLabelLayers`, and the whole of
   `lib/shared/mapboxErrorCapture.ts`. Wire or delete.

6. **FIRES RENDER IS A NO-OP.** The Fires switch renders and clicks but its
   `ids` array is empty (`lib/onPhone/render/wallLegend.ts`) — no fire layer is
   mounted, so the CONFIG row shows dead with a "not yet" tag. The fetch/store
   half runs (`FIRE_REFRESH_ENABLED = true` in `lib/shared/bakeFlags.ts`), and
   `routes/fires/v2/fireLayerV2.ts` exists but nothing imports it yet. Also:
   the Worker's `/fires` route needs a NASA FIRMS Area API key (a Worker
   secret; free at firms.modaps.eosdis.nasa.gov) — the local_dev sample setup
   ships none, so expect `/fires` to fail until you add one with
   `wrangler secret put`. Done = that switch turns real fire features on and
   off. Hospitals and Places are NOT in this bucket — they already ride in the
   `/pack` blob per pin (see `lib/contract/packLayers.ts`); a row reading
   "dl Ns · 0 in view" means the download worked and the area simply has none.

7. **THE WORKER TRUSTS EVERYONE.** Every request to `tiles-prod` is anonymous —
   the app has no more standing than a stranger's `curl`, so a third party
   could build their own service on the tile Worker. Add a shared token: the
   client sends a header read from `rapper/.env` (beside `VITE_TILES_HOST`),
   the Worker rejects requests without it. The token ships in a public web
   bundle, so this is a fence, not a lock — the win is rotation: change the
   token and freeloaders go dark while the app updates. Build and test it
   against `local_dev`; no Cloudflare account needed.

8. **THE MAP UI HAS NO HOST HERE.** Nothing in this repo mounts `lib/mapUi/` or
   `lib/mapState/` — only ReTreever does, through `retreeverMapPorts.ts`. Five
   of them (`SnakeRuler`, `userLocation`, `vertexDrag`, `overlayManager`,
   `pinMarkers`) import `getCache_OnlineMap`, so they need that sibling
   checked out beside this one.

## Test baseline — what red is NORMAL

`npm test` here (31 Aug 2026): 4 files / 27 tests fail, 41 skip. Anything
else is yours.

- `lib/onPhone/bake/bakeService.test.ts` ×25, `lib/mapState/lastMapRoute.svelte.test.ts`,
  `lib/mapState/overlayRenderCacheKey.test.ts` — `$state is not defined`: this
  repo's bare vitest has no Svelte plugin, so rune files only run under a
  parent's suite
- `lib/onPhone/offlineDownloadGate.test.ts` ×2 — prompt-count assertions
- `routes/fires/masks/urbanExclusion.test.ts` SKIPS until `./fetchAssets.sh`
  has run (needs `static/mobileAssets/worldBase/`)

## How to verify anything

**Load it in a browser and look.** Not the terminal, not a test — the screen.
A test passing while the page rendered nothing happened repeatedly here.

`?at=58.7986,-122.6761&z=11` on `/offline` jumps the camera to a coordinate
(lat first, the order a human reads one off a screen).

If the console looks empty, check DevTools' **"Custom levels"** filter — it
hides `console.log` by default.
