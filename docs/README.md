# Offline map — docs

This folder owns every offline-map document, beside the engine it describes
(`../lib/`). **This repo is public** — nothing in here may name a secret, an
account or a private endpoint; that material stays in the parent's
`CLOUD_REGISTRY.md`.

| Read | When |
|---|---|
| [`OFFLINE_PLAN.md`](./OFFLINE_PLAN.md) | **Start here.** The plan of record: the 5 laws, the wall map, the layers, do-nots. Wins over everything below. |
| [`OFFLINE_MAP_SPEC.md`](./OFFLINE_MAP_SPEC.md) | Design rationale: the measured failures, the acceptance tests (§8) and engineering rules (§9) that tests cite by number. |
| [`OFFLINE_HISTORY.md`](./OFFLINE_HISTORY.md) | Dead ends already walked (V2, V3, rings, decode, rasters). Don't re-walk them. |
| [`../routes/fires/docs/`](../routes/fires/docs/) | The wildfire layer: v1, v2 spec + cutover, data sources. |
| [`../lib/r2Worker/README.md`](../lib/r2Worker/README.md), [`../worker/README.md`](../worker/README.md) | The client half of the tile Worker, and the Worker itself (tiers, deploy). |

Stayed in the parent (`ReTreever/src/lib/mobile/docs/`): `mapDocs.md` (the map
index), `CLOUD_REGISTRY.md`, `CAMERA_MATH_PLAN.md` (both maps), `LIE_FI_TESTING.md`,
`TODO.md` (the one future-work list — offline items go there too), and the
memory receipts in `ReTreever/src/lib/mobile/offline/MEMORY_FINDINGS.md`.
