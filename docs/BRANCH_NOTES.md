# Branch notes — offline map (direction2.5 session)

> State at the end of the 2026-09-02 session. `main` was fast-forwarded to `direction2.5` and pushed to origin.

## What's in each branch

| Branch | Contents |
|---|---|
| **main** | Now = `direction2.5` (ff merge `b3c6160`) + these notes (`234f145`). Before, it only had the offline hospitals pack + npm install fixes. This is the starting point for testing all the session's work. |
| **direction1** | Early abandoned direction: "ring doctrine" docs in OFFLINE_PLAN/OFFLINE_MAP_SPEC + `.vscode/` ignore. Historical only. |
| **direction2 / 2.1** | Same tip (`8938ebe`). Kills the below-z8 stretch tier (`RAW_MIN_Z = BLOB_MIN_Z`) and quarantines foreign zooms in the tile lookup. |
| **direction2.2** | Gesture perf: memoized merged reads + O(n) merge + in-memory key set — zoom no longer freezes. Also: e2e refutation test (layer merge VERBATIM), fix for the ledger "2 tiles / —" bug (pass-start snapshot zeroed just-written lineBytes). |
| **direction2.3** | Shallow z6 tier: verbatim z6 tile per pin, own store/source/protocol (`rtraw-shallow`), z6–z7 relay layer. |
| **direction2.4** | Shallow z6 tier BUILT from the z13 disc reads (no longer verbatim): `SHALLOW_LAYER_RULES` thins the roads; zero extra R2 reads. The tip commit ("direction2.6") fixes the vocabulary (real major_road/minor_road), bumps **pv 47→48** (baked pins re-download), and paints the tier's water (`v4-water-fill/line-shallow`). |
| **direction2.5** | **The ghost grid of this session**: one white square per pin = the real bounding box of its tileset (`radiusBox`, a 60×60 km box centered on the pin — NOT the z8 cells of `cellsFor`). Bottom of the layer stack, fill only, no outline, opacity ramp `[[6, 0.01], [7.9, 0]]`: visible only below z6, fading to 0 toward z8. Related fix: `addSource(BLOB_GRID_SOURCE)` moved BEFORE the `wallLayers()` loop (MapLibre silently fails to mount a layer whose source doesn't exist). Tests: 7 in `blobGrid.test.ts`. |

New files in 2.5: `lib/onPhone/render/blobGrid.ts` + `blobGrid.test.ts`; modified: `wallStyle.ts` (layer + ramp) and `OfflineMapPage.svelte` (source before layers).

## How to fetch and test it

```bash
git fetch origin
git checkout main && git pull        # you're on 234f145
npm install                          # package-lock.json is now committed
npx vitest run                       # full suite (883+ tests; ~54 known environmental failures on machines without real local deps)
```

For **runtime** testing (phone/debugger):
1. Vite + worker: `npm run dev` (vite on :5174) and `wrangler dev` in `workers/worker-local-dev/`.
2. Heads-up: **pv 47→48** — already-baked pins re-bake/re-download on first launch, by design.
3. Ghost-grid visual check: zoom **below z6** — a barely-visible white square (1%) centered on each pin; fading out as you climb toward z8, gone at z≥8, by design.

## Tweaking the ghost-grid visibility (the 0.01)

The squares are intentionally faint. To make them more visible:

- `lib/onPhone/render/wallStyle.ts`, in the `v4-blob-grid-fill` layer's `fill-opacity` ramp — the stop after `SHALLOW_Z` is `0.01`. Raise it (e.g. `0.02`, `0.05`, `0.1`) for more visible squares; the ramp shape stays the same (`[[6, X], [7.9, 0]]`).
- The test `lib/onPhone/render/blobGrid.test.ts` asserts that exact value — update the `0.01` in the "opacity is the direction2.5 spec" test to match, then re-run `npx vitest run lib/onPhone/render/blobGrid.test.ts`.

## Deploy note (deferred, not done in this session)

Cloud workers are not updated yet: when deploying, **Worker first, then app** (the phone speaks the new protocol only after the worker). Cloud changes touch `workers/worker-{cloud-dev,cloud-prod}/src/{packBuilder,mvtFilter,index}.ts`.
