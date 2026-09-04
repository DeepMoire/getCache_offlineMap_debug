# Memory Usage Fix — Satellite Photo Viewport Culling
**Project:** ReTreever offline map · **Branch:** `direction2.6` · **Commit:** `0d3160d`

## 1. Problem Statement

The offline map's memory consumption (800 MB – 2 GB as measured by the client)
was 4–7× higher than comparable reference maps:

| Reference          | Idle/working memory |
|--------------------|---------------------|
| Google Maps        | 56 MB               |
| NASA FIRMS         | 49 MB               |
| native-land.ca     | 129 MB              |
| ReTreever (online) | 273 MB              |
| ReTreever (offline, as delivered) | 800 MB – 2 GB |

## 2. Root Cause

**Primary — permanent satellite photo mounting.** The page component's
`showPhotos()` mounted EVERY baked satellite photo found in IndexedDB, with no
viewport check, and never unmounted any of them during the session. A correct
`unmount()` (with object-URL revocation) already existed in the mount layer but
was never invoked. A 20-second poll re-ran the mount pass, so the mounted set
could only ever grow.

Each photo is composited on a 1536-px canvas:

- ~9 MB decoded pixels per photo (GPU/renderer memory),
- ~1.2 MB per photo in the JS heap (compressed blob + image element + source
  bookkeeping).

With 321 pins this sums to ≈ 2.9 GB of decoded pixel potential — matching the
client's measurements. In short: **memory scaled with the PIN COUNT, not with
the screen.**

**Secondary (not addressed in this fix — see §6):** MapLibre's map workers
accumulate decoded tile caches per zoom level (~+258 MB per zoom level worst
case). This memory is invisible to main-thread-only debug panels.

Road rendering was verified unaffected: road packs are served raw/undecoded via
a custom protocol (`addProtocol`) — correct by design, not touched.

## 3. The Fix (viewport culling, geometry-only)

New pure function `photoCullPlan(camera, anchors)` in the satellite mount layer:

- **Mount ring** = camera bounds + 1 viewport per side → a photo is mounted
  BEFORE it can scroll into view (no pop-in).
- **Keep ring** = camera bounds + 2 viewports per side → a mounted photo is
  unmounted only well beyond the edge. The wider unmount margin is hysteresis:
  a photo near the edge cannot flap in/out on repeated pans.
- Discs are evaluated with their true 2 km radius, with latitude-dependent
  longitude spans.
- **The cull never keys on zoom level.** A photo inside the camera stays
  mounted at every zoom (the project's "constant presence" rule). What the
  cull reacts to is distance from the screen — the same contract as native
  raster tile loading.

New `reconcile(camera, anchors)` method: runs the unmount sweep FIRST
(revoking each object URL — otherwise the blob stays pinned), then mounts
everything inside the mount ring, then reports the live count.

The page now reconciles on every settled camera move (`moveend`) plus the
existing 20-second poll (late-arriving bakes still appear without reload).

**Tests:** 9 unit tests lock the geometry (ring constants, in-camera presence,
pre-mount, disc-edge inclusion, hysteresis band, lat-dependent lng stretch,
world-view mounts everything, empty input). Full suite: no regressions
(pre-existing environment-related failures unchanged from main).

## 4. Verification Evidence (local dev environment, 33 pins, Vancouver–Prince George area)

**A. Mount count follows the screen** (console log `[sat] N photo(s)`):

z5 (whole area visible) = 33 · z7 = 15 · z8 = 8 · z10 = 1.

Panning at FIXED zoom away from blobs drops the count to 0–2 and back up on
return, with no visible re-mount flicker (pre-mount margin working).

**B. Memory (Chrome DevTools → Memory → JavaScript VM instances, after forced GC):**

| Scenario                     | Main heap | Worker heap | Total |
|------------------------------|-----------|-------------|-------|
| M1: z5, whole area, 33 photos mounted  | 99.0 MB | 12.7 MB | **112 MB** |
| M2: z10 Vancouver, 1 photo mounted      | 60.5 MB | 11.2 MB | **71.7 MB** |
| M3: back to z5, 33 photos mounted (same camera as M1) | 85.7 MB | 130.0 MB | **215 MB** |

Readings:

1. **M1→M2: −38.5 MB in the main heap** = photo memory released (≈1.2 MB/pin
   in JS heap; the ~9 MB/pin decoded portion lives in GPU/renderer memory
   outside the JS heap counters). Before the fix this memory was never
   released.
2. **M2→M3: photo memory returns reversibly** (+25 MB re-mounting 33 photos) —
   the mechanism is bidirectional and stable.
3. **M1 vs M3 (identical camera state):** photo memory is the same; the ONLY
   difference is +117 MB in the worker heap — the MapLibre tile cache accrued
   while visiting z9/z10. This isolates and quantifies the secondary issue.

## 5. Expected Behavior After Fix (what "solved" means)

- At working zooms (z8–z13): **~72 MB total** — same league as Google Maps
  (56 MB) and NASA FIRMS (49 MB).
- At wide overview zoom with all 33 local blobs mounted: **112 MB** — less than
  half of ReTreever online (273 MB).
- Memory no longer grows with the number of pins; it scales with what is on
  screen. Adding pin #322 does not add standing memory unless it is in view.

## 6. Known Remaining Items (not regressions — pre-existing, now quantified)

1. **Worker tile cache is monotonic** (+117 MB measured after one zoom-in
   excursion; ~258 MB/zoom worst case). Candidate next step: tile-cache
   eviction/cap in the map workers.
2. **Wide/low-zoom views keep every intersecting photo mounted by design**
   (constant-presence rule). If a customer has hundreds of pins AND browses at
   continent scale, memory will rise accordingly. The proper remedy is a
   downsampled-thumbnail pyramid for low zooms (optional phase 3; requires
   careful swap timing to avoid visible transitions).
3. Figures are from the dev environment with 33 pins; run-to-run variance of
   ±100–200 MB in Chrome totals is normal. Production numbers with the full
   321-pin set should be confirmed with the same protocol.

## 7. Reproduction / Measurement Protocol (for independent verification)

1. Open the app, DevTools → Memory. Bottom section "Select JavaScript VM
   instance" lists Main + worker(s) with live MB values.
2. Before each reading: let network/tile activity settle (kB/s ≈ 0), then
   press the 🗑 Collect garbage button.
3. Scenario 1: zoom out until all pins are visible; wait for the `[sat] N`
   console log; record Main/Worker.
4. Scenario 2: zoom into a single pin area; pan only (do not change zoom);
   record again.
5. Scenario 3: return to the wide view; record again.

Expected: photo memory drops on zoom-in and returns on zoom-out; worker
heap only ever grows (known item §6.1).
