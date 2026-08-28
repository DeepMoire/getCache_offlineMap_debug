# Wildfire Layer — Build Spec

## Goal

Add a global active-fire layer to ReTreever. Field users (tree planters) need to know
whether there is fire activity near their block, including when they have no signal.

Two distinct data types, rendered as two distinct layers. **Do not merge or dedupe them.**

1. **Hotspots** — satellite thermal anomalies (NASA FIRMS). Global coverage. A hotspot is
   *not* a confirmed fire.
2. **Incidents** — agency-reported wildfires with human-confirmed status, size, and cause.
   Regional coverage only (Canada / US / Europe).

## Architecture

Server-side ingest, client reads from our own API. Do **not** call NASA or agency APIs
directly from the app.

```
NASA FIRMS world CSV (hourly cron)  ─┐
CWFIS  (Canada)                     ─┼─→  ingest worker  ─→  Postgres/PostGIS  ─→  our API  ─→  app
NIFC WFIGS (US)                     ─┤        (normalize + enrich)
EFFIS (Europe)                      ─┘
```

Rationale: one cron job at ~24 upstream requests/day, decoupled from user count.
Enrichment runs once server-side instead of on every device. Client talks to one
normalized schema regardless of which upstream feed the data came from.

### Stack

- **Ingest**: Cloudflare Cron Worker (hourly)
- **Store**: Supabase Postgres + PostGIS
- **Serve**: SvelteKit endpoint returning GeoJSON, bbox-scoped
- **Render**: Mapbox GL JS — use the native `cluster: true` GeoJSON source option for
  hotspots rather than hand-rolling clustering

---

## Phase 1 — Hotspot ingest (build this first)

### Source

NASA FIRMS publishes whole-world CSVs of the last 24h / 48h / 7d, updated hourly.
Use the 24h world file. Sensors: VIIRS S-NPP, VIIRS NOAA-20, VIIRS NOAA-21 (375m).
MODIS (1km) is optional — lower resolution, more noise.

A free MAP_KEY is required for the Area API (5000 transactions / 10 min). Register at
`https://firms.modaps.eosdis.nasa.gov/api/map_key/`. Store as an env var, never in the
client bundle.

**Verify the exact current download URLs and CSV column names against the live FIRMS docs
before writing the parser — do not assume from memory.** Start at
`https://firms.modaps.eosdis.nasa.gov/active_fire/` and
`https://firms.modaps.eosdis.nasa.gov/api/area/`.

### Table: `fire_hotspots`

| column | notes |
|---|---|
| `id` | stable hash of `lat + lon + acq_datetime + sensor` — upstream has no ID |
| `geom` | `geography(Point, 4326)`, GIST indexed |
| `acq_datetime` | timestamptz, UTC, indexed |
| `sensor` | e.g. `VIIRS_NOAA20_NRT` |
| `confidence` | FIRMS uses `l`/`n`/`h` for VIIRS, 0–100 for MODIS — normalize to an enum |
| `frp` | fire radiative power (MW) |
| `daynight` | `D` / `N` |
| `is_excluded` | boolean, set by the exclusion pass below |
| `exclusion_reason` | nullable text |

Upsert on `id`. Delete rows older than 7 days.

### Enrichment passes (run on ingest)

1. **Confidence filter** — keep all rows, but flag low-confidence. Expose as a client
   toggle, default off.
2. **Persistent-source exclusion** — maintain a `hotspot_exclusions` table of known
   non-wildfire thermal sources (mills, flares, refineries, gas plants) as buffered
   points/polygons. Flag any hotspot inside one. Seed it manually; add a mechanism to
   append entries. **This is the single biggest source of false-alarm complaints.**
3. **Land-cover flag** — flag detections outside forested land cover. In agricultural
   regions the majority of FIRMS detections are crop burning, which is noise for our
   users. Default the client to forested-only.

---

## Phase 2 — API + client render

### Endpoint

`GET /api/fires?bbox=w,s,e,n&since=<iso8601>&include_low_confidence=false`

Returns a `FeatureCollection`. Reject bboxes above a max area to prevent accidental
world pulls. Cache responses ~15 min.

### Rendering

- Hotspots: small uniform circles, clustered, **coloured by age** (0–6h / 6–12h / 12–24h 
  24h+). Age is the most decision-relevant attribute.
- Every popup must show the acquisition timestamp and a plain-language caveat that this is
  a satellite thermal detection, not a confirmed fire.

### Offline

Field users lose signal at the block. Fetch-on-map-open is exactly when it fails.

- Prefetch a buffered bbox (suggest 50km) around the **active project extent** on the last
  connected session, store in TinyBase alongside existing offline data
- Fall back to project extent, not device location — location services are a convenience,
  not the source of truth for where to fetch
- Display a prominent "as of Xh ago" staleness stamp whenever serving cached data. This is
  doing safety work, not decoration.

---

## Phase 3 — Regional incident feeds

Add these three only. Each is one integration covering a large area. Skip per-province and
per-state feeds — poor value per integration.

| Region | Source | Notes |
|---|---|---|
| Canada | CWFIS (NRCan) | national; preferable to integrating BC + AB + SOPFEU + ON separately |
| US | NIFC WFIGS open data hub | public ArcGIS REST, GeoJSON out, no auth on the open hub |
| Europe | EFFIS (JRC) | |

**Verify each endpoint against live docs before implementing.** Field names differ across
all three — that is the entire point of normalizing at ingest.

### Table: `fire_incidents`

Normalized across sources: `source`, `source_id`, `name`, `geom` (point), `perimeter`
(nullable polygon), `status` (enum: `out_of_control` / `being_held` / `under_control` /
`out`), `size_ha`, `discovered_at`, `updated_at`, `cause`.

Map each source's native status vocabulary onto the enum in the adapter, not in the client.

### Rendering

Larger markers than hotspots, coloured by **status** rather than age. Perimeters as a
semi-transparent fill where available. Users in Canada/US/Europe see both layers; users
elsewhere see hotspots only — this must degrade silently, not show an error.

---

## Constraints

- Agency data carries explicit accuracy disclaimers — BCWS and CIFFC both state their data
  should not be relied on as current or accurate. Surface a version of that in the UI.
- Never present either layer as authoritative for life-safety decisions. Link out to the
  responsible agency.
- No secrets in the client bundle.
- Follow the repo's existing "fail loud" convention — no empty catch blocks in the ingest
  path. A silently failing cron that serves 3-day-old fire data is a real hazard.