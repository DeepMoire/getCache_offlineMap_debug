# Get Cache offline map — handoff

**Watch first:** https://youtu.be/ksRR6UpchDc

## Setup

```bash
npm create @retreever/rapper@latest rapper --min-release-age=0 -- --offline
cd rapper && npm run dev
```

That gives you the offline map at `http://localhost:5173/offline` and the same
map with debug panels at `/offline/debug`.

Repos:

- https://github.com/Ground-Truth-Data/rapper
- https://github.com/Ground-Truth-Data/getCache_offlineMap

## What this is

An offline map. It downloads map tiles and satellite photos for areas around
pins, stores them in the browser's IndexedDB, and renders them with no network.
Tiles come from a Cloudflare Worker; satellite photos from EOX Sentinel-2.

**The debugger IS the map.** Same component, one `cards` prop, panels beside it.
That matters: instruments attached to a stand-in produce confident wrong
answers, which is exactly how a full day was lost on 27 Aug 2026.

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

If you find yourself writing map code outside that component, stop — you are
recreating the bug this project spent a day removing. A route file is TWO
LINES: the import and `<OfflineMap />`.

**Do NOT use a symlink.** Tried and rejected 27 Aug 2026: SvelteKit follows it,
but the child's internal relative imports then trip the workspace's
`noEscapeHatch` guard. The alias is the one mechanism.

## Where map code lives

All map code belongs in THIS repo. Not in ReTreever, not split across both.

Yes, "offline map" is a narrow name for a folder that also holds fires,
hospitals and places. That is deliberate — this repo has the debugger, and code
that lives here can be watched while it runs. The name is worth less than
having one place. Do not propose renaming it or creating a second "shared map"
repo.

**Migrated 28 Aug 2026 — where each thing lives now:**

| What | Where it is now |
|---|---|
| Fires engine (27 files, v1 + v2 + masks) | `routes/fires/` |
| Fires Worker half | `lib/r2Worker/firesWorker.ts` — `ReTreever/workers/offline-tiles` imports it back through a wrangler `[alias]`, never a `../` climb |
| Offline map docs (plan, spec, history, tree target) | `docs/` — start at `docs/README.md` |
| Fires docs | `routes/fires/docs/` (`WILDFIRE_LAYER*.md`, `fireAPIs.md`, `FIRES_V2_ROUTE_PREP.md`) |
| Fire assets | `fire_icon.webp`, `fire_intensity/` — listed in `ASSETS.md`, fetched by `fetchAssets.sh` |
| `assetRegion`, `anchors` | `lib/shared/` |
| Places index + reference | `lib/places/` |
| `mapKeepOut`, `rendererOf`, `pinDrift` | `lib/shared/` |
| `MapPopoverShell`, `mapPopoverGeom`, `measureFormat` | `lib/panels/` |
| `mapboxErrorCapture` | `lib/shared/` |
| `ensureMapboxGuards` | `getCache_OnlineMap/lib/` — it imports OnlineMap's `safeMarker`, and a child may not import another child |

The parent reaches all of it as `$parent/siblings/getCache_OfflineMap/...`.

**Map UI and map state — moved 28 Aug 2026, behind `ports`:**

| What | Where it is now |
|---|---|
| `MapLegend`, `SnakeRuler`, `DrawPalette`, `SelfCoordPill`, `TrackingStrip`, `MapTopControls`, `FeatureMapPopover`, `PlotMapPopoverV2`, `HostPillDock` (+ its two tests) | `lib/mapUi/` |
| `mapViewport`, `lastMapRoute`, `onlineMapHitchState`, `overlayVisibility`, `overlayOpacity`, `mapFraming`, `overlayManager`, `pinMarkers`, `vertexDrag`, `tracking`, `userLocation` (+ tests) | `lib/mapState/` |
| **The contract** — `MapHostPorts { store, ui, gps, scenes?, tier?, q704? }` | `lib/shared/mapHostPorts.ts` |
| ReTreever's implementation of it | `ReTreever/src/lib/mobile/offline/host/retreeverMapPorts.ts` |

Every component takes a required `ports: MapHostPorts` prop; every store
factory that needs the host takes it as a parameter (`createOverlayManager(getMap,
store, ports)`, `createUserLocator(getMap, onDotTap, ports)`, `PinMarkersDeps.ports`,
`tracking.start(store, name)`). The host's real `MapStore` is ASSIGNED to
`MapHostStore` in retreeverMapPorts.ts — that assignment is the type-check at
the boundary, and it already caught one wrong guess (`OverlayLabel`'s shape).

**The one thing still in ReTreever on purpose:** `mapStore.svelte.ts` (2,570
lines) — it IS the database (TinyBase, the snapshot uploader, the schema, 30
importers across inbox/import/q704). It comes in as `ports.store`.

**Declared pair:** this child imports `getCache_OnlineMap` (mapDraw, areaLabels,
safeMap, coord, safeMarker) — stated in ReTreever's `childBoundary.test.ts`
`DECLARED_CHILD_DEPS`, so the offline child ships WITH the online child.

Read `routes/fires/v2/BISECT_STATE.md` before touching v2; it says why v2 is
held back. `routes/fires/docs/FIRES_V2_ROUTE_PREP.md` is the wiring plan.

The online map is the harder one — audit and report before moving anything.
`MapDrawControls.svelte` alone is 1,659 lines and imports the database, so it
probably cannot cross and needs a different answer.

## Rules for the migration

1. **ONE COPY.** Move files, don't copy them. The same thing in both repos is
   the problem this project spent a day removing.

2. **PROPRIETARY STAYS.** Mobile business logic, storage (TinyBase/mapStore),
   API calls and auth stay in `ReTreever/src/`. `childBoundary.test.ts` fails
   the build if a child imports `$lib`. Host data comes in as a PROP —
   `hostPorts` is the existing seam and is type-checked at the boundary.

3. **THE ALIAS IS THE MECHANISM.** Never a raw `../` climb (the guard throws
   during build), never a symlink.

## Known broken — pick any of these up

1. **LOCAL WORKER SERVES ITALY.** `workers/offline-tiles/setupLocalTiles.sh`
   seeds the local R2 with a Florence sample archive, so the `local_dev` tier
   returns empty 200s for every North American pin. Replace with a Canadian
   extract.

2. **AN EMPTY ANSWER LOOKS LIKE SUCCESS.** The Worker returns HTTP 200 with
   `roadsBytes=0` when it has nothing. A miss is indistinguishable from a hit
   at every layer above. Make it error.

3. **NO PROGRESS DURING A BAKE.** ~8 s per area, ~39 areas — about 5 minutes of
   black rectangle. "Still downloading" and "broken" look identical.

4. **COVERAGE NEVER EVICTS BELOW 1 GB**, and stores no pin or map identity — so
   areas from deleted pins accumulate forever and are unattributable. A real
   session showed 392 areas across the continent while the map was over Ontario.

5. **DEAD EXPORTS.** Written, exported, documented, never called:
   `retryFailedBakes` (the documented "heal everything" button — no UI calls
   it), `setCoverageMirror`, `parseCellKey`, `tileHoldsRadius`, `idbDeleteMany`,
   `offlineDownloadGateStats`, `wallLabelLayers` (~300 lines). Wire or delete.

6. **LABELS LOOK SWAPPED.** In `lib/onPhone/render/wallLegend.ts` the row
   labelled "Places" toggles `v4-poi-hospital` and the row labelled "Hospitals"
   toggles `v4-poi-camp`. Confirm with Chris before changing.

7. **FIRES IS A NO-OP.** The Fires switch renders and clicks but its `ids`
   array is empty — no `v4-fire*` layer is mounted on this route. Wiring
   `attachFireLayer()` is real work, not a config change. This is also what
   "done" looks like for the fires migration: the code lives here AND that
   switch turns real fire features on and off.

## How to verify anything

**Load it in a browser and look.** Not the terminal, not a test — the screen.
A test passing while the page rendered nothing happened repeatedly here.

`?at=58.7986,-122.6761&z=11` on either route jumps the camera to a coordinate
(lat first, the order a human reads one off a screen).

If the console looks empty, check DevTools' **"Custom levels"** filter — it
hides `console.log` by default, and hid 3,397 messages during the day
mentioned above.
