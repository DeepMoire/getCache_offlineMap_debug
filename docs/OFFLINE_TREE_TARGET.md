# Offline map — where the problem is

## The one line

`getCache_OfflineMap/lib/contract/grid.ts:79`
`workers/offline-tiles/src/grid.ts:79`   ← same line, same number, on purpose
(`src/lib/mobile/offline/contract/grid.ts` is now only an 8-line re-export shim
pointing at the child copy above.)

```ts
export const BLOB_TILE_Z = 8;
```

At latitude 45:

| | tile width |
|---|---|
| z8 (what we ship) | **110.7 km** |
| the radius we promise | 30 km (60 km across) |
| z13 (what we used to ship) | 3.5 km |

**One tile is nearly 2x wider than the entire area a user asks for.**

## What that causes

1. **Two pins share one tile address.** Pins 30 km apart land in the same
   `z/x/y`, so the second overwrites the first. On screen: drop a second pin
   and the first one's roads vanish.
2. **The workaround made it worse.** Keys became
   `pin/<lng>,<lat>/z/x/y` so pins stop colliding — but that ends tile
   SHARING, so overlapping pins now re-download the same ground. The
   session download cap went 500 -> 5000 to absorb it.
3. **Nothing below z8.** Zoom out past the blob's own level and there is
   nothing to draw.

## The question for the developer

> How do you serve a 30 km vector-tile pack centred on an ARBITRARY GPS point,
> when slippy tiles are addressed on a fixed world grid?

MapLibre draws a vector tile across the box it REQUESTED, so a vector tile
cannot be re-centred on a point. The satellite photo in the same app gets this
right because it is an IMAGE placed by explicit GPS bounds.

Read `workers/offline-tiles/src/pinCentred.test.ts` — it documents the failure
with two of the user's real pins, both landing in tile 8/41/88.

## Why `contract/` is its own folder

`getCache_OfflineMap/lib/contract/` and `workers/offline-tiles/src/` hold BYTE-IDENTICAL twins
of `grid.ts`, `blob.ts`, `geo.ts`. The phone and the Worker must agree on tile
maths exactly or tiles are silently written where nothing reads them.
`grid.lockstep.test.ts` fails if they drift.

**Change the tile scheme = change both copies.**

## The tree

```
fetch/                       (flat siblings — no harness/ folder any more)
  getCache_OfflineMap/lib/
    contract/    grid blob geo roadBlob      <- twins of the Worker. THE BUG IS HERE.
    onPhone/     roads store render bake satellite
    r2Worker/    packDownload fireFetch tilesHost
    panels/      OfflineBlobPanel OfflineConfigPanel PinLibrary
  ReTreever/retreeved/       the shared seam (was mapShared/)

ReTreever/src/lib/mobile/
  offline/       re-export shims + contract/ copies, host/retreeverPorts.ts
  fires/         live fire layer (NOT offline — the online map uses it)
  places/        gazetteer, both maps

workers/offline-tiles/src/
    grid.ts blob.ts geo.ts                   <- the other half of contract/
    packBuilder.ts oneBlob.ts mvtFilter.ts   <- cuts the pack out of R2
```

Nothing is named for a version any more. `onPhone/` = on the device.
`r2Worker/` = comes down the wire.

## Already fixed today (context, not the ask)

The Worker returned `roadsBytes=0` for every area on earth: two thresholds
compared against `BLOB_DETAIL_Z` (15) while the pack reads at
`BLOB_DETAIL_LEVEL` (13). Fixed and deployed. Prove it in one command:

```
curl -sI 'https://tiles.retreever.org/pack?lng=-122.75&lat=53.92' | grep -i x-diag
```

That was a COUNTING bug. The tile-size problem above is untouched.

## Known-failing tests (pre-existing, not from the re-org)

`hostBoundary`, `fireCache` (2 CPU guards), `bakeService` (2), `shardLayout`.
The two `fireCache` ones guard against a measured 4 GB heap / 119% CPU
regression, so they are worth looking at.
