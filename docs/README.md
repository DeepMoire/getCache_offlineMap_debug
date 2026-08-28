# Offline map — docs

This folder owns every offline-map document. Moved here from
`ReTreever/src/lib/mobile/docs/` on 28 Aug 2026 so the docs live beside the
engine they describe (`../lib/`). **This repo is public** — nothing in here
may name a secret, an account or a private endpoint; that material stays in
the parent's `CLOUD_REGISTRY.md`.

| Read | When |
|---|---|
| [`OFFLINE_PLAN.md`](./OFFLINE_PLAN.md) | **Start here.** The plan of record: the 5 laws, the layers, what is shipped vs planned. Wins over everything below. |
| [`OFFLINE_MAP_SPEC.md`](./OFFLINE_MAP_SPEC.md) | The original build brief — now design rationale, not a work order. |
| [`OFFLINE_TREE_TARGET.md`](./OFFLINE_TREE_TARGET.md) | Where the tile-scheme bug lives (`contract/grid.ts` twins the Worker). |
| [`OFFLINE_HISTORY.md`](./OFFLINE_HISTORY.md) | Dead ends already walked (V2 pyramid, V3 …). Don't re-walk them. |
| [`../routes/fires/docs/`](../routes/fires/docs/) | The wildfire layer: v1, v2 spec + cutover, data sources. |
| [`../lib/r2Worker/README.md`](../lib/r2Worker/README.md), [`TIERS.md`](../lib/r2Worker/TIERS.md) | The Worker half. |

Stayed in the parent (`ReTreever/src/lib/mobile/docs/`): `mapDocs.md` (the map
index), `CLOUD_REGISTRY.md`, `CAMERA_MATH_PLAN.md` (both maps), `LIE_FI_TESTING.md`,
`TODO.md` (the one future-work list — offline items go there too), and the
memory receipts in `ReTreever/src/lib/mobile/offline/MEMORY_FINDINGS.md`.
