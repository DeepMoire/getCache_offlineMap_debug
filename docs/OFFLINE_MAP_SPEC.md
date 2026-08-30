# Offline Map — Build Spec (design rationale)

The original from-scratch build brief, kept for its **why**: the measured
failures, the acceptance tests (§8) and the engineering rules (§9) that tests
cite by number. The plan of record is [`OFFLINE_PLAN.md`](OFFLINE_PLAN.md) —
prefer it wherever the two disagree. Radii here say 25 km; the shipped
constant is `GRID_RADIUS_KM` in `lib/contract/grid.ts`.

## ⛓️ CONSTRAINTS

The user's rules, in his words. They are the definition of done.

🗜️ **"We need to see the roads all the time, and we need it to be fast. That's it."**
🗜️ **Roads within the radius of every pin, visible at EVERY zoom level.** No blank zoom bands.
🗜️ **Every pin, not just the one on screen.** Imported pins, pins from a shared
   file, pins the user has never looked at. Nothing may require the user to
   visit, centre, or hold still on a pin for it to get data.
🗜️ **It works with the phone in airplane mode.** That is the entire point.
🗜️ **Fail loud.** A read that returns null on error, a catch that swallows, a
   "retry next pass" on a permanent failure — each has cost multiple days. See §9.

---

## 1. What the user sees

1. User is on the map with pins on it. Taps the crow button.
2. The map becomes the **offline map**: a dark, styled road map with a small
   satellite photo square at each pin.
3. Around every pin there are **roads out to 25 km**, at any zoom.
4. Airplane mode changes nothing. That is the test.

The satellite squares are small (~2 km radius) and are the visual anchor — "my
pin is here". The roads are the useful part — "here is how I get there".

---

## 2. Infrastructure that ALREADY EXISTS — do not rebuild

The Cloudflare account, R2 bucket (`offline-tiles`, `env.TILES`), the three
tile hostnames and the `planet.pmtiles` archive are set up and reused as-is —
never create new buckets, keys or domains. Source, deploy and tiers:
[`../worker/README.md`](../worker/README.md).

Satellite imagery is EOX Sentinel-2 cloudless (public WMTS, no key):
`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg`
(note the `z/y/x` order).

---

## 3. Architecture in one paragraph

A **Worker** reads the planet archive from R2, cuts out the tiles covering a
pin's 25 km box, and returns them as one binary pack. The **phone** stores those
tiles in IndexedDB and serves them to MapLibre through a custom protocol
handler, so MapLibre thinks it is fetching from the network when it is reading
from disk. A **bake service** loops over every pin the user has and makes sure
each one's tiles and satellite photo are on disk.

Three pieces: **Worker → storage → renderer.** Keep them separable; every bug
in the previous attempt came from not knowing which of the three was at fault.

---

## 3.5 ⛔⛔ HOW TO GET THE PIN IN THE MIDDLE — READ THIS TWICE

**This one question cost twelve hours in a single day and five months of
intermittent failure. Four different approaches were built and reverted. The
answer is short, and it is not what it looks like.**

### The answer

> **Do NOT try to centre the DATA on the pin. Centre the CAMERA on the pin, and
> make the data a SUPERSET that fully contains the pin's 25 km box.**

That is the whole thing. Three lines of consequence:

1. **Download** every whole tile intersecting the pin's 25 km box. Superset.
2. **`map.setCenter(pin)`** — the camera does the centring.
3. **Assert CONTAINMENT, never centring** (§8 A3).

### Why the obvious approach cannot work

The pin is a **point**. A tile is a **grid square** on a world grid drawn before
the pin existed. At z8 a square is ~104 km wide, so **a grid address cannot
centre on a point** — the pin is a passenger wherever it happens to fall inside
its square. Finer grids (Plus Codes, S2, geohash) shrink the error but never
reach zero. Only bounds reach zero, and a vector tile's geometry is defined
against its own tile bounds, so it cannot be re-framed to arbitrary bounds.

**The counter-example was always on screen:** the satellite photo is centred on
the pin every single time — measured 2-5 m, on every pin, all night — because it
is an IMAGE placed by explicit GPS bounds. Roads were TILES. Same map, same pin,
same moment: **5 m versus 45 km.**

### The four failed attempts, so nobody repeats them

| Attempt | What happened |
|---|---|
| **Ship the tile the pin falls in** | Measured **45.2 km off**, spanning 132.6 km. The pin was a passenger in a z8 square. |
| **Send the cell centre to the server** (so nearby pins share a cache entry) | Worked, and silently moved the data — the blob was built around the cell centre, **63 km west** of the user. *A cache key may be derived from the request; it must never replace it.* |
| **Rasterise the roads to a pin-centred PNG** | Centred perfectly — **0.000 km**, measured live. Still reverted the same day: a raster cannot restyle, blurs on zoom, and is one flat picture per pin instead of a map. |
| **Clip the vector geometry to the pin's box** | Centred to ~400 m and **cut every road crossing the boundary into an arc.** That is not a bug in the clip; it is what clipping means. |

### What "correct" actually looks like in the numbers

Do not be alarmed that the shipped box is bigger than 25 km and a few hundred
metres off-centre. **That is the correct answer.** Measured on real pins after
the fix:

```
Greybull WY   reach 45.9 km   offsetFromPin  123 m    ← correct
Winnett  MT   reach 45.3 km   offsetFromPin  353 m    ← correct
   west 31.5 km · east 32.1 km · north 32.0 km · south 31.6 km
```

Even in all four directions, pin comfortably inside, coverage guaranteed. The
few-hundred-metre offset is the tile grid, and it is invisible: at z12 it is
~14 screen pixels, and **no road is drawn in the wrong place** — every road sits
on its true coordinates. What was off is the *extent of the downloaded area*,
not the position of anything in it.

**Kilometres = a bug. Metres = working.** That is the whole readout.

### The separate bug that looks identical

If a pin's roads land tens of kilometres away *after* you have done all of the
above, it is not a centring problem — it is the **shared-key collision in §5.1**,
where one pin is served another pin's tiles. Check the key before re-opening
the geometry.

---

## 4. The Worker

### 4.1 The one endpoint

```
GET /pack?lng=<number>&lat=<number>&pv=<int>     (pv = PACK_FORMAT_VERSION)
```

Returns a binary pack: `[uint32 LE manifestLength][manifest JSON][tile bytes…]`

Manifest (`worker/src/packBuilder.ts`):
```json
{ "total": <int>, "empty": <int>, "tiles": [{ "k": "z/x/y", "n": <byteLength> }, …] }
```

Tile bytes are concatenated in manifest order; an entry with `n: 0` is never
written. The pin's box is not in the pack — the phone derives it from the same
`radiusBox` the Worker used (§9 rule 6).

### 4.2 What it does

1. Compute the pin's 25 km box: `radiusBox(lng, lat, 25)`.
2. Find every source tile in `planet.pmtiles` intersecting that box.
3. Return those tiles.

**That is all.** No clipping, no re-projection, no rasterising.

### 4.3 ⛔ Traps that have already cost days

The centring traps are the §3.5 table — derived point, clipping, rasterising.
Worker-side:

**The build ID must be part of the edge cache key.** Entries are stored
`immutable`; without a build stamp in the key a code change is invisible — the
edge replays old bytes and the deploy looks like a no-op. Measured: `/pack`
returned a byte-identical 3,471,606-byte response built by the previous code.

**Gzip the body yourself, but do NOT set `Content-Encoding: gzip`.** Advertising
it makes Cloudflare's edge compress on top; the body arrives double-gzipped and
the browser inflates one layer, yielding garbage. Send opaque gzipped
octet-stream and have the client inflate the single explicit layer.

**A cold build takes ~56-66 s** (measured). Any client timeout shorter than
~150 s is a coin flip against the server's own build time.

**Emit useful response headers** — build ID, cache HIT/MISS, and timing. Without
them "did my deploy land?" is unanswerable. Add them to
`Access-Control-Expose-Headers` or the browser hides them from JS.

---

## 5. Storage (phone)

IndexedDB. One object store, `ArrayBuffer` values keyed by string.

### 5.1 ⛔ THE KEY IS THE PIN — the single most important decision here

A slippy tile address (`z/x/y`) is a **world grid square**. At z8 a square is
~104 km wide, so **two different pins routinely land in the same one**. If tiles
are keyed by bare address, one pin's roads get served to another pin.

Measured, two of the user's pins minutes apart:
```
Moran WY        pin -110.7261,44.0618   roads box north edge 44.3334
Yellowstone WY  pin -110.7470,44.6629   roads box north edge 44.3334   ← IDENTICAL
```
The second pin sat 36.6 km north of the top edge of its own roads.

**The satellite photo never had this bug, and the reason is one line:**
```
satellite key = `${lng},${lat}`      ← the pin. Unique. Never shared.
tile key      = `${z}/${x}/${y}`     ← a square. Shared between pins.
```
Same map, same moment: **5 m off versus 50 km off.**

So: **key roads by the pin too.**
```
pin/<lng.toFixed(5)>,<lat.toFixed(5)>/<z>/<x>/<y>
```
The tile keeps its grid address because MapLibre must draw it into the box it
requested. Identity is the pin; geometry is the cell. One string, so they can
never disagree.

### 5.2 One address can have SEVERAL owners — draw them all

Once keyed by pin, a `z/x/y` address may be owned by two pins whose radii
overlap. **Return every owner and merge them.** Returning only the nearest one
was tried; every other pin's copy then drew nothing, and the user saw half a
map: *"half of it's missing because it doesn't want to overlap the other one."*

Merging is a **byte concatenation**, valid per the MVT spec: a vector tile is a
repeated field-3 `layers` message, so joining two tiles for the same address
yields a well-formed tile with both sets of layers in one shared coordinate
space. No decoding, no re-projection.

### 5.3 Other storage rules

- **Never persist a 0-byte tile.** MapLibre's worker throws
  `Unimplemented type: 4` parsing it on *every render pass*, forever. Reject at
  the write boundary — bad transient state costs one dropped tile; bad persisted
  state poisons the map until the DB is wiped.
- **Never parse a key with `key.split("/")`** and take the first three parts —
  on a pin key that yields `["pin", "<lng>,<lat>", "<z>"]` → `NaN`, and
  `toGeoJSON(NaN, NaN, NaN)` returns garbage *without throwing*. Write one
  `parseTileAddress()` that returns `null` on anything malformed.
- **Never let a read latch.** A guard that made every read a permanent miss cost
  an entire evening with megabytes of correct data on disk.

---

## 6. Renderer (phone)

### 6.1 ⛔ MapLibre CANNOT carry a GPS point in a tile request

This is the central fact of the whole subsystem and it was undocumented for
five months. A tile source has exactly one URL template:
```
rtraw://disc/{z}/{x}/{y}        (RAW_TILE_URL, lib/onPhone/roads/rawWallProtocol.ts)
```
MapLibre fills in three integers and asks. **There is nowhere to put a pin.**

So the protocol handler receives `z/x/y` and must resolve it back to owners
itself (§5.2). This is why the key design in §5.1 matters: it is the only place
the GPS survives.

### 6.2 ⛔ MapLibre CACHES 404s — the "works sometimes" bug

**A tile that misses once is never requested again.**

Sequence: pin drops → MapLibre asks for its tiles immediately → the download
takes 20-60 s → every request misses → **those 404s are cached permanently** →
roads land → nothing ever re-asks. Black map, no error, correct data on disk.

Measured: the handler was called exactly four times in a 38-second session while
4,306 correct tiles sat in IndexedDB.

**This is the "it worked for months and then didn't" pattern.** Identical code;
whether it works depends purely on whether the renderer asked before or after
the download landed.

**Required:** after tiles land, call the source's `setTiles([url])` to invalidate
the tile cache. Do it on a short retry ladder (e.g. 400 ms / 1.5 s / 4 s), not
once — a single call races the source being mounted. And make the "asked N,
found 0" detector *trigger* that refresh rather than merely log it.

### 6.3 ⛔ Roads at EVERY zoom

MapLibre **overzooms up, never down.** A source with `minzoom: 8` shows nothing
below z8 — silently; `minzoom: 0` just 404s z0–z7. Storing one zoom level does
**not** satisfy "visible at every zoom". The open fix is a low-zoom IMAGE tier
per pin, placed by GPS bounds like the satellite (see `OFFLINE_PLAN.md`,
"Below `BLOB_TILE_Z`"). §8 A2 must pass at *every* zoom.

### 6.4 Centring is the camera's job

`map.setCenter(pin)`. Optionally `setMaxBounds` to the 25 km box so the user
cannot pan into the ragged tile-aligned fringe. Optionally a mask layer (a
world-polygon with a circular hole) if a hard visual edge is wanted — that is a
one-feature GeoJSON source and clips *visually* without touching geometry.

---

## 7. The bake service

A loop, running on a timer, that walks **every pin on the device** and ensures
each has (a) its road tiles and (b) its satellite photo on disk. Newest-touched
pin first, so a just-dropped pin is served before old ones.

**No viewport is involved.** Tile selection is arithmetic on a GPS point, which
is what makes imported pins and future background-location work possible.

### 7.1 ⛔ Budget the thing the USER does, not the thing the CODE does

Have a circuit breaker for runaway downloads. Then obey this rule, which has
been violated twice:

> A budget must count the thing the user does (bake an area), never the thing
> the implementation happens to do (issue a request). **Change the unit of work
> and the constant is wrong again.**

Both times it tripped in ordinary use and, because a tripped breaker is
**terminal for the session**, every subsequent download was refused — a new pin
showed nothing at all, with the cause visible only in the console. **Write a
test that asserts the cap fits a realistic library (say 300 pins re-baking).**

### 7.2 Progress UI needs a watchdog

If you show a spinner, it needs a hard stop. The defining property:

> **The watched process must not be able to skip or reset the watchdog.**

Three implementations violated this: one armed the timer inside an
`if (!visible)` branch that never ran during a backlog; one cleared the latch on
every completion; one reset the elapsed clock per-area so the ceiling was never
reachable. The user, four times: *"it can't keep running and running for no
reason. It just screams that the thing is broken."*

Put the check on the same ticker that draws the number — if the animation is
visible, the watchdog is running — make it one-way, and cap it (~30 s). Work
continues silently after that.

---

## 8. Acceptance tests — the ONLY definition of done

Everything below has been green in a previous attempt while the user looked at a
black screen. **Bytes downloaded, tiles on disk, layers added, features counted,
and a manifest box measured are all PROXIES.** Do not accept them as proof.

**A1 — Roads are visible.** Drop a pin, wait for the download, read the map
canvas pixels and count road-coloured ones. Must be non-trivially > 0. This
cannot be satisfied by anything except roads being drawn.

**A2 — At every zoom.** A1 must pass at z4, z8, z12 and z16 on the same pin.

**A3 — Around the pin.** The pin's 25 km box must be *contained* in what
shipped, in all four directions. (The box will be *larger* than 25 km and
slightly off-centre — that is correct, tiles are a superset. Assert containment,
never centring.)

**A4 — Two adjacent pins both draw fully.** Place two pins ~30 km apart so their
radii overlap and share tile addresses. **Both** must show a full circle of
roads. This is the half-a-map regression.

**A5 — Airplane mode.** Bake, go offline, hard-reload, roads still draw.

**A6 — Late arrival.** Drop a pin and do not touch the map. Roads must appear
**on their own** once downloaded, without panning or zooming. This is the
cached-404 regression and it is the single most valuable test here.

**A7 — Imported pins.** Import a file with several pins the user never visits.
All get data.

**Prove every test red-on-bug.** Break the thing, watch the test fail, restore
it. Multiple tests in the previous attempt passed on broken code.

---

## 9. Engineering rules

1. **DevTools first.** For any question about running behaviour, read the live
   state — do not predict it.
2. **Never verify one layer and declare the chain fixed.** Nearly every wrong
   turn came from confirming the part that was already fine.
3. **Fail loud. No silent fallbacks.** Listed here because each of these has
   cost a day: a read returning null on error; a catch that swallows; a NaN
   flowing into geometry instead of throwing; a "retry next pass" on a
   permanently latched guard.
4. **Instrument WHERE, not just HOW MUCH.** Every offline bug this project has
   had was the same shape: correct bytes in the wrong box. Feature counts and
   byte totals all looked healthy throughout. Build a debug view that reports,
   per pin: the blob's **corners**, its **reach in km**, and its **offset from
   the pin**. That single readout found the 45 km, 27.9 km and 50 km bugs.
   Make sure it can never report another pin's data as this pin's — the
   equivalent check in the previous attempt queried the whole viewport, so a
   neighbouring pin's roads made it report success.
5. **Keep the import graph small.** The previous `/offline` route pulled in
   **175 files / 53,675 lines**, of which only ~8,600 were the offline map. The
   rest arrived because the route imported one popover, which imported a store,
   which imported the inbox. **The offline map must not import app UI
   components, stores, or utilities.** Give it a narrow, explicit interface —
   it needs a list of `{lng, lat}` and nothing else. Enforce it with a test that
   fails if the module graph exceeds a file budget.
6. **One definition of shared constants.** The radius and the key format are
   used by both the Worker and the phone. If they ever disagree, the phone
   requests something the Worker never wrote and the map is blank with no error.
   Share the file byte-for-byte and add a test that fails if the copies drift.

