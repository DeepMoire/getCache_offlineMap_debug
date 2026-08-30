# Fires — the wildfire hotspot layer

NASA FIRMS active-fire detections near a planter's ground, working offline.
This is the ONLY fires doc. It replaces `WILDFIRE_LAYER.md`, `WILDFIRE_LAYER_V2.md`,
`FIRES_V2_ROUTE_PREP.md`, `fireAPIs.md` and `v2/BISECT_STATE.md` (all deleted
30 Aug 2026 — the git history has them if a measurement is ever needed).

**Offline-first, never offline-only.** The map paints from IndexedDB, always;
in signal the cache is topped up, and the UI must say how old it is.

---

## State on 30 Aug 2026 — read before touching anything

| Half | Where | Status |
|---|---|---|
| Worker `GET /fires?lng=&lat=&km=` | `worker/src/index.ts` (route) + `lib/r2Worker/firesWorker.ts` (pure FIRMS logic) | **live**, v1 payload only |
| Phone fetch + IndexedDB (v1) | `lib/r2Worker/{local_dev,r2_prod}/fires/fireFetch.ts`, `routes/fires/fireCache.ts` (`rt-fire-cache`) | works; **refresh switched off** |
| Bake-loop refresh | `refreshFires()` in `lib/onPhone/bake/bakeService.svelte.ts` | gated by `FIRE_REFRESH_ENABLED = false` in `lib/shared/bakeFlags.ts` |
| Render layer | — | **does not exist.** v1's `fireLayer.ts` went with the online map move (28 Aug); the v4 offline route went with the v5 rebuild. The Fires switch in `lib/onPhone/render/wallLegend.ts` has `ids: []` and is a no-op |
| Phone v2 (`routes/fires/v2/`) | `fireCacheV2.ts` (`rt-fire-v2`), `fireFetchV2.ts` | written, tested, **inert** — throws a named error because the Worker has no `?v=2` |
| Worker `?v=2` | — | not started |

ReTreever mounts the v1 phone half through `retreeverPorts.ts`; this repo's
rapper demo omits the `fires` port and never reaches for hotspots.

### Why it is held back — not a decision, a bisect

v1 held every raw detection on the phone and re-derived geometry from it on
every pan (cross-disc union, supersede test, convex hulls, urban classifier,
five memo layers). Measured 2026-08-10 on an idle page: **~4,000 MB heap, then
the tab crashed; 119% CPU**. Fires off, the same page was 963 MB and the
online map 274 MB. `FIRE_REFRESH_ENABLED = false` is the flag that proved it.
Its partner `FIRE_LAYER_ENABLED_ONLINE` (in ReTreever's `MobMapPage.svelte`)
no longer exists — the render half is simply absent now.

**Either v2 lands or v1 comes back on.** A hazard layer switched off is not a
resting state.

### Expected red — 6 tests, all doing their job

| test | why it fails |
|---|---|
| `fireCache.test.ts` "scales LINEARLY in disc count" | `unionHotspots` is still O(n³) — the fix was reverted to isolate memory from CPU |
| `fireCache.test.ts` "absorbs a realistic full cache" | same; reports ~1,065,750 distance calls |
| `fireCostV2.test.ts` ×4 | `LAYER = ""` — there is no `fireLayerV2.ts` to scan yet |

⚠️ The `unionHotspots` fix (CPU 119% → 3.4%) lived in a scratchpad file that is
**gone**. If v2 stalls and v1 returns, it has to be rewritten: bounding-box
reject before `kmBetween`, so calls scale with hotspots, not hotspots × discs.
The two tests above are its spec.

---

## Data source — NASA FIRMS Area API

```
https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{w,s,e,n}/{DAY_RANGE}
```

Sources: `VIIRS_NOAA20_NRT`, `VIIRS_SNPP_NRT`, `VIIRS_NOAA21_NRT` (375 m).
MODIS is excluded — its 0–100 confidence does not match VIIRS `l/n/h`.

**The key.** `FIRMS_MAP_KEY` is a Worker secret (`wrangler secret put
FIRMS_MAP_KEY`), never a `[vars]` entry, never in the app bundle. The phone
only ever talks to our Worker. Register at
`https://firms.modaps.eosdis.nasa.gov/api/map_key/`; quota is **5000
transactions / 10 min** per key. A missing key returns **500**, never an empty
collection.

Footguns, all handled in `firesWorker.ts` and pinned by its tests:

- **`DAY_RANGE=2`, never 1.** The range is calendar days UTC, not a rolling
  window. `1` means "today, UTC", which is empty just after UTC midnight
  (5 pm in BC) — the layer blanked itself nightly in fire season with all
  three satellites reporting OK.
- **Columns by header name, never index.** The live CSV has an extra
  `instrument` column and no `type`, so positional parsing reads `"VIIRS"` as
  the confidence and downgrades every fire to low.
- **A bad or over-quota key returns HTTP 200 with an HTML body**, which
  parses as zero fires. The Worker rejects non-CSV bodies.
- `acq_time` is UTC `HHMM`, often unpadded (`629`). Combine with `acq_date`
  via `Date.UTC`, never by slicing an ISO string.
- The bulk `/archive/FIRMS` world CSV needs an Earthdata Login account —
  that is why we use the Area API and let NASA do the bbox filter.
- The bbox is trimmed to a disc server-side; corners carry fires 40% past the
  stated radius.

**Why no Postgres/PostGIS/cron** (the original spec): a province on fire is
~18,000 hotspots, 2.2 MB raw, **~180 KB gzipped** — one photo. Data worthless
at ~6 h does not justify a table and a second data path. The edge cache does
the whole job. Revisit only if agency incident feeds (perimeter polygons)
ever land — CWFIS / NIFC WFIGS / EFFIS were specced and never built.

---

## Caching and freshness — where the hours come from

| Layer | Delay | Ours? |
|---|---|---|
| NASA processing + pass gaps | 1–3 h | no — physics |
| Cloudflare edge (`/fires`, `max-age=3600`) | 1 h nominal, **4 h measured** | yes |
| Phone IndexedDB TTL | v1 `FIRE_TTL_MS` 5 min · v2 `FIRE_V2_TTL_MS` 20 min | yes |
| Bake loop tick + boot delay | 20 s + 20 s | yes |

- **Edge cache key** = `FIRE_ANSWER_VERSION` + centre snapped to 0.25° + km.
  Snapping turns a crew on one block into one upstream fetch.
- ⚠️ **Zone Browser-Cache-TTL rule outranks `max-age`.** The Worker sends
  3600; the response says 14400. The single largest staleness source we
  control, and it is a **dashboard** change, not code: Caching → Configuration
  → Browser Cache TTL → *Respect Existing Headers*. Still open.
- **Two caches compound, they do not overlap.** The phone TTL was 1 h to
  match the edge and produced `Last checked — 5h ago` with the app open. The
  edge protects NASA; a phone re-asking costs a cache hit. Keep the phone TTL
  short.
- **A TTL fixes STALE data, never WRONG data.** When a change alters what a
  correct answer looks like, bump **both** `FIRE_ANSWER_VERSION` (Worker
  cache key) and `FIRE_CACHE_VERSION` / `FIRE_V2_VERSION` (phone). The
  `DAY_RANGE=1` empties took four hours per cell to clear because nobody did.
- **Arrival beats the TTL** (`routes/fires/fireArrival.ts`). App open, tab
  visible, and `online` each arm a one-shot TTL bypass — **one debt per
  reader** (`"bake"` refreshes anchors, `"map"` refreshes what you look at);
  a single shared token let the bake tick eat the map's turn and every unit
  test still passed. Both the time gate and the geographic gate
  (`needsFireDisc`) must yield. Only arrivals arm it — never the 20 s loop, or
  it becomes a permanent poll over a burning province.
- **Never lie about zero fires.** Network error, bad key, HTML body → the
  Worker returns 502 and the phone **throws** and keeps its last good cache
  with an honest age. An empty collection reads as "no fires near you".
- **Fires can never break the map.** The whole fire pass is wrapped, not just
  the fetch — a failed IndexedDB read must not starve tile/photo downloads.

---

## Render contract — what the missing layer must do

The v1 layer is gone; these rules are the only record of it. They were each
bought with a field report, and the paint-side helpers still exist in
`routes/fires/` (`fireRelevance.ts`, `fireOutline.ts`, `fireSeverity.ts`,
`fireHotspotCopy.ts`, `fireClassifyCache.ts`, `masks/`, `lib/places/`).

- **ONE implementation, both maps.** Neither route builds a source, layer or
  card of its own; ids are a parameter. A "shared component plus extras" is
  two implementations.
- GeoJSON source with `cluster: true`; **no text layers**. The two maps have
  different glyph servers (bundled Noto vs hosted Mapbox fonts), and a symbol
  layer whose glyphs 404 stalls the whole source — including circle layers —
  with zero errors reported.
- `fireFeatureCollection()` (`fireRelevance.ts`) is the one hotspots →
  features builder. Never stamp a property at a call site.
- **The 500 km wall** (`HARD_CUTOFF_KM` = `FIRE_RADIUS_KM`) is measured from
  an **anchor set** — live fix + features touched in 30 days, capped at 3 —
  never from the camera or the body alone. Both wrong answers shipped: dots
  over Winnipeg with the user on the BC coast; no dots around a Manitoba
  block created from Vancouver.
- **Terracotta `#b36940`, never red** — red is the destructive-action colour.
  Cluster colour is `maxFrp` (**max, never sum/avg**); size is `point_count`.
- **A drawn fire is never faded** — not by age, not by distance. Both fades
  shipped and produced invisible smudges. Age lives in words on the card.
  Sole exception: industrial detections dim to 0.35 and the card says why.
- **One detection = one flame at every zoom.** A sub-z8 dot layer leaked as a
  second icon at the seam; delete substitution logic, never tune it. No count
  label — pixel counts read as scale-of-disaster.
- **City rule** (`masks/urbanExclusion.ts`, `URBAN_BUFFER_KM` 5, measured):
  detections within 5 km of a Natural Earth urban polygon are **excluded**
  worldwide. Fails toward showing; repaint once the polygons load.
- **Industrial rule** (`masks/staticHeatSources.ts`, mask from
  `ReTreever/scripts/buildStaticHeatMask.py`): a cell seen ≥12 distinct days
  in a year is **flagged, never deleted** — the refinery may really be on
  fire. Flagged FRP is excluded from cluster severity. Coverage is regional
  (BC/AB/PNW); outside it nothing is flagged.
- **Superseded ground** (`fireCache.ts`): a detection is dropped only when a
  *newer* fetch covered that spot and reported nothing, with
  `SUPERSEDE_SLACK_MS` for NASA's lag. Never by an age threshold.
- **Classification is a property of the data, not the frame.** `isUrban` per
  paint cost 200 ms per pan; `fireClassifyCache.ts` keys verdicts by cell and
  classifies in `await`-ed slices. **Never ask a destroyed map if it is alive**
  — `map.getSource()` after `map.remove()` throws; use the attach's own
  `isLive` flag, checked after every await.
- **Outline** (`fireOutline.ts`): flood-fill + convex hull, z13+, 334 m
  margin, groups ≥5 cells, thin unfilled line, no tap target. A reading aid,
  **not a perimeter** — a hull's area is the "area between the dots" error.
- **Hidden expires** (`lib/mapState/overlayVisibility.svelte.ts`,
  `FIRE_HIDE_TTL_MS` 12 h): hiding fire is momentary, never a preference; every
  failure path lands on showing.
- **Tap card** (`fireHotspotCopy.ts`, `fireSeverity.ts`): labelled rows, not
  prose; **hectares**; two time rows `First detected` / `Last checked` (two
  actors, two verbs — every other pairing was misread); hours with a decimal
  past 10 h, never "1 day ago"; no confidence row, no agency link, no
  disclaimers. A cluster summarises, it does not zoom. Severity is a table
  (area × peak FRP), trend compares halves of the passes, area is unique cells
  not detections (summing overstated 3.9×). The FRP cut points and size bands
  are measured percentiles — re-measure on a fire-season sample before moving.
- Location line is two tiers ("19 km NE of Whitecourt, 160 km WNW of
  Edmonton") from the bundled GeoNames asset in `lib/places/`; no reverse
  geocoding. A 23-hour-old `First detected` is **not** stale data — FIRMS ships
  two days of passes; measure `fetchedAt` before "fixing" it.

---

## v2 — the phone renders, it does not compute geometry

A disc arrives from the Worker deduped, clustered, outlined and
urban/industrial-classified. The phone stores three strings and hands them to
`setData()`. This removes the *possibility* of v1's passes; the data the phone
holds is no longer a shape you could run them on.

`fireCostV2.test.ts` is the architecture guard — it asserts on the shape of
the work (no hulls, no cross-disc union, no trig, no iterating a stored
payload, no `getAll()`, no v1 imports). **If it fails, do not relax it**; move
the derivation to the Worker.

### Worker route — `GET /fires?…&v=2` — what remains

1. ⚠️ **BLOCKING: the edge cache key drops the request's `?v=`.**
   `index.ts` builds the key from `FIRE_ANSWER_VERSION` + snapped centre only,
   so `?v=2` collides with `?v=1` on a warm cell and is served the v1 body.
   Cold cells answer correctly, so it looks intermittent. Read `v`, validate
   `1 | 2`, put it in the key as its own token. Do this first, alone.
2. Payload — pinned by `fireFetchV2.ts`, build to it exactly:
   `{ points, clusters, outlines }`, each a FeatureCollection. `points` is
   **required** (missing/malformed → the phone throws and keeps its cache);
   `clusters`/`outlines` optional, default empty. Point properties
   `t, c, frp, px?, dn?` are v1's shape; new is **`ind: 1`** on industrial
   detections — omit the key otherwise, never `true/false` (the cluster sum
   would add booleans). Ship `clusters` empty for the first cut — nothing
   renders it; native `cluster: true` does that job. The Worker's genuinely new
   work is `outlines` and `ind`.
3. ETag: hash the body (`crypto.subtle.digest`), set `ETag`, **add it to
   `Access-Control-Expose-Headers`** (or the phone reads `null` and silently
   never sends a conditional request), answer `If-None-Match` with a bodiless
   304 that still carries `X-Fetched-At` / `X-Sources-Ok`. The phone already
   handles all three outcomes.
4. Bump `FIRE_ANSWER_VERSION` to 4. Confirm gzip is negotiated — the live
   body is 2.86 MB raw, 180 KB compressed; a field phone cares which.

Keep the new logic on `firesWorker.ts`'s side of the line: pure, injected
fetch, no `Response`, no cache — `index.ts` owns those.

### Phone — what remains

1. Write `routes/fires/v2/fireLayerV2.ts` and point `LAYER` in
   `fireCostV2.test.ts` at it. The four red tests are its spec: `kmBetween` in
   exactly one place, `JSON.parse` only straight into `setData`, `if (!disc)`
   keeps the last good cache, `if (!isLive()) return` after every await.
2. Wire the bake ports (`retreeverPorts.ts`) to v2 alongside v1 so both
   caches fill on one device and can be compared.
3. Put the real layer ids into the Fires row of `wallLegend.ts`.
4. **Measure.** Fires-on must sit near the fires-off floor (274 MB online,
   963 MB offline as last measured; the ~690 MB gap between those is satellite
   textures, not fires). Materially above it means a derivation step crept
   back — find it, do not tune constants.
5. Delete v1 (`fireCache.ts`, `fireArrival.ts`, `fireOutline.ts`,
   `fireClassifyCache.ts`, `fireRelevance.ts` — their rules move to the
   Worker) and `FIRE_REFRESH_ENABLED`. Re-point the `describe.skip` blocks in
   `fireArrival.test.ts` and `masks/staticHeatSources.test.ts` at v2 rather
   than deleting them — they caught real drift.
