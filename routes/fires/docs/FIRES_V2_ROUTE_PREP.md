# /fires?v=2 — Worker route prep

**Status: NOT STARTED. Nothing in this doc has been written to code.**
This is the loaded-context handoff so the build can start cold without
re-deriving anything. Every claim below was verified against live source on
2026-08-11.

Do this work **after** the online + offline base maps are as low as they go.
The fire layer is the heaviest data subsystem in the app; measuring it against
a still-moving floor wastes the measurement.

Phone side is **DONE and inert** — `fetchFireDiscV2` exists, is tested, and
throws a named error while the Worker is still v1. There is no deploy-ordering
constraint: ship the Worker whenever, the phone degrades cleanly.

Spec: `../ReTreever/src/lib/mobile/docs/WILDFIRE_LAYER_V2.md`
Bisect state: `../ReTreever/src/lib/mobile/fires/v2/BISECT_STATE.md`

---

## The three Worker fixes, with line anchors

All three are in `src/index.ts`. Line numbers are as of 2026-08-11.

### 1. ⚠️ The edge cache key does NOT include `?v=` — BLOCKING

`src/index.ts:271`

```ts
cacheUrl.search = `?v=${FIRE_ANSWER_VERSION}&lng=${snap(lng)}&lat=${snap(lat)}&km=${km}`;
```

The key is built from `FIRE_ANSWER_VERSION` + snapped lng/lat/km only. The
**request's** `?v=2` is discarded. So a `?v=2` request collides with a `?v=1`
request for the same cell and is served the **v1 body** off the edge.

This is the single fix that must land or v2 cannot work at all — and it fails
in the most confusing possible way, because it only misbehaves on a *warm*
cell. A cold cell answers correctly and the bug looks intermittent.

**Fix:** read the request's `v` param, validate it to `1 | 2`, and put it in
the cache key as a distinct token from `FIRE_ANSWER_VERSION` (they mean
different things — one is "which payload shape did the caller ask for", the
other is "has our notion of a correct answer changed").

### 2. Bump `FIRE_ANSWER_VERSION`

`src/index.ts:169` — currently `3`.

Bump to `4` when v2 lands. One bump covers both the new payload shape and the
ETag. Same lesson as v1→v2 and v2→v3, already recorded in the comment there: a
TTL expires **stale** data, never **incomplete or wrong-shape** data.

### 3. ETag / `If-None-Match` — verified ABSENT on the live route

Confirmed by curl: no `etag` response header, and `If-None-Match` is ignored
(returns a full 200). Three parts, all inside the `/fires` block:

- **Hash the body**, set `ETag: "<short sha256 hex>"`. Use
  `crypto.subtle.digest("SHA-256", …)` — available in Workers, no import.
- **Expose it.** `src/index.ts:309` is currently
  `"Access-Control-Expose-Headers": "X-Fetched-At, X-Sources-Ok"`.
  Add `ETag`. Without this the phone reads `null` cross-origin and silently
  never sends a conditional request — the CORS expose-headers trap this repo
  has hit before. **The feature fails silently and looks like it works.**
- **Handle `If-None-Match`** inside the `if (fireHit)` branch at
  `src/index.ts:275`. Return a **bodiless 304** that still carries
  `X-Fetched-At` / `X-Sources-Ok`, so freshness stays readable without a body.
  That is exactly what the phone expects — it returns `{ notModified: true }`
  and touches `fetchedAt` only.

### 4. Confirm compression on the v2 route

The live `/fires` response is **2.86 MB uncompressed**; the ~180 KB figure
quoted throughout the docs is **gzipped**. Verify compression is actually
negotiated on the v2 route rather than assumed — a 2.86 MB payload on a field
phone is a different product than a 180 KB one.

---

## The payload contract — pinned by the phone, not negotiable

The phone validates this in `fetchFireDiscV2`. Build to it exactly.

```jsonc
{
  "points":   { "type": "FeatureCollection", "features": [ /* detections */ ] },
  "clusters": { "type": "FeatureCollection", "features": [ /* see below */ ] },
  "outlines": { "type": "FeatureCollection", "features": [ /* polygons */ ] }
}
```

**Hard requirements** (from `fireFetchV2.ts`):

- `points` **must** be a `{type:"FeatureCollection", features:[…]}`. If it is
  missing or malformed the phone **throws** and keeps its last good cache —
  deliberately, because an empty fire layer is indistinguishable from "no fires
  near you". A v1 Worker answering `?v=2` with a bare FeatureCollection hits
  exactly this path, which is the intended safety behaviour today.
- `clusters` and `outlines` are **optional** — each falls back to an empty
  FeatureCollection. They must not be malformed-but-present-looking.
- Per-point properties: `t` (epoch ms), `c` (`"low"|"nominal"|"high"`),
  `frp` (MW), optional `px`, optional `dn` — **identical to v1's shape today**,
  which `fires.ts` already emits.
- **New in v2: `ind: 1`** on industrial detections. This is the only genuinely
  new per-point field. It lets the phone dim flare stacks with a paint
  expression instead of running a classifier. Omit the key entirely when not
  industrial — the layer reads it as `["coalesce", ["get","ind"], 0]`.

### ⚠️ Scope reduction — `clusters` is stored but NEVER rendered

`fireLayerV2.ts:332-334` calls `setData` with **only** `pointsJson` and
`outlinesJson`. `clustersJson` is persisted to disk and read back, but nothing
paints it. The layer clusters with Mapbox's **native** `cluster: true`
(`fireLayerV2.ts:182-208`), which runs in the GL worker and was never the
bottleneck.

**So the Worker can ship `clusters` as an empty FeatureCollection for the first
cut** and the layer will look correct. Do not spend build time on server-side
clustering until something actually consumes it. (The spec's prose says the
cluster payload feeds zoomed-out tiers; the code does not do that yet. The code
is what ships — trust it over the prose.)

That leaves the Worker's genuinely new work as: **`outlines` (hull polygons)**
and **`ind` (industrial classification)**. Everything else it already does.

### Native clustering depends on these two properties

`clusterProperties` aggregates `maxFrp` and `indCount` from `frp` and `ind`.
Both use `coalesce`, so absent keys are safe. But `ind` must be `1`/absent —
**not** `true`/`false` — or `indCount`'s `["+", …]` sums booleans and the
industrial dimming misfires.

---

## What the Worker already has (do not rebuild)

`src/fires.ts` is pure logic over an injected fetch and already does most of it:

| have | where |
|---|---|
| three-satellite fan-out, `Promise.allSettled`, partial-failure tolerance | `fetchFires` |
| CSV parse by **header name** (never index) | `parseFiresCsv` |
| disc trim (bbox → circle) | `distanceKm` filter |
| dedupe to ~375 m cell / 1 h, keeping max FRP | `dedupeFires` |
| `DAY_RANGE = 2` — locked by test, do not "optimise" to 1 | `fires.ts:61` |
| fail-loud on all-sources-down → 502 | `fetchFires` |
| the exact `{t, c, frp, px?, dn?}` output shape | `fetchFires` return |

**Missing, and to be added for v2:** hull/outline generation, and industrial
classification (`ind`).

⚠️ `fires.ts` is deliberately **pure** — no R2, no caching, no `Response`
building; `index.ts` owns all of that. Keep the new v2 logic on the same side
of that line, or its tests stop being unit tests.

---

## Build order

1. **Cache-key fix (#1) first, alone.** It is independent of the payload and it
   is the one that makes everything else debuggable. Until it lands, every v2
   test against a warm cell is lying to you.
2. **v2 route returning `points` + empty `clusters` + empty `outlines`.** This
   alone satisfies the phone's contract and unblocks wiring. `points` is the
   existing v1 collection under a new key.
3. **`ind` classification**, then **`outlines`**. Both are additive; neither
   blocks wiring.
4. **ETag + expose header + 304**, and bump `FIRE_ANSWER_VERSION` to 4.
5. Then the phone-side cutover — bake service, the two `attachFireLayer` call
   sites, measure, delete v1.

Steps 1–2 are a small, self-contained first session. That is where to start
when the base map work is done.

---

## The acceptance test — this is the whole point

Fires-on with v2 must sit near the **fires-off floor**:

| route | fires-off floor | v2 target |
|---|---|---|
| `/map` | 274 MB | ≈274 MB |
| `/offline` | 963 MB | ≈963 MB |

v1 fires-on was **~4,000 MB, then the tab crashed.**

If v2 lands materially above the floor, the architecture rule was broken
somewhere — find the derivation step that crept onto the phone rather than
tuning constants. `fireCostV2.test.ts` is the guard that catches exactly that;
**if it fails, do not relax it.**

Separately: the ~690 MB gap between the two floors is a **different problem**
(`/offline`'s satellite-photo textures, `MAX_MOUNTED_PHOTOS = 80` × 1536² RGBA
≈ 755 MB, plus its wall-map decode conveyor). v2 does not touch it. Don't let
it contaminate the fire measurement.

---

## The 🔬 bisect flags — still live, still not a fix

**Re-measured 2026-08-23: there are TWO, not three.** Both are `false` right
now, disabling a **hazard** layer (wildfires near planters). They must **flip
together** — the app is one process, and a fire layer live on any route keeps
the module resident. A half-bisect proves nothing; that already cost one round
trip.

| flag | file |
|---|---|
| `FIRE_LAYER_ENABLED_ONLINE` | `../ReTreever/src/routes/(getcache)/map/MobMapPage.svelte:233` |
| `FIRE_REFRESH_ENABLED` | `../ReTreever/harness/src/lib/components/map/getCache_OfflineMap/lib/onPhone/bake/bakeService.svelte.ts:1134` |

**The third, `FIRE_LAYER_ENABLED`, is GONE** — the offline page no longer
declares it. Only two stale *comments* still name it, and they now mislead:
`MobMapPage.svelte:223` ("paired with FIRE_LAYER_ENABLED") and
`bakeService.svelte.ts:1127` ("Pairs with FIRE_LAYER_ENABLED in
routes/mobile/offlinev4/+page.svelte" — a path deleted twice over).

⚠️ **So "all three must flip together" is no longer satisfiable as written.**
Before flipping anything, confirm whether the offline route still needs a
switch of its own or the two above now cover it — otherwise you get exactly the
half-bisect this section warns against. Note `fireLayer.ts:1136` records that a
previous attempt put the const in only ONE of the places that needed it; that
is the same trap.

Either v2 lands or these come out. They are not a resting state.

**4 tests fail while they are set** — all four expected, all four documented in
`BISECT_STATE.md`. Two prove the flags are live; two prove the v1 cost guard
bites. Don't "fix" them.
