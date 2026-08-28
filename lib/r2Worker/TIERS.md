# The three tiers

There are three, they are named the same way, and nothing else is a tier.

| tier | hostname | what it is |
|---|---|---|
| **prod** | `tiles-prod.getcache.org` | what every shipped phone reads |
| **dev** | `tiles-dev.getcache.org` | deployed sandbox, same R2 bucket |
| **local** | `tiles-local.getcache.org:8787` | your own machine, no account needed |

It is one URL. `GET /pack?lng=&lat=` returns a map pack; `GET /{z}/{x}/{y}.pbf`
returns a tile. Measured 27 Aug 2026: 342,916 and 19,157 bytes respectively.
Nothing about using it is more complicated than that.

## Who creates each hostname

`prod` and `dev` are **created by the deploy**, never by hand. `wrangler.toml`
marks them `custom_domain = true`, so Cloudflare owns the DNS record and the
TLS certificate and provisions both during `wrangler deploy`. It will not adopt
a record you made first — the deploy fails with error 100117 and there is no
`--force` (the override is not exposed in wrangler; workers-sdk#9878, open).

`local` is **added by hand**, once, in the Cloudflare dashboard: an `A` record
for `tiles-local` → `127.0.0.1`, DNS-only. It has no Worker and no certificate,
so nothing else will ever create it.

That asymmetry looks wrong and is Cloudflare's, not ours. It was questioned on
27 Aug and verified against the docs the same day.

## Deploying

    cd ReTreever/workers/offline-tiles
    npm run deploy:dev     # dev — no prompt, no shipped phone can read it
    npm run deploy         # prod — asks for confirmation

## When a tier looks dead but isn't

A resolver that was asked about a hostname **before it existed** caches "does
not exist" for up to 30 minutes (the zone's SOA negative TTL). Deploying does
not clear that; neither does flushing your own machine, if the stale entry is
on your ISP's resolver. Check which layer disagrees:

    dig +short tiles-prod.getcache.org              # your resolver
    dig +short tiles-prod.getcache.org @1.1.1.1     # the truth

If the second prints IPs and the first does not, the Worker is fine and you are
reading a stale negative cache. Wait it out.

**This only ever affects someone who watched the record being created.** A
contractor who arrives afterwards asks once and gets the right answer. Nobody
needs `sudo`, and if they ever do, something here is wrong.

## Enforcement

`tierNaming.test.ts` scans every `.ts`/`.svelte`/`.js` in this child and fails
on any tile hostname that is not one of the three above. Seven spellings existed
at once on 27 Aug because the convention lived in prose, and prose cannot fail a
build.
