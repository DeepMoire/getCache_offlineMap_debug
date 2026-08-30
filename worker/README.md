# offline-tiles — range-serve the planet from R2

A Cloudflare Worker that turns one Protomaps **planet `.pmtiles`** archive on
**R2** into what the offline map downloads. Self-contained: own `package.json`
and `node_modules`, touches nothing above this folder.

```
GET /{z}/{x}/{y}.pbf      one MVT tile (range reads into planet.pmtiles)
GET /pack?lng=&lat=       every tile for one pin's area, packed into ONE response
GET /fires?lng=&lat=&km=  NASA FIRMS hotspots for one disc — proxied so MAP_KEY stays server-side
```

- Tiles are served gunzipped (raw protobuf); a missing tile is `204`, not 404,
  so the renderer overzooms cleanly. CORS is open, `OPTIONS` handled.
- Which Worker the app talks to (prod / dev / local) is the client's business:
  `../lib/r2Worker/README.md`.

## Run it locally — no Cloudflare account

```bash
npm install
npm run dev:local     # seeds a sample .pmtiles into the local R2 simulator, then wrangler dev --local
```

⚠️ The sample is one city (Florence, ~6 MB). Every North American pin gets an
empty 200 from it — see the root README's "Known broken".

## Deploy

```bash
npx wrangler login    # once
npm run deploy:dev    # → tiles-dev.getcache.org, no prompt; break this one freely
npm run deploy        # → tiles-prod.getcache.org, asks for confirmation — every shipped phone reads it
```

⛔ Never create `tiles-prod` / `tiles-dev` DNS records by hand — `wrangler.toml`
marks them `custom_domain = true`, the deploy provisions DNS + TLS itself and
fails (100117) if a record already exists. Scope a contractor's API token to
the dev Worker; Cloudflare then enforces the prod/dev split.

## Park the planet (once)

1. Download a dated build from https://maps.protomaps.com/builds/ (~120 GB).
2. `npx wrangler r2 bucket create offline-tiles`
3. Upload with rclone (resumable; R2 ingress is free):
   ```bash
   rclone copy 20260601.pmtiles r2:offline-tiles/planet.pmtiles --progress
   ```
4. ⚠️ The object key must equal `PMTILES_KEY` / `PACK_PMTILES_KEY` in
   `wrangler.toml` — a mismatch reads as "no tiles", no error.

## Test

```bash
curl -s "https://tiles-prod.getcache.org/8/40/88.pbf" -o tile.pbf && ls -la tile.pbf   # a few KB
curl -s -o /dev/null -w "%{http_code}\n" "https://tiles-prod.getcache.org/8/0/0.pbf"   # 204, open ocean
curl -s "https://tiles-prod.getcache.org/pack?lng=-76.84&lat=42.75" | wc -c              # ~340 KB
```

## Cost

~120 GB × $0.015/GB-mo ≈ **$1.80/month** storage; R2 egress is $0; reads sit
under the free tier. Set a billing alert (~$15/mo) and stop optimising it. To
stop the bill: `npx wrangler r2 bucket delete offline-tiles`.
