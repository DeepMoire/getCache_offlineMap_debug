/**
 * THE ROADS BLOB — compatibility shim; re-exports the rule from ../blob.ts under the old names.
 *
 * ⛔ DO NOT WRITE A NUMBER IN THIS FILE — BLOB_RADIUS_KM/BLOB_ZOOMS must stay aliases of V5's; two disagreeing zoom lists silently blank the map.
 */

import { GRID_RADIUS_KM, BLOB_ZOOMS as V5_ZOOMS } from "./blob";

/**
 * THE RADIUS. One number — every zoom uses it, making the blob one circle rather than a set of rings.
 *
 * ⛔ DO NOT ADD A SECOND RADIUS — tried three times before; it always reads as a confusing second shape appearing and vanishing across zooms.
 */
export const BLOB_RADIUS_KM: number = GRID_RADIUS_KM;

/**
 * EVERY ZOOM THE BLOB IS SAVED AT — the full range, no gaps; z14 is deliberately absent (z13 overzooms to cover it for free).
 *
 * ⛔ Adding or removing a level here changes both what the Worker packs and what the renderer requests — bump PACK_FORMAT_VERSION after changing it so devices re-download.
 */
export const BLOB_ZOOMS: readonly number[] = V5_ZOOMS;

/** The deepest level saved. Above this the renderer overzooms for free. */
export const BLOB_MAX_Z = Math.max(...BLOB_ZOOMS);
/** The shallowest level saved. There is nothing below this to draw. */
export const BLOB_MIN_Z = Math.min(...BLOB_ZOOMS);

/** ⚠️ never claim a zoom the blob doesn't hold — a wider-than-pack zoom span makes MapLibre 404 and blanks the map silently. */
export function blobHasZoom(z: number): boolean {
	return (BLOB_ZOOMS as readonly number[]).includes(z);
}

/** How wide one tile is, in km, at zoom `z` and latitude `lat`. */
export function tileWidthKm(z: number, lat: number): number {
	return (40075.016686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}
