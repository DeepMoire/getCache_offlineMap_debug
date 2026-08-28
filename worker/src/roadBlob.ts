/**
 * THE ROADS BLOB — one radius, every zoom. Worker-side copy of the spec.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A 30 km circle of roads around each anchor, visible from z1 to z18.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ THIS MUST STAY IN SYNC WITH
 *    /src/lib/mobile/offlineV4/roadBlob.ts
 * The Worker deploys to Cloudflare on its own and cannot import from the app,
 * so the two constants below are duplicated ON PURPOSE. They are the ONLY
 * duplicated values, they are two lines, and a mismatch is caught by
 * `roadBlob.test.ts` in the app, which reads this file's text directly.
 *
 * Read that file for the full reasoning. The short version:
 *   • A vector tile is only stretched BIGGER, never smaller — so a tile saved
 *     at z12 draws z12→z22 and NOTHING below, silently, with no error.
 *   • Saving ONE extra shallow level only MOVES that cliff (tried z8, z10, z9
 *     in one day; rejected all three). Saving EVERY level removes it.
 *   • One radius at every level = one circle. A second radius is a second EDGE
 *     that appears and vanishes as you zoom — the most confusing thing this map
 *     can do, and the exact bug that was rejected three times.
 */

/**
 * ⛔ THE RADIUS AND THE ZOOM LIST MOVED TO `./blob.ts` (OFFLINEV5).
 *
 * These two are re-exports, NOT declarations. Do not write a number here. The
 * list that used to live in this file said z1-z15 while the deployed pack held
 * z8-z15, and a level the pack does not hold renders NOTHING, silently.
 */
export { GRID_RADIUS_KM as BLOB_RADIUS_KM, BLOB_ZOOMS } from "./blob";

/** The detail level — the only one that carries the full basemap payload
 *  (water, landuse, pois). Every shallower level is roads-only, because that
 *  is all that is legible when the whole disc is a few pixels wide. */
export const BLOB_DETAIL_Z = 15;
