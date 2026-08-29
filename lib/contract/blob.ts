// ⛔ THE BLOB — nothing else in V5 may name a radius or a zoom; everything imports from here or from grid.ts.

import { BLOB_TILE_Z } from "./grid";
export { BLOB_TILE_Z, GRID_RADIUS_KM } from "./grid";

// ⛔ there is no CELL_KM — the cell is a z10 slippy tile which narrows with cos(lat) (~39km equator, ~19km at lat 60); a single constant would silently under-cover in the north.
export function cellKmAt(lat: number): number {
	return tileKm(BLOB_TILE_Z, lat);
}

// ⛔ MapLibre only overzooms UP — the stored level is the floor, below it the map is blank silently (source declares minzoom=maxzoom=BLOB_TILE_Z, so it overzooms this one tile at every deeper level).
export const BLOB_ZOOMS = [BLOB_TILE_Z] as const;

// ⛔ DO NOT TURN THIS BACK INTO A LIST — a pyramid shows different data per level (archive holds major+highway only at z9/z10, adds minor at z12, thins again by z15), so a list of levels deletes roads when zooming out; one tile has nothing to disagree between levels.

export const BLOB_MIN_Z = Math.min(...BLOB_ZOOMS);
export const BLOB_MAX_Z = Math.max(...BLOB_ZOOMS);

// ⚠️ must match the Worker's read level. ⛔ 15 was the speed bug — read COUNT is the bottleneck, not bytes (z15's ~3,900 reads measured a ~65s cold build; dropping bytes 13× didn't move it). The trade is real: z13 carries fewer small roads than z15, though everything z13 holds appears at every level.
export const BLOB_DETAIL_LEVEL = 13;

/** Width of one tile in km at zoom `z` and latitude `lat`. */
export function tileKm(z: number, lat: number): number {
	return (40075.016686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}
