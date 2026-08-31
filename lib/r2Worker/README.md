# r2Worker — the tile Worker as the app sees it

The Worker itself is `../../workers/` — one folder per tier, named exactly
like the CONFIG panel rows: `local_dev/` is the copy you edit and run,
`r2_dev/` and `r2_prod/` are the record of what each cloud tier is running
(their deploy scripts sync from local_dev, then deploy). This folder is the
**client half**: which host the app talks to, the `/pack` downloader, the
fires fetch.

## Three tiers, one URL shape

| tier | CONFIG panel | hostname | who creates it |
|---|---|---|---|
| prod | `r2_prod` | `tiles-prod.getcache.org` | `./deployProduction.sh` in `workers/r2_prod/` (asks to confirm) |
| dev | `r2_dev` | `tiles-dev.getcache.org` | `./deployDev.sh` in `workers/r2_dev/` — same R2 bucket, so a prod/dev difference is always CODE, never data |
| local | `local_dev` | `tiles-local.getcache.org:8787` → 127.0.0.1 | `npm run dev:local` in `workers/local_dev/` — no Cloudflare account needed |

`GET /pack?lng=&lat=` returns a map pack; `GET /{z}/{x}/{y}.pbf` a tile.

- ⛔ prod and dev hostnames are made by `wrangler deploy` (`custom_domain = true`).
  Never create them by hand in the dashboard — the deploy then fails (100117)
  and there is no `--force`. `tiles-local` is the one hand-made DNS record
  (A → 127.0.0.1, DNS-only); nothing else will ever create it.
- ⛔ No prod/dev host is baked into this child — `routes/+layout.svelte` calls
  `configureTilesFromEnv()`, which reads `VITE_TILES_HOST` / `VITE_TILES_DEV_HOST`
  from the `.env` beside vite's root (`rapper/.env`, written by `npm create`).
  Unset → `null` → the row greys out, and the console warns on the first line.
  A hardcoded default bills the maintainer's R2 account for every stranger who
  installs the package.
- A dev build defaults to `local_dev` — the developer starts pointed at their
  own machine and fixes what's in front of them. A shipped phone is locked to
  prod by `getWorkerTarget()`'s `!import.meta.env.DEV` early return (compile-time
  dead code on a device), so it can never be left on a sandbox.
- `tierNaming.test.ts` fails the build on any other tile hostname spelling.

## A tier looks dead but isn't

A resolver asked about a hostname before it existed caches NXDOMAIN for up
to 30 min. `dig +short tiles-prod.getcache.org @1.1.1.1` is the truth; if it
prints IPs and your own resolver doesn't, wait it out.

## Two folders — `local_dev/` and `r2_prod/`

⛔ **Do not delete or merge them because they look identical.** `local_dev/`
is what the app imports and what you edit; `r2_prod/` is the copy that
matches what is deployed. Same code at two moments in time — the gap is time,
not content. `r2WorkerEnvironments.test.ts` fails if either goes missing; fix
the folder, not the test. Renaming means updating every import
(`rg -l r2Worker`).
