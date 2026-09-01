// ⚠️ MUST STAY IN SYNC with /src/lib/mobile/offlineV4/roadBlob.ts — constants duplicated on purpose, checked by the app's roadBlob.test.ts.
// ⛔ re-exports only, NOT declarations — a stale local radius/zoom list renders nothing, silently.
export { GRID_RADIUS_KM as BLOB_RADIUS_KM, BLOB_ZOOMS } from "./blob";

/** The detail level — the only one with the full basemap (water, landuse, pois); every shallower level is roads-only. */
export const BLOB_DETAIL_Z = 15;
