# offline-tiles — range-serve the planet from R2

A self-contained Cloudflare Worker that turns one Protomaps **planet `.pmtiles`**
archive parked on **Cloudflare R2** into ordinary XYZ vector tiles:

```
GET /{z}/{x}/{y}.pbf   ->   HTTP range reads into planet.pmtiles   ->   one MVT tile
```

This is the §6 "park the planet on R2 + range-serving Worker" decision from
`/Users/chrisharris/DEV/fetch/ReTreever/src/lib/mobile/docs/OFFLINE_PLAN.md`.
It exists so today's **Mapbox GL 3.23.1** — which has no native PMTiles support —
can read a whole-planet PMTiles archive as a normal `{z}/{x}/{y}.pbf` vector source,
with **no MapLibre migration**.

- Tiles come back **still gzip-compressed** (PMTiles stores MVT gzipped) with
  `Content-Encoding: gzip`, so the browser inflates them — the edge never decompresses.
- A **missing tile returns `204 No Content`** (not 404) so the renderer overzooms cleanly.
- CORS is fully open (`Access-Control-Allow-Origin: *`) and the preflight (`OPTIONS`) is handled.
- Header + directory reads are memoized per request via `ResolvedValueCache` (the
  pmtiles cache variant required on Workers, which can't share promises across requests).

Everything lives in this directory — its own `package.json` and `node_modules`. It does
not touch the app or the repo root.

---

## 0. One-time: log in

```bash
cd /Users/chrisharris/DEV/fetch/ReTreever/workers/offline-tiles
npm install
npx wrangler login
```

---

## 1. Park the planet

### Get the build

Grab the daily Protomaps planet build (the `protomaps/basemaps` build):

- Pick a build at **https://maps.protomaps.com/builds/** (download the dated
  `.pmtiles`, e.g. `20260601.pmtiles` — roughly **120 GB**).
- Background on the build: **https://maps.protomaps.com** and the
  `protomaps/basemaps` repo on GitHub.

Rename it to `planet.pmtiles` (or change `PMTILES_KEY` in `wrangler.toml` to match
whatever key you upload it under).

### Create the bucket

```bash
npx wrangler r2 bucket create offline-tiles
```

(Bucket name `offline-tiles` matches `bucket_name` in `wrangler.toml`.)

### Upload ~120 GB to R2

**R2 ingress (uploads) is free** — you only pay for storage. There is no upload bandwidth charge.

**Recommended for a file this big: `rclone`** (resumable, multipart, parallel — far more
robust than a single HTTP PUT). Configure an `r2` remote once with your R2 S3 API
credentials (Account ID, Access Key ID, Secret) from the Cloudflare dashboard
(R2 → Manage R2 API Tokens), then:

```bash
# one-time: rclone config  ->  new remote, type "s3", provider "Cloudflare",
# endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com
rclone copy planet.pmtiles r2:offline-tiles/ --progress
```

This uploads to `offline-tiles/planet.pmtiles`. Resume by re-running the same command.

**Alternative: `wrangler r2 object put`** (simpler, fine for smaller archives; for 120 GB
prefer rclone):

```bash
npx wrangler r2 object put offline-tiles/planet.pmtiles --file ./planet.pmtiles
```

---

## 2. Wire the binding (already done in `wrangler.toml`)

```toml
[[r2_buckets]]
binding = "TILES"            # what the Worker code reads: env.TILES
bucket_name = "offline-tiles" # the bucket you created above

[vars]
PMTILES_KEY = "planet.pmtiles" # object key of the archive in the bucket
```

If you uploaded under a different name, update `PMTILES_KEY` to match.

---

## 3. Deploy

```bash
npm run deploy        # == npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://offline-tiles.<your-subdomain>.workers.dev`.
To serve from your own domain instead, uncomment and edit the `routes` block in
`wrangler.toml`, then redeploy.

---

## 4. Test

```bash
# z/x/y of a populated land tile (zoom 8). Should download a few KB of gzipped MVT.
curl -s "https://offline-tiles.<your-subdomain>.workers.dev/8/40/88.pbf" -o tile.pbf
ls -la tile.pbf            # non-zero size => a real tile

# A tile in the empty ocean should come back 204 (no body), not 404:
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://offline-tiles.<your-subdomain>.workers.dev/8/0/0.pbf"
```

Point a Mapbox vector source at
`https://offline-tiles.<your-subdomain>.workers.dev/{z}/{x}/{y}.pbf` and it renders.

---

## 5. Cost

- **Storage:** ~120 GB × $0.015/GB-mo ≈ **$1.80/month** (~$22/year) — the only fixed cost.
- **Egress:** **$0** — R2 has zero egress fees, which is the whole reason for parking it here.
- **Reads + Worker requests:** sit under generous free tiers at any plausible Get Cache scale.

It is realistically **under ~$100/year**; you'd need runaway traffic to approach $200.

**Set a billing alert and stop optimizing it.** Cloudflare dashboard →
**Manage Account → Billing → Notifications** → add an alert around **~$15/month**.
To stop the bill entirely, delete the bucket (`npx wrangler r2 bucket delete offline-tiles`)
— the experiment is month-to-month and reversible.
