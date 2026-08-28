# Wildfire Layer v2 — spec

**Status: written, typechecked, tested (43 tests). NOT yet wired into either
map, and the Worker route does not exist yet.** v1 is still what runs. See
"Cutover" at the bottom for what remains.

---

## Why v2 exists

v1 was measured on 2026-08-10, on an **idle page with nothing moving**:

| | |
|---|---|
| Total JS heap | **~4,000 MB**, then the tab crashed |
| CPU | **119%** |
| `kmBetween` | 7,982 ms — **30.1%** of the main thread |
| `unionHotspots` | 5,474 ms — 20.6% |
| `paintInner` | **63.6% of TOTAL time** |

Disabling only the fire layer took the same page to **963 MB**, and the online
map to **274 MB**. A 15× swing from one subsystem.

The cause was never a single bad function — it was an architecture in which the
phone holds every raw detection and re-derives geometry from them:

- ~36,489 raw detections cached for one 500 km disc
- a union pass deduping every detection against every other disc
- a supersede pass running a distance test per (detection × newer disc)
- a hull builder clustering 12,197 cells into 142 outlines
- an urban classifier walking the same pile again
- **five** memo layers bolted on to stop all of that running per-pan

~3,200 lines across 9 modules, to draw dots on a map.

---

## The one rule

> **The phone renders. It does not compute geometry.**

A disc arrives from the Worker already deduped, clustered, outlined and
urban-filtered — render-ready. The phone stores three strings and hands them to
`setData()`.

This is the [`server-is-hot-phone-is-cold`](../../../..) principle applied to
the subsystem that broke it hardest. It is not an optimisation; it removes the
*possibility* of the expensive passes, because the data the phone holds is no
longer the shape you could run them on.

---

## Files

| file | role |
|---|---|
| `src/lib/mobile/offlineV4/v2/fireCacheV2.ts` | One disc on disk. Strings, not objects. The light index. |
| `src/lib/mobile/offlineV4/v2/fireFetchV2.ts` | Ask the Worker for a render-ready disc. Throws on anything it can't validate. |
| `src/routes/mobile/map/v2/fireLayerV2.ts` | Sources, layers, and a paint that is three `setData` calls. |
| `src/lib/mobile/offlineV4/v2/fireCacheV2.test.ts` | Safety surface: age copy, TTL, key stability. |
| `src/lib/mobile/offlineV4/v2/fireFetchV2.test.ts` | The "must throw, never lie" contract. |
| `src/lib/mobile/offlineV4/v2/fireCostV2.test.ts` | **The architecture guard.** |

---

## The Worker contract — `GET /fires?lng=&lat=&km=&v=2`

**This route does not exist yet.** It is the one piece of v2 that is not
written, and nothing works until it is.

```jsonc
{
  "points":   { "type": "FeatureCollection", "features": [ /* detections */ ] },
  "clusters": { "type": "FeatureCollection", "features": [ /* pre-aggregated */ ] },
  "outlines": { "type": "FeatureCollection", "features": [ /* polygons */ ] }
}
```

Headers: `X-Fetched-At` (epoch ms, the server's clock), `X-Sources-Ok` (how many
of the three satellites reported). Both must be in `Access-Control-Expose-Headers`
or JS reads them as `null` — the CORS trap this repo has hit before.

Each `points` feature carries `t`, `c`, `frp`, optional `px` / `dn`, and — new
in v2 — **`ind: 1`** when the Worker judges the detection industrial. That flag
is what lets the phone dim flare stacks with a paint expression instead of
running a classifier.

**The Worker owns:** the three-satellite fan-out, CSV parsing, the FIRMS key,
dedupe, clustering, hull generation, and urban/industrial classification.

**If a future feature needs something derived, add it HERE.** Do not add a
derivation step on the phone. That is the mistake v1 made once per feature until
the layer cost 4 GB.

---

## What v2 keeps from v1, deliberately

Each traces to a real field failure; none is caution.

- **`fetchedAt` on every record, age shown in words.** Painting stale dots as
  live is the one genuinely dangerous failure this layer has.
- **A version stamp that invalidates on CONTENT, not just shape.** A TTL expires
  stale data; it does nothing about data that was *wrong* when written. v1 cached
  legitimately-formatted, completely empty answers over a burning province.
- **Never clear on failure.** Stale dots with an honest age beat an empty map
  that reads as "no fires near you".
- **A 5-minute phone TTL.** v1 used an hour, matching the edge cache, and
  produced *"Last checked — 5h ago"* with the app open: two one-hour caches
  compound rather than overlap. The edge protects NASA; the phone's TTL protects
  nothing, so it should be short.
- **Every colour, zoom gate and cluster rule**, unchanged. A planter must not be
  able to tell which version is running.

---

## The architecture guard

`fireCostV2.test.ts` asserts on the **shape of the work**, not the answer. This
exists because v1 passed every correctness test it had while burning 4 GB —
"renders the right dots" was true before *and* after the expensive passes.

It bans, in v2 source: convex hulls, cross-disc unions, supersede/covered-by
tests, on-device urban classification, any `Math.cos/sin/hypot/atan2`, iterating
a stored payload's `.features`, a `JSON.parse` that doesn't go straight into
`setData`, `getAll()` on the disc store, and any import from a v1 fire module.

**Verified by injection:** adding a v1-style `features.filter(...)` with a
`Math.cos` to the paint path fails **three** of these guards independently.

> ⚠️ If one fails, do not relax it. A failure means a derivation step has
> appeared on the phone — the exact move that produced v1. Put the work on the
> Worker instead.

---

## Cutover — what remains

1. **Build the Worker's `?v=2` route.** Nothing runs without it. Until then
   `fetchFireDiscV2` throws a named error telling you the Worker is still v1.
   → **Loaded prep, ready to start cold:
   [`workers/offline-tiles/FIRES_V2_ROUTE_PREP.md`](../../../workers/offline-tiles/FIRES_V2_ROUTE_PREP.md)**
   — the blocking edge-cache-key bug (`?v=` is not in the key), the ETag work,
   the pinned payload contract, and build order. Read it before writing Worker
   code.
2. **Wire the bake service** to fetch v2 discs alongside v1's, so both caches
   fill and can be compared on the same device.
3. **Swap the two `attachFireLayer` call sites** to `attachFireLayerV2`
   (`MobMapPage.svelte`, `offlinev4/+page.svelte`) behind a flag.
4. **Measure.** Fires-on with v2 should sit near the fires-off floor: ~274 MB on
   `/mobile/map`, ~963 MB on offlinev4. That is the acceptance test.
5. **Delete v1** — all 9 modules — and remove the 🔬 bisect flags.

⚠️ The three 🔬 bisect flags currently disabling v1 are **not a fix**. They
switch off a hazard layer. Either v2 lands or they come out.

---

## Open, not addressed by v2

The **~690 MB gap between offlinev4 (963 MB) and /mobile/map (274 MB)** with
fires off in both is a *separate* problem: that route's satellite-photo textures
(`MAX_MOUNTED_PHOTOS = 80` × 1536² RGBA ≈ 9.4 MB each ≈ 755 MB) and its wall-map
decode conveyor. v2 does not touch it.
