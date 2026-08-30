# r2Worker — the tile Worker as the app sees it

The Worker itself (Cloudflare, R2, deploy scripts) is `../../worker/` — read
its README for hosting. This folder is the **client half**: which host the app
talks to, the `/pack` downloader, the fires fetch.

## Three tiers, one URL shape

| tier | CONFIG panel | hostname | who creates it |
|---|---|---|---|
| prod | `r2_prod` | `tiles-prod.getcache.org` | `npm run deploy` in `worker/` (asks to confirm) |
| dev | `r2_dev` | `tiles-dev.getcache.org` | `npm run deploy:dev` — same R2 bucket, so a prod/dev difference is always CODE, never data |
| local | `local_dev` | `tiles-local.getcache.org:8787` → 127.0.0.1 | `npm run dev:local` — no Cloudflare account needed |

`GET /pack?lng=&lat=` returns a map pack; `GET /{z}/{x}/{y}.pbf` a tile.

- ⛔ prod and dev hostnames are made by `wrangler deploy` (`custom_domain = true`).
  Never create them by hand in the dashboard — the deploy then fails (100117)
  and there is no `--force`. `tiles-local` is the one hand-made DNS record
  (A → 127.0.0.1, DNS-only); nothing else will ever create it.
- ⛔ No prod/dev host is baked into this child — the mounting app injects both
  (`configureTilesHost` / `configureTilesDevHost`). Unconfigured → `null` → the
  row greys out. A hardcoded default bills the maintainer's R2 account for
  every stranger who installs the package.
- Default is always prod; the switch only exists in a dev build
  (`import.meta.env.DEV`), so a shipped phone cannot be left on a sandbox.
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
