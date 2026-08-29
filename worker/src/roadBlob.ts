// THE ROADS BLOB — one radius, every zoom (30 km circle, z1–z18).
// ⚠️ MUST STAY IN SYNC WITH /src/lib/mobile/offlineV4/roadBlob.ts — the two constants below are duplicated on purpose (checked by roadBlob.test.ts in the app).
// A vector tile only stretches BIGGER, never smaller — a level the pack doesn't hold renders nothing, silently. Saving one extra shallow level only moves that cliff; saving every level removes it.

// ⛔ Re-exports only, NOT declarations — do not hardcode a radius/zoom list here. A stale local list once didn't match the deployed pack and rendered nothing, silently.
export { GRID_RADIUS_KM as BLOB_RADIUS_KM, BLOB_ZOOMS } from "./blob";

/** The detail level — the only one with the full basemap (water, landuse, pois); every shallower level is roads-only. */
export const BLOB_DETAIL_Z = 15;
