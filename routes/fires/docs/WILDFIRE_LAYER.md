# Wildfire Layer

Active-fire hotspots on the map, working offline. Field users need to know
whether there is fire activity near their block — including, especially, when
they have no signal.

This doc describes what IS. (The earlier `fireAPIs.md` build spec is superseded;
two of its choices were changed during implementation — see "Decisions that
changed" at the bottom.)

---

## The one-line version

**Offline-FIRST, never offline-only.** Cache is the source the map paints from,
always — but the newest data we can honestly get is what goes in that cache, and
the card says how old it is.

Those are one rule, not two, and the order matters:

| | |
|---|---|
| **Offline-first** | the map paints from IndexedDB, so it draws instantly and works with no signal. The network is never on the critical path to a rendered fire |
| **Never offline-only** | in signal, the cache is topped up aggressively — and **the moment a user arrives, we ask again** regardless of TTL (see Freshness) |
| **Always honest** | two rows, two verbs: `First detected` (NASA saw fire) and `Last checked` (we pulled the feed). Never two rows that could be read as the same fact |

⚠️ **The doc used to open "hotspots ride the same rails as the offline map",**
which read as *offline is the system and online is a variant of it*. That is
backwards for the thing users actually care about: **timing.** A planter checking
the map wants the most current data available, and the offline path is what
guarantees they get *something* when there is no signal — not the goal in itself.

Mechanically it is still one pipeline, which is the point: one Worker route, one
task in the existing bake loop, one IndexedDB box, one clustered map layer, and
**one fire layer shared by both maps**. There is no second system.

| Stage | Existing rail it rides | Fire's piece |
|---|---|---|
| Cloud | Worker `tiles.retreever.org` | `GET /fires` beside `/pack` |
| Trigger | `offlineBakeService` 20 s loop | `fireTask` beside `satTask`/`tilesTask` |
| Where | feature anchors (`anchorsOf`) | identical — no new location logic |
| Store | `makeKeyedIdbStore()` | `rt-fire-cache` |
| Paint | `setData` on a geojson source | `v4-fire-geo` + 3 layers |

---

## Data source

**NASA FIRMS Area API**, three VIIRS 375 m sensors (`VIIRS_NOAA20_NRT`,
`VIIRS_SNPP_NRT`, `VIIRS_NOAA21_NRT`).

```
https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/{w,s,e,n}/2
```

### ⚠️ The day range is CALENDAR DAYS, not a rolling window

`1` does **not** mean "the last 24 hours" — it means **"today, UTC"**. Just past
UTC midnight, today's satellite passes are not processed yet, so "today" is
genuinely empty and yesterday is excluded. Measured 2026-08-08 over southern BC
while dozens of fires burned:

| Request | Rows |
|---|---|
| `DAY_RANGE=1` | **0** |
| `DAY_RANGE=2` | **5,080** (every one stamped `2026-08-07`) |

The layer therefore blanked itself nightly at UTC midnight — **5pm in BC**, mid
afternoon in fire season — and reported "no fires near you" with all three
satellites reporting OK. So we request **2 days** and let the client decide what
is too old (every hotspot carries its acquisition time and the age ramp fades
them). Pinned by tests in `fires.test.ts`. Do not "optimise" it back to 1.

The key is a **Worker secret** (`FIRMS_MAP_KEY`) — the phone never talks to NASA
and never holds the key.

### ⚠️ The live CSV does not match NASA's docs

Docs say: `… satellite, confidence, version, bright_ti5, frp, type, daynight`
Live actually returns (verified 2026-08-07):

```
latitude, longitude, bright_ti4, scan, track, acq_date, acq_time,
satellite, instrument, confidence, version, bright_ti5, frp, daynight
```

There is an extra **`instrument`** column and **no `type`** — and `instrument`
sits exactly where the docs put `confidence`. **Index-based parsing would read
the string `"VIIRS"` as the confidence value and silently downgrade every fire
to low-confidence.** So `fires.ts` looks columns up BY NAME and throws if one is
missing. Locked by a verbatim-live-row test in `fires.test.ts`. Do not
"optimise" that back to positional parsing.

Other gotchas, all handled:
- VIIRS `confidence` is categorical `l`/`n`/`h` — NOT the MODIS 0–100 scale.
- `acq_time` is UTC `HHMM`, often unpadded (`629` = 06:29). Combined with
  `acq_date` via `Date.UTC` — never by slicing an ISO string (the UTC date trap).
- The bulk `/archive/FIRMS` world CSV needs a full **Earthdata Login account**,
  which is why we use the Area API (MAP_KEY only) and let NASA do the bbox filter.

---

## Why no Postgres/PostGIS

The original spec called for Supabase + PostGIS + an hourly cron. Measured
reality, both ends of the range:

| Disc | Hotspots | Raw | **On the wire (gzip)** |
|---|---|---|---|
| Ottawa, quiet | ~60 | 8 KB | ~2 KB |
| Vancouver, BC fire season | **18,230** | 2.2 MB | **~180 KB** |

Coordinates compress ~13×, and the route ships `content-encoding: gzip`, so even
a province on fire costs about one photo. Data this perishable (worthless at ~6 h)
does not justify an extension, a table, a migration, and a second data path. The
Worker's edge cache does the whole job.

⚠️ An earlier version of this doc claimed "~43 hotspots ≈ 6 KB" as the general
case. That was a quiet-region measurement generalised too far — real fire season
is two orders of magnitude larger. Size the storage budget off the Vancouver row.

Revisit only if incident feeds (perimeter polygons) land — those are bigger and
genuinely relational.

---

## Freshness — the one real difference from tiles

Tiles are immutable and cache for a year. Hotspots are not. Consequences, all
load-bearing:

- `/fires` caches **1 h** (FIRMS itself refreshes hourly).
- Every cached record carries **`fetchedAt`**, and the UI **must** show its age.
- `fireTask` refreshes on a **TTL**, not just when missing — unlike tiles,
  "we already have it" is not sufficient.

### The age chain — every layer that can hold an old answer

Freshness is not one number. Measured, worst case, end to end:

| Layer | Delay it can add | Ours? |
|---|---|---|
| NASA processing (satellite → FIRMS) | 1–3 h | ❌ physics |
| FIRMS refresh | ~1 h | ❌ theirs |
| Cloudflare edge cache | 1 h nominal — but a **zone Browser-Cache-TTL rule outranks `max-age`**, so the real window has been measured at **4 h** | ✅ |
| Phone IndexedDB (`FIRE_TTL_MS`) | 1 h | ✅ |
| Bake loop tick | 20 s | ✅ |
| Boot delay (`BOOT_BAKE_DELAY_MS`) | 20 s after app open | ✅ |

#### ⚠️ TWO CACHES COMPOUND — they do not overlap

The phone's TTL was **1 hour**, matching the edge's, on the reasoning that a
shorter one just re-fetches identical bytes. Wrong: the windows can be OFFSET,
so a phone receives a copy already 59 min old and holds it another full hour.

Field result: **`Last checked — 5h ago` with the app open**, and every cached
disc measured at 6+ hours on a real device.

**The edge cache is what protects NASA — not the phone's.** A phone re-asking
every 5 minutes costs a Cloudflare cache HIT, not a NASA call. So the phone's
TTL is now **5 minutes**, and online `Last checked` can only read **0–65 min**.
Anything larger means genuinely offline, which is when the number matters.

⚠️ A second bug wore the same symptom: `ensure()` has THREE call sites racing
for one arrival flag (idle boot, `style.load`, pan debounce). Whichever fired
first CONSUMED it and often did nothing — the debt read as paid with no fetch.
The gate now `peekFireArrival`s and only `settleFireArrival`s after a fetch is
genuinely attempted. Five tests pin it.

**Only the bottom four are ours.** NASA's 2–4 h floor is the physics of polar
orbits and cannot be engineered away — which is exactly why the layers we DO
control must not quietly add hours on top of it.

### ⚡ ARRIVAL beats the TTL — `fireArrival.ts`

⚠️ **A TTL answers the wrong question at the one moment freshness matters most.**

`FIRE_TTL_MS` asks *"has this data aged out on its own?"*, which is right for a
phone sitting in camp all afternoon. It is wrong when the planter has driven out
of the block, back into cell service, and opened the app **specifically** to find
out whether the fire has moved. A record fetched 59 minutes ago answers
`fireIsFresh` with `true` — so **both** fetch paths skipped, and we handed them
an hour-old answer without ever asking. Stack the edge cache on top and the
number on screen could be several hours old.

The three **ARRIVAL** moments arm a one-shot TTL bypass:

| Arrival | Why |
|---|---|
| app open | opening the app IS the ask |
| app/tab becomes visible | coming back is the same ask |
| **`online` fires** | **THE field moment** — `refreshFires` bails immediately while offline, so without this the first chance to catch up is the next 20 s tick, which then finds a "fresh" record and skips |

⚠️ **Both fetch paths must honour it, or the fix is half-done.** Two independent
places gate on the same TTL — `refreshFires` (bake service, owns downloads) and
`ensure()` (fireLayer, the online map's own coverage check). Arming one fixes one
map and leaves the other serving stale dots: the two-implementations disease this
doc exists to prevent. Hence a shared module, not a private flag.

⚠️ **BOTH GATES yield, not just the time one.** `refreshFires` has a second,
GEOGRAPHIC gate (`needsFireDisc` — "is a fresh neighbouring disc already covering
us?"). Both ask *"do we already have an acceptable answer?"*, so piercing only
the time gate lets the space gate quietly undo the fix. A test pins each.

⚠️ **The flag is CONSUMED, not read**, and **only arrivals arm it** — never the
20 s reconcile loop. A permanently-armed flag is indistinguishable from having no
TTL at all, and would turn an hourly fetch into a permanent poll over a burning
province (~180 KB a time). A test asserts exactly three arm sites.

#### ⛔ ONE DEBT PER READER — not one token both paths share

The first version was a single boolean consumed by whichever path asked first.
**Every unit test passed and the layer was still stale**, because in the real app
the bake service's 20 s tick reliably won the race and ate the token before the
map's `ensure()` ran. Caught in the browser, not by the suite.

The two readers refresh **different ground**:

| Reader | Refreshes |
|---|---|
| `refreshFires` (bake service) | discs around your feature **ANCHORS** — possibly a province from the camera |
| `ensure()` (fireLayer) | the disc you are **LOOKING AT** |

So "one fetch per arrival" was the wrong model; it is **one fetch per path per
arrival**, and neither can discharge the other's debt. `fireArrival.ts` holds a
`Set` of owing readers (`"bake"` / `"map"`), and `takeFireArrival(reader)` is a
`Set.delete`. Overlapping discs are deduped by `unionHotspots` anyway, so both
firing costs one extra request, not double data.

Verified live by intercepting `fetch` on one arrival — **two** `/fires`
requests, one per reader:

```
/fires?lng=-120.5&lat=50.5   ← map reader (the camera)
/fires?lng=-76.17&lat=45.06  ← bake reader (an Ottawa anchor)
```

Two tests pin it, and both fail on the shared-token version. A third asserts the
two call sites pass **different** reader ids — if they ever collide the race is
back and the whole suite still passes.

⚠️ **A refetch does not always change `fetchedAt`.** The Worker's edge cache may
serve a hit, which is correct and cheap. What our code controls is whether the
REQUEST goes out; measure that, not the timestamp, when verifying this.

### ⛔ The two time rows — `First detected` and `Last checked`

```
First detected   25.2h ago     ← NASA first saw fire here (how long it's burned)
Last checked     13 min ago    ← when WE last pulled the feed (how current this is)
```

**Different verbs, different actors — that is what makes them legible together.**
"Detected" is something a satellite does; "updated" is something we do. Neither
can be misread as the other.

Getting here took four wrong versions, and each failure is worth keeping:

| Version | Why it failed |
|---|---|
| `Seen 21h ago` alone | no actor — seen by whom? And no way to tell if OUR copy was old |
| `Last seen` + `Checked` | read as a contradiction: *"how could you SEE it if you hadn't CHECKED?"* One is per-FIRE, the other per-FILE, and no two-word label carries that |
| `Last detected` alone | correct but incomplete — still no answer to *"when did we last ping NASA?"*, asked four separate times |
| `Last detected` + `Last updated` | one row too many. *"Get rid of Last detected, it's very confusing"* — it only parsed for a reader holding the detect/update distinction |

⚠️ **`Last detected` was REMOVED, deliberately.** A card that needs its nuance
explained is a card that is lying. What survives answers two plain questions
with no technical background required: *how long has this been burning* and
*how current is this screen*.

#### Hours, never days — and fractions past 10 h

`1 day ago` collapsed 23 h, 28 h and 47 h into one useless phrase, on the row
someone reads while deciding whether to drive toward a fire. It also read as
indifference: *"stop saying one day, it's infuriating"*. A screen counting in
days, about a fire, looks like a screen that is not trying.

Past 10 h the value carries a decimal (`23.7h ago`, not `24h ago`): a round
number reads as a shrug, while a decimal is visibly a MEASUREMENT — and it is
one, since NASA stamps every detection to the minute (`2026-08-09 03:36:00`).

`Last checked` keeps MINUTE resolution all the way up and says **"Just now"**
under a minute, because with the arrival refresh that is the common case, and
`0 min ago` reads like a broken counter on the one value meant to build
confidence.

⚠️ **`Last checked` is the NEWEST contributing `fetchedAt`**, not the oldest —
it answers "when did we last go and look?", and we genuinely did look then. (The
layer-wide staleness stamp uses the OLDEST, for the opposite reason: it must
describe the weakest data on screen. Two questions, two aggregations.)

### ⚠️ A 23-hour-old detection is NOT stale data. Measure before you "fix" it.

An old age on the card reads like the app is serving day-old data, and it was
reported that way (against the since-removed `Last detected` row):
*"how could it be 23 hours if you check every 42 minutes?"* — sound reasoning
from what the card shows. **Measured on a real device, it was not stale.**

FIRMS ships **two calendar days** of passes in every response, so NASA's answer
from *minutes ago* legitimately contains detections from yesterday. Proof from
the live cache, for a card reading 24.7 h:

| Disc fetched | km to that fire | Covers it? |
|---|---|---|
| **0 h ago** | **8 km** | **yes** |
| 0.1 h ago | 162 km | yes |
| 23.6 h ago | 88 km | yes |

We asked about that exact ground minutes ago, and 24-hour-old detections were in
the reply. So the row means *"the most recent time NASA reported fire there was
23 h ago — and we know that as of minutes ago."*

⚠️ **Do not "fix" this by hiding old detections or by adding a download-age row.**
The first throws away the answer to the question being asked; the second is the
two-clocks contradiction this doc already killed. **Measure the cache first** —
`fetchedAt` vs each disc's newest detection — before concluding anything is
stale. The one genuine bug in this area was superseded ground (below), and it is
fixed.

### 📊 The real timing — measured, so this stops being re-litigated

Live measurement (2026-08-09, southern BC, `tiles.retreever.org`):

| Stage | Measured | Ours? |
|---|---|---|
| Newest detection available from NASA | **42 min old** | ❌ |
| Gap between satellite passes | **~30 min** (22 distinct passes in the file) | ❌ |
| NASA processing floor | ~1–2 h | ❌ |
| Worker response time | **2.1 s** | ✅ |
| **Cloudflare edge cache** | **`max-age=14400` — 4 HOURS** | ✅ ⚠️ |
| Phone IndexedDB TTL | 1 h (bypassed on arrival) | ✅ |

⚠️ **The 4-hour figure is CONFIRMED LIVE, not suspected.** The Worker sets
`max-age=3600`; the response header says `14400`. A **zone Browser-Cache-TTL
rule outranks the code**, and it is the single largest staleness source we
control. Fixing it is a Cloudflare dashboard change (Caching → Configuration →
Browser Cache TTL → *Respect Existing Headers*), not a deploy.

**NASA is the fast part; we were the slow part.** A card reading "a day ago" was
never the satellite — it was our cache. With the zone rule fixed the honest worst
case is about **two hours**, which is NASA's own floor and cannot be beaten by
any amount of engineering on our side.

**Age is communicated, never used as a reason to show nothing.** Law 1 is
constant presence: in the field, a day-old fire you can see beats a blank
screen. Age lives in WORDS on the card (`First detected`, `Last checked`) —
never in opacity, and never as a reason to hide the layer.

⚠️ **The ONE case where a detection is dropped is superseded ground** (below):
a newer fetch covered that spot and did not report fire there. That is not
"too old to show" — it is positive evidence the fire is out. Those are
different, and only the second justifies removing a mark.

⚠️ **`unionHotspots` reports the OLDEST contributing fetch time** — the stamp
must describe the weakest data on screen, so a recently-refreshed disc can't
vouch for a stale one beside it. **The card's `Last checked` uses the NEWEST**,
because it answers "when did we last go and look?", and we genuinely did look
then. Two questions, two aggregations; don't unify them.

---

### ⛔ SUPERSEDED GROUND — a fire the satellite looked for and did not find

**Downloaded yesterday, downloaded again today, drew BOTH PILES MIXED
TOGETHER.** Yesterday's fires stayed on the map even though today's data says
they are out.

Why the old pile survived: the dedupe key is `position + HOUR`, so the same
ground seen at 06:00 yesterday and 06:00 today are DIFFERENT keys and both are
kept — correct for merging discs fetched at the same time, catastrophic across
discs fetched a day apart. And `needsFireDisc` containment means the stale disc
is never re-fetched (a fresh neighbour "covers" it), so nothing replaced it.

Measured on a real device: a disc fetched **23.5 h ago** sat beside one fetched
**minutes ago**, both covering Harrison Hot Springs.

**The rule:** if a NEWER fetch covered this ground and did not report a fire
there, the fire is out. A satellite that has looked since and seen nothing is
evidence, and continuing to draw the old sighting is the map lying — the exact
failure this layer exists to prevent, pointed the other way.

⚠️ **Evidence-based, not a hardcoded age.** Each detection is dropped only if a
LATER fetch covered its location. Ground nobody re-checked keeps its last known
fire (Law 1, constant presence) — we discard only on newer evidence about THAT
SPOT, never on a "older than N hours" threshold there is no right value for.

⚠️ `SUPERSEDE_SLACK_MS` (30 min) exists because NASA's processing lags: a fire
detected minutes before our fetch cannot be in that fetch's data yet, and
without slack we would erase live fires. Five tests pin this, including that a
stale disc can never erase a fire from a fresher one regardless of array order.

## A TTL does not fix WRONG data — only STALE data

The DAY_RANGE bug took an hour to become visible after it was fixed, because the
empty answers were cached at **two** layers and both looked perfectly healthy:

| Layer | Why the fix didn't show | The lever that works |
|---|---|---|
| Cloudflare edge | Cached empties kept serving. Code says `max-age=3600`, but a zone Browser-Cache-TTL rule outranks it — the real window was **4 h per cell** | `FIRE_ANSWER_VERSION` in the **cache key** (index.ts) |
| Phone IndexedDB | 29 areas holding `0 hotspots`, all inside the 1 h TTL, so nothing refetched | `FIRE_CACHE_VERSION` bump (v4FireCache.ts) |

A TTL expires data that has grown OLD. It does nothing about data that was WRONG
when written — that record looks brand new. **Whenever a change alters what a
correct response looks like, bump BOTH version tokens**; they invalidate on
content instead of age and heal every device in one pass.

---

## Two rules the code exists to enforce

1. **Never lie about zero fires.** A network error, bad key, or HTML error body
   must THROW — never return an empty collection. "No fires near you" is the most
   dangerous thing this layer could say. The phone keeps its last good cache and
   shows an honest age instead. Four tests in `fires.test.ts` pin this.
2. **Fires can never break the map.** The whole `fireTask` is wrapped, not just
   the fetch: a failed IndexedDB read would otherwise abort the area and starve
   the satellite/tile downloads beside it. The map is the primary tool; the
   overlay must fail alone. Pinned by "offline tripwire 5" — it fails on the
   pre-fix code.

---

## Rendering — ⛔ ONE implementation, both maps

**`attachFireLayer` in `src/routes/mobile/map/fireLayer.ts` is the ONLY fire
layer.** Both maps call it. Neither builds a source, a layer, or a card itself.

```ts
// /mobile/map          — may top up from the Worker
attachFireLayer(map)
// /mobile/offlinev4    — pure viewer, the bake service owns downloads
attachFireLayer(map, { ids: OFFLINE_FIRE_IDS, canFetch: false })
```

| Route | Ids | Fetches? | Reads from |
|---|---|---|---|
| `/mobile/map` | `ONLINE_FIRE_IDS` (`rt-fire-*`) | yes, on `moveend` when the view isn't covered | IndexedDB first, Worker second |
| `/mobile/offlinev4` | `OFFLINE_FIRE_IDS` (`v4-fire-*`) | **never** | IndexedDB (bake service) |

The ids differ only because the offline route's layer-toggle registry has them
baked in. **Everything else — paint, clustering, the flame glyph, the tap card —
is one definition**, so a change reaches both maps by construction.

### Why this is a law and not a preference

The offline map used to hand-roll its own source and circle layers, with a text
count label and **no tap card at all**. Same data, two renderings: bare numbered
blobs (`16`, `8`, `53`) there, flames and a card here. It is the same disease as
the `ind` property one layer up — presentation living in two files means every
visual decision has to be remembered twice, and the second copy is always the
one that rots.

### "Same component" includes DELETING the one-map-only extras

The offline route also carried a `11156 hotspots · 3h ago` caption that
/mobile/map never had. It was left in place while the layer itself was
unified — and that is the failure mode to watch for, in the user's words:
*"technically it did use the same component, but it's the same component PLUS a
bunch of other stuff."* Sharing the component while keeping the extras is not
sharing the component; it just moves the divergence somewhere less obvious.

The caption is gone. The count of satellite pixels is not a fact anyone acts on,
and a feature present on one map and not the other IS the two maps disagreeing,
in a new costume. **The offline route now owns exactly one fire-related
variable: the `detachFire` handle.** No stamp, no state, no derivations.

Pinned by `staticHeatSources.test.ts` → "the offline route has NO hotspot-count
stamp of its own".

Six tests in `fireLayer.test.ts` fail if the offline route grows an
`addSource("v4-fire-geo")`, an `id: "v4-fire-…"` layer, a `point_count_abbreviated`
label, or drops `canFetch: false` — verified red-then-green. A seventh pins that
the shared file never hardcodes an id, so the two maps cannot collide.

Both sources are **geojson** with `cluster: true`. **Not** tile sources and no
per-layer min/max zoom: `offlineLaws.test.ts` scans source and fails the build
otherwise.

It attaches via the harness's `onMapReady` hook — proprietary logic stays in
`ReTreever/src/`, never inside an the harness component (the open-core rule).

⚠️ **The fontstacks differ and are NOT interchangeable.** The offline map serves
its own glyphs ("Noto Sans Regular"); the hosted online style 404s that name, and
a symbol layer whose glyphs never arrive stalls the entire source — including
circle layers that need no font. The shared layer therefore declares **no text at
all**. If text ever returns it must be a parameter, never a shared constant.

**Clustering does the restraint, and zoom IS distance.** There is deliberately no
distance-from-user logic: at block zoom the far fires are simply off-screen; zoomed
out everything collapses into a few counted blobs. Verified in-browser — 6 points +
3 clusters at z6.2, 1 point + 0 clusters at z13.

**Visual restraint** (hotspots are context, not content):
- `#b36940` — `--palette-terracotta`, the design system's CONTEXT accent.
  **Never red**: red means destructive action here (ghost/dismiss colour law).
- Age is expressed as **opacity** off that one hue (0.95 → 0.35), so the layer
  stays a single quiet voice rather than a traffic-light.
- Small (2.5–6 px), semi-transparent, below the user's own pins and draw layers
  (`raiseDrawLayers()` floats those above).
- **ON BY DEFAULT, and the hide EXPIRES.** The original ruling was no toggle at
  all: *"it's not even default you can't turn them off if there's fires they need
  to know."* An opt-in hazard layer is one a planter discovers the day AFTER they
  needed it. That reasoning still holds and is why the eye is not an ordinary
  preference — but a lone un-toggleable row in a legend of toggles reads as a
  bug, so the row exists and **re-arms itself**: hiding stamps a time, and
  `FIRE_HIDE_TTL_MS` (12 h ≈ one working day, `overlayVisibility.svelte.ts`)
  expires it back ON. Hiding fire is a momentary act ("the flames are over my
  plot numbers"), never a standing preference, and the legend note says so in
  words while hidden. Every failure path — unreadable stamp, blocked
  localStorage, garbage value — lands on SHOWING fires.

### The ONE hotspots → features function

`fireFeatureCollection()` in `fireRelevance.ts` is the only place hotspots
become paintable features. Both maps call it; neither stamps a property itself.

It exists because they used to. `fireLayer.ts` and `offlinev4/+page.svelte` each
hand-rolled the same walk — wall, `ageH`, `prom` — and when `ind` (the
industrial-source flag) was added it landed in the online map only. The two maps
disagreed about what a hotspot even is, and the only reason it never showed in
the field is that the mask asset had not shipped yet. Measured after the fix:
the offline map's source carries `ageH`, `ind` and `prom` on all 10,588
features; before it, only `ageH`.

**Do not stamp feature properties at a call site.** Add them to the shared
builder, where both maps get them by construction. Pinned by five tests in
`fireRelevance.test.ts` that fail on the pre-fix behaviour.

The legend toggle is a parameter of that same function (`hidden`), which empties
the collection rather than removing layers — so the source stays mounted and
coming back on is one `setData`, with no style surgery that could fail to
re-add.

Mapbox has no concept of "now", so age-in-hours (`ageH`) is stamped onto each
feature at paint time for the opacity step expression.

### The marker: flame in a circle

A hotspot reads as a **flame glyph inside a circle** (`/mobileAssets/fire_icon.webp`),
so it says "fire" without a legend. The two variables are INDEPENDENT:

| Variable | Driven by | Rule |
|---|---|---|
| circle SIZE | `point_count` | how many detections are folded in |
| circle COLOUR | `maxFrp` cluster property | the **worst single fire inside**, never a sum |
| opacity + glyph size | `prom` (distance from user) | loud near you, receding toward the wall |

**Colour must never be a sum or an average.** Merging many mild fires into one
cluster must not make it read as an inferno — that would be the map lying. So
`clusterProperties` aggregates `maxFrp` with `max`, and `prom` with `max` too
(a cluster is as prominent as its NEAREST member, so one close fire keeps the
group loud). A big-but-muted circle means "lots of small stuff over there"; a
small bright one means "one serious fire".

Colours stay in the terracotta family (`#b36940` → `#d18a5e`) — **never red**,
which is reserved for destructive actions (ghost/dismiss colour law).

**The halo is the cluster tell.** A cluster is a flame INSIDE a circle; a single
detection is a bare flame with no ring at all. That contrast distinguishes the
two at a glance, with no legend and no number to read. Below z8 singles fall back
to a small plain dot (a field of tiny flames at regional zoom is exactly the
"fire app" look this layer must avoid); the flame takes over from z8 up.

**No count label.** Printing "1.8k" beside a flame was tried and cut: the number
of satellite PIXELS in a blob is not a fact anyone acts on, and it reads as
scale-of-disaster when it is really scale-of-sampling. The circle's size carries
"how much"; tapping gives the real aggregate. Cluster circles cap at 16 px.

Because the count label is gone there is no `text-font` left in `fireLayer.ts` —
which is what the glyph bug below was about. If text ever returns, use
`mapInit.ts`'s stack and never the offline map's.

### 🔴 The outline — a thin red line around each fire

Thirty flames scattered on a hillside say "there are thirty things here", not
"there is A FIRE here". BC Wildfire's public map solves this with a perimeter
per incident, and the reassurance runs both ways: the fire is INSIDE the line,
and — the half that actually matters — **it is not outside it**.

`fireOutline.ts`, fed from the SAME `shown` list the dots come from, so the line
can never disagree with the flames inside it.

| | |
|---|---|
| Method | flood fill on the 375 m grid (join ≤2 cells ≈ 750 m) → convex hull |
| Skips | groups under 5 cells — a ring around one dot is noise |
| Margin | **334 m** outward, ~one flame icon |
| Zoom | **13 and up only** |
| Cost | 36,489 detections → 12,197 cells → 142 outlines, **~52 ms, 16 KB** |

⚠️ **NOT a fire perimeter, and must never be presented as one.** BC Wildfire's
outlines are surveyed on the ground; ours is a hull around satellite pixels — a
reading aid for dots already on screen. Hence: the dots are always still drawn
and stay the primary mark, the line is thin and unfilled (a pencil line, not a
hazard zone), and it has **no tap target, no card, no area readout**. A hull's
area would be the "area between the dots" error this doc rejects elsewhere — a
hull over six markers measured 22,328 ha of mostly unburnt hillside.

⚠️ **Convex, not concave, on purpose.** *"The lines don't have to be perfect,
you don't need a lot of points, just more or less."* Alpha shapes hug tighter
for an order of magnitude more code, on a shape nobody will measure.

#### ⚠️ Both tunables were overshot on the first try — nudge, never scale

| Knob | First attempt | Correct | Why |
|---|---|---|---|
| margin | 1,670 m (4 cells) | **334 m** (0.8 cells) | a huge empty swath between the flames and the line silently claims unburnt ground — worse than no margin |
| min zoom | 11 (`clusterMaxZoom`) | **13** | at z11 you are still surveying a region; scattered red polygons read as pollution — *"it's not a fire app, it's mostly about tree planting"* |

Four tests pin these: the gap must be **100–700 m**, it must **not scale with
the fire's size** (a fixed offset — a province-sized blob gets the same small
gap as a little one), the min zoom must be **above** `clusterMaxZoom`, and the
outline layer must sit **under** the flames.

#### The outline memo — same law as everywhere else in this layer

Outlines are a property of the DATA, so panning must never rebuild them. Two
tiers, both in `fireOutline.ts`:

| Tier | Key | Catches |
|---|---|---|
| fast | the hotspot ARRAY identity (a `WeakRef`) + its length | the common case — same data, another paint |
| second | the derived CELL SET | a re-derived array whose cells are unchanged |

⚠️ **The array key is a `WeakRef` on purpose.** A strong reference would let a
stale memo pin a 36,000-element hotspot array in memory — trading a recompute
for a leak, in the one module that actually holds tens of thousands of
detections.

⚠️ **It fails toward RECOMPUTING.** A missed hit costs one wasted rebuild
(~52 ms, correct output). A stale HIT would freeze the outlines while the fires
under them moved — and not lying about where fire is is this layer's entire
job. When in doubt, recompute.

### ⛔ A DRAWN FIRE IS NEVER FADED

Two fades were deleted, for the same reason, and the second took a second
telling because removing the first left it standing — so nothing visibly changed:

1. **Distance** (`prom`) — anchors broke the "far = less important" equivalence:
   fires around a pinned block rendered at ~0.3 while fires by the live fix sat
   at 1.0, so the same hazard looked like two different things.
2. **Age** (`ageH` ramp, 0.95 → 0.35 past 24 h) — produced a screen of
   nearly-invisible smudges. *"Why are they faded? Should I just keep saying
   it?"*

**THE RULE: a hotspot either passed the gate and IS a fire, or it is not on the
map at all.** There is no third state where it is a fire we half-mean. Both
facts already have an honest home in WORDS on the card, where they cost no
legibility — and legibility outdoors in sun is the only thing that matters.

⚠️ If a fire is too old to show, **stop showing it** (the superseded-ground
rule); never draw a ghost of it. Whispering is not a substitute for deciding.

The **industrial dim (0.35) stays** — the one exception, because it does not
mean "less fire", it means a permanent heat source that is not a wildfire, and
the card says so in words. Five tests fail if any fade returns.

### The tap card — facts, not disclaimers

Tapping either a single detection or a cluster opens a card. **A cluster
SUMMARISES; it does not zoom.** Zoom-on-tap was tried and cut: someone tapping a
blob is asking "what is that?", and answering by moving the map makes them chase
it through several zoom levels before learning anything. The aggregate IS the
answer; they can still pinch in for the individuals.

```
Fire detected
  Intensity   5 of 5  ●●●●●
  Status      Holding steady
  Size        9,464 ha
  Hot spots   1023 detected
  First detected  25.2h ago
  Last updated    13 min ago
  Nearest     40 km SW of Osoyoos, 48 km NNW of Okanogan, Washington
  From you    247 km E
```

#### Labelled rows, not sentences

Prose was tried and cut. Six lines of "46 km W of Merritt, 100 km NNE of
Chilliwack" stacked on "14 fire spots detected over 2 km²" had to be READ, in
order, to find any single fact. Rows can be SCANNED — someone who only wants
"how far is it" jumps to `From you`.

The label also does the qualifying work the value used to carry: `Size — 2 km²`
needs no explaining where a bare "2 km²" did. So **the value never repeats its
label** — `First detected — 9h ago` (not "Seen 9h ago"), `From you — 146 km NE` (not
"…of you"). Two tests pin that.

A cluster's card is deliberately the SAME SHAPE as a single detection's, with
one extra `Hot spots` row. A planter sees one fire marker; whether it is one
satellite pixel or two thousand is our plumbing, not their problem.

**Rows are omitted, never faked.** No gazetteer loaded → no `Nearest`. No GPS
fix → no `From you`. The always-knowable rows survive alone.

#### The Intensity glyph — a supplied gauge + a trend arrow

| Piece | Spec |
|---|---|
| Gauge | **Supplied artwork**, `static/mobileAssets/fire_intensity/{1..5}-fire_intensity.webp`. A ring that fills clockwise and walks gold → orange → red. Rendered at 19 px — a supplement to the number, never louder than it |
| Level | `intensityIconSrc()` clamps and rounds to the five files that exist, so an out-of-range level can never emit a 404'd `<img>` (which renders as a broken-image glyph on the card) |
| Arrow | **bare — no disc behind it.** The badge circle was dropped: chrome without meaning, and it shrank the arrow until direction was hard to read. 18 px, ~cap-height of the row's text |
| Growing | solid ▲ `#e63329` — a TRUE red. `#e2584a` read orange against the warm card and blended into the terracotta the layer already uses |
| Dying (`quieter`) | solid ▼ `#3fb95a` — a true green |
| Steady | short horizontal bar, white 60% |
| `new` / `absent` | muted dot, white 40% — **rendered, never omitted**, so the row doesn't jump when a fire gains its second pass |

⚠️ **Why the drawn ring was replaced.** It was a 5-segment `oklch` ring whose
level-5 state overshot its own start and laid the tail over the head, to say "it
has run its course". On the card that read as a **red hat perched on a circle** —
decoration nobody could decode, on the single most serious reading the layer can
report. The artwork closes the ring instead. Don't reintroduce a drawn ring
beside these files; `arcPath`, `polar` and `INTENSITY_RAMP` are gone with it.

The artwork still respects the palette's intent: levels 1–2 stay gold and must
not read as alarming, because red in this system means a destructive action (the
ghost/dismiss colour law). Level 5 is the one sanctioned exception.

⚠️ **Red-up / green-down is the classic colourblind confusion pair.** The
designer flagged it deliberately and it stays, because the SHAPE also carries
direction (▲ vs ▼) and the **Status row spells the same fact out in words**
directly beneath. The glyph is the at-a-glance echo, never the only carrier —
so never delete the Status row to save space. The colourblind-safe fallback, if
this is ever revisited, is shape-only with no colour (handoff direction B).

Both glyphs are `aria-hidden` and the "N of 5" text stays beside them.

#### ⚠️ One detection = ONE mark. There is no second icon.

A `circle` layer used to draw single detections below z8, handing over to the
flame above it. Two icons for one thing, with a zoom seam between them — and it
leaked exactly where you would predict: **a hotspot too isolated to join a
cluster** sat below the seam, rendered as a bare orange dot beside proper
flames, then "got its icon back" one zoom level later.

The fix was **deleting the dot layer**, not tuning the seam. Any logic that
decides WHICH icon a detection gets is logic that can decide wrong, and there is
no reading of this layer where a plain dot is the right answer. One detection,
one flame, at **every** zoom — and no `minzoom`/`maxzoom` on the flame, because
a zoom-gated icon is an icon that disappears, and whatever fills that gap
becomes the second mark again.

The dot's old justification was density at regional zoom. Clustering already
does that job (`clusterMaxZoom: 11`), so "a field of tiny flames" was never the
alternative. Restraint now comes from `icon-size` alone: the same glyph, smaller
when zoomed out. Size is the restraint, never substitution.

⚠️ **Consequence, accepted deliberately:** single detections now have no
fallback. If `fire_icon.webp` fails to load they do not render at all (clusters
still do, so the layer never vanishes entirely). That is the trade for killing
the substitution logic — which was failing visibly and constantly, whereas this
fails only if a same-origin bundled asset 404s. The warn in `ensureFireIcon` is
loud for that reason.

Pinned by three tests in `fireLayer.test.ts`, including that the offline route's
toggle registry no longer lists a dot layer.

**Card chrome:** gold title (`--rt-yellow`), rust labels (`--rt-rust`), cream
values — three descending voices rather than one flat terracotta wash. Padding
is deliberately tight (`0.7rem`): the card floats OVER the map, so every
millimetre is map the user can't see.

The ✕ is **28 px**, and clearance is given to the two rows it actually reaches —
the title (`h4 { padding-right }`) and the FIRST row
(`.rt-fire-row:first-of-type`), which is the one carrying the gauge. Never a
full gutter down the whole card: that gutter was what made the card cover most
of the screen, and the lower rows have dropped past the button entirely, so they
need the width for place names.

⚠️ At 36 px the button hung down level with the Intensity row and its box
collided with the gauge beside it (*"it's like ramming into the icon"*). If you
enlarge it again, re-check that row specifically.

#### The severity headline — two lookups, never one blended score

`fireSeverity.ts` holds a 16-row table: **area × peak FRP → level 1–5 + a
headline sentence**. Trend is a SEPARATE lookup on the FRP ratio between the
last two satellite passes. They stay independent because a large fire that is
dying and a small one flaring up are different situations, and one blended
number hides both.

The headline replaced `Hottest: Very high heat`, which read as a riddle —
hottest *what*? The reader sees one marker and neither knows nor needs to know
it is an aggregate of pixels. A test asserts no line contains "hottest",
"cluster", "peak" or "detection".

Note the table is deliberately **not symmetric**: a tiny blazing patch caps at
level 3 (one VIIRS pixel, 14 ha, is not a catastrophe however hot it reads), while a very
large *cool* burn still rates level 3 (area threatens ground). That asymmetry is
the entire reason it is a table and not a formula.

#### ⚠️ The FRP cut points are MEASURED — 3 / 15 / 90 MW

They were **10 / 50 / 200**, a stated first guess, and they were far too high.
Measured on live FIRMS over southern BC — 37,138 detections flood-filled into
302 fires — the peak-FRP distribution is:

| p10 | p25 | p50 | p75 | p90 | p95 | p99 |
|---|---|---|---|---|---|---|
| 0.7 | 1.2 | **3.3** | **13** | **89** | 266 | 865 |

The old cuts put **70% of every fire in the bottom band**, and **80% of lone
detections at level 1 of 5**. A scale where seven fires in ten score lowest
teaches the reader nothing.

Set to the measured **p50 / p75 / p90**, which spreads real fires
**49 / 27 / 14 / 10 %** across the four bands — and lets a genuinely hot single
detection reach 3 instead of being stuck at 1–2.

⚠️ **They are cut points on a DISTRIBUTION.** Re-measure before moving them, and
against a fire-season sample rather than a quiet week. They now live in three
named constants (`FRP_MODERATE_MW` / `FRP_HIGH_MW` / `FRP_EXTREME_MW`) — the
16 table rows referenced the raw numbers before, so the doc's old claim that
tuning was "a one-line edit" was not true.

**Two different aggregations, on purpose.** Heat is the PEAK, never a sum or an
average — merging twenty campfires must never read as an inferno (pinned: 20×5 MW
+ 400 MW uses 400, not 500). Area is the ground area of the UNIQUE ~375 m cells
burning.

⚠️ **Area is NOT a sum of detections.** It used to be, and that was a measured
**3.9× overstatement** — a card read `Size — 239 km²` for a fire that was really
~95. FIRMS reports the same ground once per satellite per overpass (three VIIRS
birds × two calendar days × several passes), so one burning hectare was counted a
dozen times. Measured on the real cluster: 1,228 detections → naive 373 km² →
**673 unique cells → 94.6 km²**.

⚠️ **Nor is it the area BETWEEN the detections.** A convex hull is the opposite
error and a worse one: a polygon drawn over six flame markers measured
**22,328 ha**, nearly all unburnt hillside. Detections are evidence of fire AT a
point; the gaps between them are evidence of nothing.

⚠️ **Each cell contributes ONE CELL, not its pixel's footprint.** Summing the
largest `px²` per cell was tried and over-counts: measured live, `px` runs
0.4–0.7 km while cells sit 0.375 km apart, so neighbouring pixels overlap. That
gave 280 km² for 712 cells whose distinct ground is ~100 km². The cell is the
unit; extra evidence about a cell doesn't make the cell bigger.

**"fire spots detected", not "fires detected".** A detection is a hot PIXEL, not
a distinct blaze; "20 fires" implied twenty separate fires when it is usually one
fire seen twenty times.

#### Units: HECTARES, always

Wildfire agencies (BC Wildfire, CIFFC) report fire size in hectares, and a
planter already thinks in them — blocks are measured in ha and they are paid by
the block. km² required a conversion nobody makes in their head, and it flattered
small fires badly: one detection showed as `0.14 km²`, which reads as nothing
when it is **14 hectares** of ground.

Formatting mirrors `formatArea` in `mapDrawUtils.ts` — the same function that
renders `22,328 ha` on a user's own drawn polygon, so a fire and a block are
described identically. It is mirrored rather than imported (that module pulls in
turf; `fireHotspotCopy.ts` is deliberately pure), and a test pins the two
against each other so the duplication can't rot.

#### The size bands MOVED with the area fix

The original bands (0.5 / 5 / 50 km²) were calibrated against the inflated
numbers. Southern BC across a fire-season sample — **21,607 detections → 257
clusters**, deduped — tops out at 30.5 km², so nothing would ever have reached
the old 50 km² "major".

| band | new | in ha | measured landing |
|---|---|---|---|
| spot | 0 – 0.25 km² | 0 – 25 ha | one pixel = 14 ha |
| small | 0.25 – 3 | 25 – 300 | median 208 ha |
| large | 3 – 15 | 300 – 1,500 | p75 676, p90 1,351 |
| major | 15+ | 1,500+ | p95 1,906, max 3,049 |

⚠️ **`SIZE_SPOT_MAX_KM2` must stay above one VIIRS pixel (0.1406 km²) and below
two.** That invariant is what keeps a lone detection at level ≤ 3 whatever its
heat — otherwise the layer cries wolf on a single hot pixel. Pinned by a test.

#### ⚠️ Trend compares HALVES, never the last two passes

The last-two comparison was measured against live FIRMS (37,138 detections,
596 fires with 3+ passes) and **disagreed with the fire's own full history in
64% of cases**. The pass-to-pass FRP ratio spans **0.20 → 3.43** (p10 → p90)
for reasons that have nothing to do with the fire: viewing angle across the
swath, cloud, and the day/night difference in the retrieval.

That is what produced two adjacent clusters reading "Dying down" and "Newly
spotted" for the same fire — each happened to contain different passes.

So `trendFor` averages the **earlier half** of the passes against the **later
half**, and needs `TREND_MIN_PASSES` (3) before claiming any direction at all.
One wild reading now moves the verdict a little instead of deciding it. Two
tests pin both directions: a single low pass must NOT read as "Dying down", and
a genuinely sustained decline still must.

#### Trend needs no new storage

Every hotspot already carries its acquisition time `t`, and the Worker fetches
TWO calendar days — measured, a single cached record holds **67 distinct pass
times spanning 37 h**. So `trendFor` groups a cluster's own detections into
30-minute pass buckets, takes each pass's peak, and compares the last two. No
schema change, no history table.

One pass only → `First detection`; claiming a direction from a single reading
would be invention.

⚠️ **`absent` ("Nothing detected on last pass") is never inferred.** It would
require knowing a pass happened AND covered this ground — a claim satellite gaps
and cloud make unsafe. Telling someone a fire is out when the satellite simply
did not look is the worst thing this layer could say. The band exists in the
type for a future incident feed that can support it.

**The editorial rule: report the measurement, don't apologise for it.** An
earlier card hedged — "not a confirmed fire", "may be a false reading",
"industrial sites, flares and burn piles all show up here" — and every word of
it was cut. A screen that spends more words apologising for its data than
reporting it teaches people to distrust the layer, and a planter deciding
something real does not need talking out of the map they opened.

Also dropped:
- **Confidence** (`l`/`n`/`h`) — a sensor-internal quality flag, not something a
  planter can act on. "Normal confidence detection" on every marker was noise
  wearing the costume of rigour.
- **The agency link.** A per-region link means owning a jurisdiction table for
  the whole world and maintaining those URLs forever, to hand someone a site
  that is useless across most of it.

Honesty now lives in WHAT is reported rather than in caveats around it: "Covers
about 375 m" is a plain fact that also happens to stop the pixel reading as a
surveyed perimeter, and "Fire detected" never claims a confirmed fire.

The words live in `src/lib/mobile/offlineV4/fireHotspotCopy.ts` — pure, no map,
no DOM, so every phrase is reviewable without a browser. `px` and `dn` remain
optional end to end: a feed without them degrades to a plainer card (footprint
falls back to VIIRS's nominal 375 m, phrased "about"), never to a failure.

### Where it is — "18 km NE of Whitecourt"

Every card leads with a plain-language location, the convention wildfire
agencies use: `<distance> km <16-point bearing> of <place>`, in **two tiers** —
nearest specific reference plus one larger anchor:

```
7 km ESE of Richmond
19 km NE of Whitecourt, 160 km WNW of Edmonton
2 km N of Cedar, 7 km E of Harewood, British Columbia
British Columbia          (roadless — the province still beats coordinates)
```

Two tiers, never one "best" place: the small name locates you, the big one
orients someone who has never heard of it. Picking one always loses a job.

| Rule | Why |
|---|---|
| tiers live in the DATA (major / notable / town / village), not a scoring function | prominence is already encoded; a population/distance heuristic is unreadable a year later |
| tiered by ADMIN STATUS first, population second | a county seat is a landmark whatever its headcount; a 100k dormitory suburb is not |
| radii 25 / 50 / 100 / 250 km per tier, no per-region exceptions | exceptions rot; one rule behaves the same in Alberta and Aotearoa |
| a more prominent place wins if it's **>40% closer** | otherwise a village 20 km out beats the city you're standing in — downtown Vancouver once read "20 km SE of Bowen Island" |
| the **province** is appended unless a MAJOR city is already named | guarantees one recognisable reference; ", British Columbia" after Vancouver would be padding |
| never `0 km of X` — say `at`/`near` under 2 km | the marker is bigger than that |
| round to 1 km under 100, 10 km above | precision the data supports |
| bearing runs PLACE → FIRE | reversed reads perfectly plausible and is 180° wrong; pinned by a test in words |
| the user's own block beats any town within 60 km | `14 km NW of your Sundance block` is the reference they actually hold |
| no highways as a location reference | agencies use them for visibility ("visible from Highway 43"), never for locating |

**No reverse geocoding.** Google/Mapbox answer a different question — the
administrative area CONTAINING the point ("Woodlands County"), not proximity
with a bearing — and cost per request, restrict storage, and need a network,
which is exactly what's absent at the block.

#### ⚠️ Neighbourhoods and suburbs are excluded — and it takes TWO rules

The card once read *"2 km SE of East Richmond–Fraser Lands, 4 km SW of
Hamilton"* for a fire beside Vancouver: three names nobody outside those blocks
knows. Two independent causes:

1. **Neighbourhoods.** Fairfield Island, Cedar Valley and East Richmond–Fraser
   Lands are GeoNames `PPLX` — "section of populated place". Dropped by feature
   code at build time.
2. **Suburbs that GeoNames does not label as such.** Burquitlam is tagged plain
   `PPL`, byte-identical to a standalone town, so **no code filter can catch
   it.** Geometry can: any sub-MAJOR place within 12 km of a MAJOR city is that
   city's suburb. Measured separation is clean — suburbs ≤10 km out (West End 8,
   Burquitlam 5), real towns further (Agassiz 15, Whitecourt 160). Drops ~22,000
   rows and makes the asset *smaller*.

Fixing (2) exposed a latent cascade bug the neighbourhoods had been hiding:
searching smallest-tier-first without regard to distance meant a village 20 km
away beat a major city 3 km away. Hence the "closer wins" rule above.

**The dataset ships in the app.** `static/mobileAssets/places-world.json` is
GeoNames `cities1000`, filtered and tiered to `[name, lng, lat, tier, region]` —
**5.9 MB raw, 2.35 MB gzipped**. Full rebuild recipe in `placeIndex.ts`. It loads LAZILY and is warmed when the fire layer
attaches, so the map's first paint never waits on it and a tap that beats the
load simply omits the line.

⚠️ The already-bundled `static/worldBase/base/min/places.json` was measured
first and rejected: 7,342 world places is far too coarse — **Whitecourt is not
in it** (nearest hit 150 km away), which is precisely the reference the spec
asked for. It stays as the offline map's label source; this is a separate,
denser asset for a different job.

### ⚡ Fires must never cost the map a frame

**The layer is an afterthought and must behave like one.** 95%+ of the time a
planter opened the app for something else entirely; a hazard overlay that makes
panning feel sluggish has failed regardless of how correct its data is.

⚠️ **It did, briefly, and the numbers say why.** `isUrban` linearly scans 11,878
urban polygons per hotspot. Measured on a real cache:

| step in `paint()` | cost |
|---|---|
| IndexedDB read | 14 ms |
| `unionHotspots` | 12 ms |
| the 500 km wall | 4 ms |
| `hotspotsToGeoJSON` | 2 ms |
| structured clone | 7 ms |
| **`isUrban` × 11,410 survivors** | **~200 ms** |

**17.8 ms per 1,000 hotspots**, blocking the main thread, on every pan — 10–50×
everything else combined.

#### The fix: classify ONCE, not per paint

Whether a hotspot sits in a city is **a property of the hotspot, not of the
paint**. It cannot change between frames. A spatial index would have made the
scan ~20× faster and still recomputed the same answer on every pan; caching the
verdict makes it O(1) forever.

`fireClassifyCache.ts` keys verdicts by the ~375 m cell (`cellKey`), so tens of
thousands of detections collapse into a few hundred distinct questions.

| | before | after |
|---|---|---|
| paint-time cost | 17.8 ms / 1,000 | **0.14 ms / 1,000** |
| a normal paint | ~200 ms blocked | **~5 ms** |

**127× faster**, measured in-browser.

`paint()` reads only what is already known and returns; the unknowns are
classified afterwards in `CLASSIFY_SLICE` (400) chunks that `await` between
slices so the thread is released, and it repaints **once** and only if it
actually learned something — so panning over ground it has already seen costs
nothing at all.

⚠️ **An unknown cell reads as NOT urban, so the hotspot renders.** Failing
toward SHOWING is the right direction: an unclassified city dot that disappears
a moment later is a blink, whereas a real fire suppressed because classification
hadn't finished is the failure this layer exists to prevent.

#### ⛔ Never ask a destroyed map whether it is alive

`refineUrban` is fire-and-forget and awaits between slices, so it resumes on a
map the user may already have navigated away from. The first version guarded
with `map.getSource(...)` — and that guard was itself the crash:

```
[UNHANDLED REJECTION] TypeError: Cannot read properties of undefined
  (reading 'getOwnSource')   at refineUrban (fireLayer.ts)
```

`map.remove()` calls `setStyle(null)`, and Mapbox's `getSource` dereferences
`this.style` with no null check. **A guard that needs a live map to report a
dead one is not a guard.**

Liveness is the attach's own `disposed` flag, passed down as `isLive` — the
mechanism every other async path in this file already used. It is checked
**after** the await as well as before, because the crash window is the slice
boundary: alive on entry, destroyed by the time `classifyPending` resolves.
Four tests pin it, including one that fails if the post-await check is removed.

#### The SECOND half: don't re-derive the whole cache on every pan

Fixing `isUrban` left the offline map still hitching, and the obvious
explanations were both wrong. Worth recording, because the wrong answers were
plausible:

| suspected | measured | verdict |
|---|---|---|
| the defensive deep clone in `paint()` | **2.8 ms** on 883 KB | not it |
| offline tile decode (no server → phone does the work) | already in a Worker | **not it** |
| Mapbox symbol placement | 0 rendered features, still blocking | not it |

The decisive experiment: removing our own `moveend` listeners took a pan from
**260 ms blocked to 0**. Leave-one-out across the nine handlers named a single
culprit — the fire layer's own `ensure()` debounce.

`ensure()` calls `paint()`, and `paint()` re-read **every cached disc out of
IndexedDB (24 ms, 73,225 hotspots)** and re-deduped them (**25 ms**) — ~49 ms
per pan, to produce a **byte-identical** answer. Panning the camera cannot
change which fires are cached.

So `v4FireCache.ts` memoizes both, invalidated by `writeFireCache` /
`deleteFireCache` — the only two things that can change the answer:

| | before | after |
|---|---|---|
| read + union per pan | **75.1 ms** | **0.1 ms** |
| offline pan | 260–370 ms blocked | **0 ms** |
| online pan | 312 ms blocked | 109 ms |

**750× on that step.** Same shape as `fireClassifyCache` and for the same
reason: **what the cache holds is a property of the DATA, not of the frame.**
Compute on write, reuse on read.

⚠️ The memo is keyed on the ARRAY IDENTITY that `allFireEntries()` returns, so a
caller passing its own array (a test, a filtered subset) always computes fresh
and can never poison it.

### 🏙️ No wildfires in the city — THE primary false-alarm filter

**A detection inside (or within 5 km of) a mapped urban area is EXCLUDED,
worldwide.** This is a wildfire layer, and it follows the convention every
wildfire agency uses: BC Wildfire's own public map plots fires in the mountains
north-east of Chilliwack and leaves the entire Vancouver / Richmond / Delta /
Surrey basin empty — even though FIRMS reports hotspots there daily.

| | |
|---|---|
| Asset | `/worldBase/base/min/urban.json` — **already bundled** for the offline map's built-up shading. 11,878 Natural Earth polygons, world coverage, zero new download |
| Buffer | **5 km**, measured |
| Scope | the whole world, day one |
| Behaviour | **excluded**, not flagged — see below |

⚠️ **Why 5 km and not 0.** Natural Earth's polygons hug the built-up core, while
industrial land — tank farms, rail yards, port terminals — sits in the fringe
just outside. Measured against the four real false alarms around Vancouver: at
0 km only **one** was caught; at 5 km **all four** were, with a deep-BC-bush
fire and the town of Whitecourt both kept. Don't raise it casually — every extra
kilometre eats real bush.

#### ⚠️ Why this REPLACED archive-persistence as the primary rule

The first attempt derived a mask from a year of FIRMS history: flag any ~375 m
cell seen on ≥12 distinct days (NASA's own `type` 2 definition, which the NRT
feeds don't populate). It worked on the cell it was tuned against — and missed
the very next one, whose cells showed **9 and 8 days**: real industrial
persistence sitting just under the threshold.

Chasing that with a lower number trades one arbitrary threshold for another,
needs a year of archive per region, and must be rebuilt annually. **Geography is
the stable signal.** The persistence mask is KEPT as a secondary catch for
isolated industry out in the bush (mills, camp flares) where no urban polygon
exists, but the city rule does the heavy lifting and needs no history at all.

#### ⚠️ This EXCLUDES; the refinery rule FLAGS. Different reasoning.

The one place this layer hides data. A lone refinery out in the trees is a
landmark worth showing dimmed — it might genuinely be on fire and there is
nothing else out there. A hotspot in downtown Vancouver is noise that makes the
map look broken; a city fire is a municipal fire department's business, and a
planter has no use for it either way.

**It fails toward SHOWING fires.** No polygons loaded → nothing excluded → every
detection renders. And the layer **repaints once the assets land** (`loadUrban()`
awaited, then `paint()`): a first paint that beat the polygons would render city
hotspots and leave them there — exactly the bug this rule exists to kill, and
one that actually occurred during development.

### 🏭 Industrial heat sources — flagged, never deleted

Refineries, mills, gas flares and landfill gas register as hotspots **every
single day**. A bulk tank farm on the Fraser River read as a wildfire beside
Vancouver, permanently — the single biggest source of false-alarm complaints in
every FIRMS-based product.

**NASA already defines this**: inferred hotspot `type` 2 = "other static land
source". But `type` is populated ONLY in the science-quality monthly products
(MCD14ML / VNP14IMGML), **never in the NRT feeds we use**. So we replicate the
rule rather than invent one.

| | |
|---|---|
| Rule | a ~375 m cell detected on **≥ 12 distinct days** in a rolling year is a permanent source |
| Data | a year of FIRMS archive, pulled by `scripts/buildStaticHeatMask.py` |
| Asset | `static/mobileAssets/static-heat-sources.json` — a flat list of cell keys |
| Matching | the cell **and its 8 neighbours** — a pixel wanders a few hundred metres between passes, so exact-cell matching alone lets the same stack through about half the time |
| Rebuild | yearly; the rule re-derives rather than needing a hand-maintained list |

**Measured, Vancouver, Apr–Aug 2026:** the tank-farm cell appeared on **14
distinct days**; genuine transient fires in the same bbox showed **1–4**. The
separation is not subtle.

**The shipped mask**, built from a full year over BC / Alberta / PNW: **86,242
detections → 48,585 cells touched → 36 persistent** (1 KB). Nobody listed any of
them; the rule surfaced the Athabasca oil sands, Edmonton's refinery row, the
Kitimat smelter and the Port of Seattle on its own. That it stays at 36 rather
than thousands is the signal the threshold is right — a mask in the thousands
would mean it had started swallowing real fires. Pinned by
`shippedStaticMask.test.ts`.

⚠️ **Coverage is regional** (-140..-108 lng, 46..62 lat). Outside that box
nothing is flagged industrial — the layer fails toward showing everything as a
fire, which is the safe direction, and the CITY rule above is worldwide anyway.
Widening is just more tiles in the build script.

⚠️ **Distinct DAYS, not detection COUNT.** Several satellites cross the same
cell a dozen times in one afternoon; counting rows would flag every large
wildfire on its first day.

#### ⚠️ Urban land cover was tried FIRST and rejected

The obvious cheap rule — flag anything inside an urban polygon, using the
`urban.json` already bundled — fails on the exact case it was meant to fix: the
Richmond tank farm sits on industrial land just **outside** the mapped urban
area. Measured, not assumed. Urban cover is at best a secondary signal.

#### ⚠️ FLAG, NEVER DELETE

A refinery genuinely can catch fire, and slash piles do burn on urban fringes.
NASA labels rather than removes; so do we:

- flagged detections render **dimmed** (0.35 opacity) but remain on the map
- they stay tappable, and their card carries a `Source — Industrial heat source`
  row that says plainly what it is
- their FRP is **excluded from a cluster's severity**, so a flare burning at a
  steady 40 MW can't colour the wildfire beside it
- a cluster shows the Source row only when **every** member is industrial — a
  mixed cluster is a fire that happens to contain a flare, and labelling it
  industrial would be the map talking someone out of a real fire

Hard-deleting would mean the app says **nothing** on the day Burnaby's refinery
actually goes up — the one day it would matter most.

**The mask fails toward SHOWING fires.** A missing or half-loaded asset yields
an empty set, which flags nothing, which renders every detection as a wildfire.
A refinery briefly mislabelled is an annoyance; a real fire suppressed by a
broken mask is the failure this whole layer exists to prevent.

### ⛔ THE 500 km WALL — relevance is measured from your ANCHORS

`fireRelevance.ts` is the single gate every drawn hotspot passes through.
**Past `HARD_CUTOFF_KM` (500) from every anchor: nothing renders, at any size.**
This is a promise the UI keeps, not a tunable — it deliberately equals
`FIRE_RADIUS_KM`, so we draw exactly what we download and not a kilometre more.

Inside the wall, prominence tapers with distance (opacity + marker size), and a
size-vs-distance gate (`frpGateAt`) means a far fire must be BIG to keep its
pixel while anything within `NEAR_KM` (50) is always shown whatever its size —
a small fire at your block outranks a large one on the horizon.

**Three earlier attempts failed because they measured the wrong thing:**

| Attempt | Why it failed |
|---|---|
| shrink the fetch radius 500 → 300 | a chain of accumulated discs still all painted; reverted |
| shrink the cluster circles | same dots, smaller |
| filter to the SCREEN bbox | at continental zoom the screen IS the continent, so it filtered nothing |

The real cause: **nothing in the render path measured distance from the USER.**
`FIRE_RADIUS_KM` was only ever a download bbox handed to NASA. Worse, discs are
fetched around `map.getCenter()` — the CAMERA — so every pan minted a new disc
anchored wherever you looked, and they all painted forever. Reported from the
field as hotspots over Winnipeg, Bismarck, Minneapolis and Des Moines while the
blue dot sat on the BC coast, ~2,000 km away.

Those four cities are named regression cases in `fireRelevance.test.ts`,
including at an absurd 999,999 MW — **size never buys passage past the wall.**

#### The origin is an ANCHOR SET, not a point

Measuring from the user alone was the *second* wrong answer, and it produced its
own field report: a user in Vancouver created a feature in Manitoba and saw no
fires around it. The bake service had **already downloaded them** —
`refreshFires()` bakes a 500 km disc around every feature anchor and always
has — but `paint()` collapsed the origin to `readStoredFix() ?? mapCentre`, so
all 125 cached Manitoba hotspots failed the wall. The layer went silent about
the one piece of ground the user had just told it they cared about.

The root cause was a DEFINITION error, not a distance one: *relevant* meant
proximity to your **body** when it should mean proximity to **ground you are
responsible for**. A planter is usually not standing on their block.

`fireOrigins()` (`src/routes/mobile/map/fireOrigins.ts`) resolves the set:

| Rank | Anchor | Notes |
|---|---|---|
| ∞ | the live fix (`readStoredFix()`, never prompts) | where you ARE |
| by `lastTouched` | features touched in the last `ANCHOR_MAX_AGE_MS` (30 d) | ground you have a stake in |

Deduped at `ANCHOR_MERGE_KM` (200 km), capped at `MAX_FIRE_ANCHORS` (3) — every
anchor is another 500 km disc, and enough of them turn the wall back into the
continent of dots it exists to kill. A hotspot survives if it is inside the wall
of ANY anchor; `km`, `prom` and the card's "42 km NE" all use the **nearest**
one. The map centre remains a last-resort fallback (no fix, no features).

**This was a RENDER-side fix only** — nothing new is downloaded, no extra
battery, no new permission. The data was already on the phone.

⚠️ **A sparse layer near an anchor is often CORRECT.** Measured on real data:
only 16 of the 132 hotspots within 500 km of that Manitoba block render — none
are inside 100 km and the rest are sub-2 MW smoulders needing 20+ MW at that
range. That is `frpGateAt` doing its job. Check the FRP gate before concluding
an anchor failed.

⚠️ Use **feature** `lastTouched`, never **map** `lastTouched`: a map's stamp
moves on switchMap / reorder / import, so it answers "which map did you look at",
not "which ground did you touch".

### ⚠️ The two maps have DIFFERENT glyph servers — never share a fontstack

This is what made the layer invisible on `/mobile/map` for an entire session
while it rendered perfectly on `/mobile/offlinev4`.

| Map | `glyphs` URL | Font to use |
|---|---|---|
| `/mobile/offlinev4` | `/worldBase/glyphs/{fontstack}/…` (bundled, same-origin) | `Noto Sans Regular` |
| `/mobile/map` | hosted Mapbox style (`api.mapbox.com`) | `DIN Pro Medium`, `Arial Unicode MS Bold` |

Asking the hosted style for `Noto Sans Regular` 404s every glyph range — and
**a symbol layer whose glyphs never load stalls the entire source**, including
the circle layers beside it that need no font at all.

The symptom is maximally misleading and cost hours:

```
inSource: 16717      isSourceLoaded: true      map 'error' events: 0
querySourceFeatures('rt-fire-geo'): 0          nothing drawn
```

Nothing reports a font problem. The source simply never tiles. Pinned by
`src/routes/mobile/map/fireLayer.test.ts`, which fails on the bad font.

---

## Files

| File | Role |
|---|---|
| `workers/offline-tiles/src/fires.ts` | FIRMS fetch, CSV parse, dedupe (pure logic) |
| `workers/offline-tiles/src/index.ts` | the `/fires` route |
| `src/lib/mobile/offlineV4/v4FireCache.ts` | IndexedDB box + staleness helpers |
| `src/lib/mobile/offlineV4/fireArrival.ts` | **the ARRIVAL rule** — a one-shot TTL bypass both fetch paths consume |
| `src/lib/mobile/offlineV4/fireOutline.ts` | **the thin red line** — flood fill + convex hull, gated to z13 |
| `src/lib/mobile/offlineV4/v4FireFetch.ts` | phone → our Worker (timeout, fail-loud) |
| `src/lib/mobile/offline/onPhone/bake/bakeService.svelte.ts` | `refreshFires()` pass + eviction |
| `src/routes/mobile/map/fireLayer.ts` | **THE fire layer — BOTH maps.** Source, layers, flame glyph, cache-first fetch, tap card, intensity ring + trend badge |
| `src/routes/mobile/map/fireLayer.test.ts` | pins the fontstack, always-on, **and that the offline route never grows a second implementation** |
| `src/routes/mobile/offlinev4/+page.svelte` | OFFLINE map: calls `attachFireLayer(map, { ids: OFFLINE_FIRE_IDS, canFetch: false })` and owns the freshness STAMP only — no layers of its own |
| `src/lib/mobile/offlineV4/fireHotspotCopy.ts` | the tap card's WORDS (pure, tested) |
| `src/lib/mobile/offlineV4/fireSeverity.ts` | severity table + trend lookup |
| `src/lib/mobile/fires/masks/urbanExclusion.ts` | **the city rule** (primary filter) |
| `src/lib/mobile/offlineV4/fireClassifyCache.ts` | keeps the city rule off the paint path |
| `src/lib/mobile/fires/masks/urbanIndex.ts` | urban-polygon loader (reuses a bundled asset) |
| `src/lib/mobile/fires/masks/staticHeatSources.ts` | the industrial-source rule (secondary) |
| `src/lib/mobile/fires/masks/staticHeatIndex.ts` | mask loader |
| `scripts/buildStaticHeatMask.py` | rebuilds the mask from the FIRMS archive |
| `src/lib/mobile/places/placeReference.ts` | "18 km NE of Whitecourt" |
| `src/lib/mobile/places/placeIndex.ts` | gazetteer loader + rebuild recipe |
| `src/lib/mobile/offlineV4/fireRelevance.ts` | **THE 500 km wall** + distance falloff + **`fireFeatureCollection` (the ONE hotspots→features builder both maps use)** |
| `src/lib/mobile/offlineV4/fireRelevance.test.ts` | pins the wall (named city regressions) + the shared builder's stamped properties |
| `src/lib/mobile/stores/overlayVisibility.svelte.ts` | the `fires` toggle + `FIRE_HIDE_TTL_MS` (hiding expires back ON) |
| `src/lib/mobile/components/mobMap/MapLegend.svelte` | the Wildfire legend row — ONE component, shared by both maps |
| `src/lib/mobile/offline/onPhone/store/dbCatalog.ts` | registers `rt-fire-cache` as LIVE |

`rt-fire-cache` **must** stay registered in `dbCatalog.ts` — an unregistered DB is
classified dead and `/admin/files` offers to wipe the layer's only offline copy.

---

## Decisions that changed from the original spec

- **Storage: TinyBase → keyed IndexedDB.** The spec said TinyBase; that violates
  `big-map-storage-split` (big local-only payloads never go in TinyBase).
- **No Supabase/PostGIS in phase 1** — see above.
- **Anchor: feature anchors, not device location.** Matches the spec's own
  reasoning ("location services are a convenience, not the source of truth") and
  costs zero new plumbing, since the bake service already walks every anchor.

---

## Not built yet

Agency incident feeds (CWFIS / NIFC WFIGS / EFFIS), the persistent-source
exclusion table (mills, flares, refineries — the biggest source of false-alarm
complaints), and the land-cover flag. Each is an adapter onto this same pipeline,
not new architecture. Backlog lines live in `docs/TODO.md`.
