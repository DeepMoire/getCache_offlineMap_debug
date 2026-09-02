# Pack builder history — the measured bugs behind the invariants

The war stories that used to live as 40–60-line comment blocks in
`*/src/packBuilder.ts` and `*/src/mvtFilter.ts`. Each shipped, was measured,
and left an invariant behind. The code keeps the one-line invariant; this file
keeps the story. Written 31 Aug 2026, when the pv<33 compat era ended.

## The 50 km bug — why tiles are keyed by the PIN, never the cell (2026-08-20)

`cellTileKey(c)` is a grid address — `8/49/93` — and two different pins can
land in the same square, so one pin's roads were written under a key another
pin also asks for. Measured on the user's Yellowstone pin: the roads box was
36.6 km SOUTH of the pin, its north edge byte-identical to the previous
(Moran) pin's box. The satellite never had the bug because its key is
`${lng},${lat}` — the pin, never shared. Same map, same pins, 5 m vs 50 km.
Roads now travel under the pin's own address (`pinTileKey`); the cell survives
only as the tile's drawing frame.

### The pv 15 / pv 33 compat era (ended 31 Aug 2026)

The pin-keyed fix shipped to the Worker 2026-08-20, but App Store iOS 1.0.93
(PACK_FORMAT_VERSION 15) looked tiles up by its own computed `${z}/${x}/${y}`
— hand it a `pin/…` key and every lookup missed: tiles in IndexedDB,
unreachable, no roads, satellite fine ("the satellite came, but the roads
didn't"). The Worker read `pv` and served each fleet its own key shape, with
the key shape folded into the edge-cache key so the fleets couldn't poison
each other's year-long immutable entries. **Deleted 31 Aug 2026** — the 1.0.93
fleet was declared dead ("it's definitely broke on the phone"); the Worker now
always pin-keys and ignores `pv`.

## The roads budget (deleted) — 2 MB, 9×, and the drift that zeroed it

One rule: default to a wide 40 km reach; if decoded roads > 2 MB the area is
dense → drop all paths AND shrink to 25 km. Decoded size was estimated from
MVT roads bytes × 9 (measured 8.5–10× across Saskatoon/Calgary/BC).

It broke by constant drift: `countsTowardBudget` said `z >= BLOB_DETAIL_Z (15)
|| z === 12` while the build read every tile at `BLOB_DETAIL_LEVEL` (13) — so
the accumulator never ran and `roadsBytes` was 0 *by construction*. Measured
live 2026-08-21: Wyoming, Washington and Toronto all `roadsBytes=0`; Toronto
read 10.5 MB out of R2 to report it. Constant 0 read as "sparse everywhere":
paths never stripped, wide reach always shipped.

The square-grid rewrite then made reach fixed (`GRID_RADIUS_KM`) and deleted
`selectDisc` — after which the budget decided *nothing*: `dropPaths` was
hard-false in the only call site and `pathStripped` hard-0 in the diag. The
whole apparatus (`ROAD_BUDGET_BYTES`, `MVT_TO_GEOJSON`, `countsTowardBudget`,
`BUDGET_OUTER_Z`, `dropPaths`, `roadsBytes`/`pathBytes` plumbing) was deleted
31 Aug 2026.

## The ring pyramid (deleted) — z15 core, z13 mid, z12 outer

The pack once shipped rings: inner 5 km @ z15, a z13 mid ring, an outer z12
ring whose radius the budget set (25 ↔ 40 km).

- **Why the mid ring existed:** MapLibre overzooms UP only, so with just
  z15+z12 the default camera band (z13–z14) had nothing to stretch. The phone
  papered over the hole by decoding every stored tile to GeoJSON and
  re-cutting a pyramid — measured on device at 453 MB climbing 113 MB/s,
  741 MB total heap. Shipping z13 deleted that machinery.
- **Mid-ring radius, measured (filtered + gzipped /pack bytes):**
  home 153/48/24/14 kB, bc 158/103/82/77 kB, van 771/462/321/257 kB at
  25/15/10/8 km → 10 km chosen; tile count scales with radius².
- **"Same disc at every zoom":** a vector tile only stretches BIGGER, so a
  disc saved at z12 draws nothing below z12. Saving one extra level only moves
  the cliff (shipped and rejected three times); saving every level costs ~20–25
  cheap tiles and removes the cliff. Always built from the caller's radius —
  three builds hardcoded 40 km against a smaller disc and it read as "this
  huge really confusing 40 kilometre thing".
- All replaced by the square grid: one union read at `BLOB_DETAIL_LEVEL`, one
  blob per cell, framed per cell.

## Kind filtering — the inversion, and minor_road

The mid ring stripped roads to major kinds (`z < BLOB_DETAIL_Z`). Two lessons:

- **The threshold inverted silently:** `BLOB_DETAIL_Z` is 15 but the read
  level moved to 13, so `13 < 15` was ALWAYS true and the filter hit every
  tile in every blob. User-visible: "there's some sort of intermediate sized
  roads that got missed." Same drift shape as the budget bug.
- **`minor_road` must never be dropped:** it looked like dead weight on city
  byte counts (58 kB of ~136 kB in a 5-city z13 sample, alongside path 58 kB,
  major_road 14.9, rail 3.9, highway 0.8, ferry 0.7), but measured on a real
  pack, 46 of 193 z13 tiles came back with ZERO road features — the tile under
  the pin among them. In rural country `minor_road` IS the road network. City
  byte counts are not the test; the back roads are.

There is no kind filter on roads any more: the blob draws at every zoom from
its stored level in, so "sub-pixel when zoomed out" is also "missing when
zoomed right in". Everything means everything.

Three ring keep-sets routed by zoom also drifted (same two-constant shape) and
the live pack shipped `roads` and nothing else (measured 28 Aug 2026: one
source layer per blob). The keep-set now comes from `lib/contract/packLayers.ts`
— one table, read by Worker and phone alike. Historical byte notes: water on
the old mid ring was 655 kB vs 285 kB of roads (now lake/pond + river/canal
only, +85 kB raw on a 445 kB pack); `landuse` unread client-side; `landcover`
empty in this archive; `earth` coarse frontier blocks.

## The disc clip — born, rebuilt, deleted

Tile *selection* ("does this square touch the circle") is not shipping a
circle: a z9 tile is 55 km wide, so one kept by a grazing corner dragged roads
78 km past the rim — the user measured 80 km on screen, and `1/0/0` (half the
planet) shipped in a pack. First fix: a per-tile byte-level clip (bbox-only,
no re-encode; straddlers kept whole). Then the square grid removed the
question entirely: cells are boxes, source tiles are boxes, and the single
edge trim happens once in oneBlob.ts against the cell frame, where both
neighbours cut on the same line. A later clip to the pin's 30 km box (shipped
2026-08-20) was also removed — it cut every boundary road into an arc. The
rule, from how Mapbox/MapLibre do offline: the downloaded region and the
displayed region are different things; whole tiles, always a superset;
centring is the camera's job.

## The PNG detour (reverted 2026-08-20)

`roads-as-image` tried to fix a centring bug by changing the transport. It did
centre (measured 0.000 km) and was still worse on a phone: no restyling (dark
mode, width-by-zoom), blurs past its render resolution, one flat picture
replacing a tiled map. Side by side: "if that's the PNG, it's pretty
shitty... earlier today the vector was working really nice." The centring
lesson survived: it's a *coverage* question, not a framing one — each cell is
framed to its OWN box; the pin decides only WHICH cells are built.

## Zero-byte tiles — "Unimplemented type: 4"

A tile the archive has can filter down to nothing; shipping it put 7k
zero-byte tiles in every device's `rt-tiles-v3`, and Mapbox's worker threw
parsing each one on every render pass, forever. Guards: `readDisc` drops
0-byte results as `empty`; `serializePack` builds manifest and body from ONE
filtered list so an `n:0` entry cannot exist.

## PACK_POOL = 32

8-wide measured `loopMs=56486` on a cold ~3,950-tile build — the client timed
out, backed off 60 s, and the blob arrived "out of nowhere". 100 in flight
blew the 128 MB Worker limit (error 1102) on the world planet. 32 is 4× the
throughput at a third of the failing concurrency.

## The shallow vocabulary miss — kinds that matched nothing (pv48, 2026-09-02)

direction2.5 built the z6 tile from the disc's z13 reads, but the shallow
keep-set listed `["highway","major","medium","minor"]` — a fictional vocabulary.
The archive speaks `major_road`/`minor_road` (measured at z13: minor_road 58 kB,
major_road 14.9, highway 0.8 of a ~136 kB 5-city sample; "medium" does not exist
in Protomaps at all), and `mvtFilter` matches kinds EXACTLY (`Set.has`), so the
z6 tile shipped highways alone: the low-zoom quadratino read as a few statali
with no secondaries and no brown mesh. The lockstep miss was total —
`shallowBuild.test` fed the filter its own synthetic tiles built from the same
fictional kinds, so CI stayed green while the fleet shipped the bug. Fixed in
`lib/contract/packLayers.ts` (the archive's own `*_road` kinds), the test
rewritten on the real vocabulary, and pv bumped 47→48 — which also catches the
pv47 miss: the built-shallow content change (v34→v35) shipped without its own
bump, so already-baked pins never re-downloaded (the bake latch keys on
BLOB_VERSION, which folds `pf${PACK_FORMAT_VERSION}` in).

Same session, phone side: the tier's water had been riding in the z6 tile
unpainted — `v4-water-*` read the disc only. `v4-water-fill-shallow` /
`v4-water-line-shallow` now paint it (pure rendering, no pack change).

## The meta-lesson

Every silent failure above had the same shape: **two constants that must agree,
living apart, drifting** (`BLOB_DETAIL_Z` vs `BLOB_DETAIL_LEVEL`, worker
keep-set vs phone renderer, worker key shape vs phone lookup). The fixes that
stuck replaced prose warnings with a single shared source both sides read
(`lib/contract/packLayers.ts`, `lib/contract/grid.ts`) or a value derived from
the thing it must track. When a new invariant appears, put it in the contract
or a test — not a comment.
