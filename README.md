# Get Cache offline map — handoff

**Watch first:** https://youtu.be/ksRR6UpchDc

## Setup

```bash
npm create @retreever/rapper@latest rapper --min-release-age=0 -- --offline
cd rapper && npm run dev
```

That gives you the offline map at `http://localhost:5173/offline` (`/` lands
there too — see `hooks.ts`). **There is no `/offline/debug` any more:** the
debug rails are a toggle on the map itself (the `debug` switch in the card at
the top), not a second URL. One view, one address.

The Cloudflare Worker that serves tiles lives in this repo at `worker/`. To run
it locally: `cd worker && ./setupLocalTiles.sh && npx wrangler dev`, then pick
the `local` tier in the map's worker switch (`lib/r2Worker/TIERS.md`).

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
| Fires Worker half | `lib/r2Worker/firesWorker.ts` — `worker/src/index.ts` imports it relatively; the whole Worker moved into this repo the same day |
| Offline map docs (plan, spec, history, tree target) | `docs/` — start at `docs/README.md` |
| Fires docs | `routes/fires/docs/` (`WILDFIRE_LAYER*.md`, `fireAPIs.md`, `FIRES_V2_ROUTE_PREP.md`) |
| Fire assets | `fire_icon.webp`, `fire_intensity/` — listed in `ASSETS.md`, fetched by `fetchAssets.sh` |
| `assetRegion`, `anchors` | `lib/shared/` |
| Places index + reference | `lib/places/` |
| `mapKeepOut`, `rendererOf`, `pinDrift` | `lib/shared/` |
| `MapPopoverShell`, `mapPopoverGeom`, `measureFormat` | `lib/panels/` |
| `mapboxErrorCapture` | `lib/shared/` |
| `ensureMapboxGuards` | `lib/shared/` — imports OnlineMap's `safeMarker` through the declared pair below |

The parent reaches all of it as `$parent/siblings/getCache_OfflineMap/...`.

**Map UI and map state — moved 28 Aug 2026, behind `ports`:**

| What | Where it is now |
|---|---|
| `MapLegend`, `SnakeRuler`, `DrawPalette`, `SelfCoordPill`, `TrackingStrip`, `MapTopControls`, `FeatureMapPopover`, `PlotMapPopoverV2` | `lib/mapUi/` |
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

## Standing rules

1. **ONE COPY.** Move files, don't copy them. The same thing in both repos is
   the problem this project spent a day removing.

2. **THE HOST COMES IN AS A PROP.** This repo never imports `$lib`, never
   names a parent (`lib/noParentNames.test.ts`), never climbs out of itself.
   Two doors: `lib/shared/hostPorts.ts` (data for the engine) and
   `lib/shared/mapHostPorts.ts` (store, icons, share sheet, GPS, q704 for the
   map UI). Add a member the day a file needs it; the host's assignment to the
   type is the check.

3. **THE ALIAS IS THE MECHANISM.** Never a raw `../` climb (the guard throws
   during build), never a symlink.

## Known broken — pick any of these up

1. **LOCAL WORKER SERVES ITALY.** `worker/setupLocalTiles.sh`
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
   `setCoverageMirror`, `parseCellKey`, `tileHoldsRadius`, `idbDeleteMany`,
   `offlineDownloadGateStats`, `wallLabelLayers` (~300 lines). Wire or delete.
   (`retryFailedBakes` was on this list; ReTreever's BlobInspector calls it now.)

6. **FIRES IS A NO-OP.** The Fires switch renders and clicks but its `ids`
   array is empty (`lib/onPhone/render/wallLegend.ts`) — no `v4-fire*` layer is
   mounted. All the fires code is in `routes/fires/` now; what is missing is
   `attachFireLayer()` connecting it to the map. Real work, not a config change.
   Done = that switch turns real fire features on and off.

7. **THE MAP UI HAS NO HOST HERE.** `lib/mapUi/` and `lib/mapState/` (legend,
   ruler, pins, overlays, tracking…) arrived 28 Aug 2026 behind
   `mapHostPorts.ts`, and nothing in this repo mounts them — only ReTreever
   does, through `retreeverMapPorts.ts`. Unverified in a browser since the
   move. Five of them also import `getCache_OnlineMap` (a declared pair), so
   they need that sibling checked out beside this one.

## Test baseline — what red is NORMAL

`npm test` here: 10 failures are known and predate the handoff. Anything else
is yours.

- `routes/fires/fireCache.test.ts` ×2 — perf assertions (trig-call counts)
- `routes/fires/v2/fireCostV2.test.ts` ×4 — v2 render layer not landed
- `lib/noParentNames.test.ts` — 5 old hits: `grid.lockstep.test.ts`,
  `v4CloudflareTiles.test.ts` ×2, `routes/+layout.svelte` ×2
- `lastMapRoute`, `overlayRenderCacheKey`, `bakeService`, `debugReport` —
  `$state is not defined`: this repo's bare vitest has no Svelte plugin, so
  rune files only run under a parent's suite
- `urbanExclusion` SKIPS until `./fetchAssets.sh` has run (needs `worldBase/`)

## How to verify anything

**Load it in a browser and look.** Not the terminal, not a test — the screen.
A test passing while the page rendered nothing happened repeatedly here.

`?at=58.7986,-122.6761&z=11` on `/offline` jumps the camera to a coordinate
(lat first, the order a human reads one off a screen).

If the console looks empty, check DevTools' **"Custom levels"** filter — it
hides `console.log` by default, and hid 3,397 messages during the day
mentioned above.
