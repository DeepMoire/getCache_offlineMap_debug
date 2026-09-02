/** ONE pin → ONE request → ONE blob → every road within the radius. */

/** ⛔ The storage unit must be at least as big as the promise — if a pin could ever need a second blob to satisfy the radius, the product becomes a lottery. BLOB_TILE_Z is chosen to guarantee this, and oneBlobIsEnough.test.ts checks it. */

import { km } from "./geo";

/** THE RADIUS. Every road within this distance of the pin is in the blob. */
export const GRID_RADIUS_KM = 30;

/** The zoom the blob is ADDRESSED at — the shallowest zoom the MAIN tier is visible at. */
// ⛔ This is an address, not a size — the blob's CONTENTS are always the radius around the pin (radiusBox), regardless of this number.
// ⚠️ It IS the visibility floor of the MAIN tier: MapLibre overzooms up but never scales a tile down, so below this zoom the main source is silent. The fix is SHALLOW_Z below — never lower this constant.
// ⛔ The blob is framed to the TILE (not the pin), so a pin near a tile edge DOES need its neighbours — cellsFor returns every touched cell (up to 4), delivered as one request.
export const BLOB_TILE_Z = 8;

/**
 * THE SHALLOW TIER's zoom — one generalized z6 tile per pin so its roads stay
 * visible at camera z6–z7, where the z8 main tier is silent (overzoom never
 * goes down).
 * ⛔ NOT a second entry in BLOB_ZOOMS — the main lookup's containment CLIMBS a
 * stored tile up to the requested zoom, so a z6 stored in the main namespace
 * would answer z8 requests mis-framed and mis-scaled (the direction1/pv46
 * incident, 2026-09-01). Shallow tiles live in their own IDB store, served by
 * their own source; blobHasZoom keeps rejecting this zoom on the main path.
 */
export const SHALLOW_Z = 6;

/** A blob's cell — which IS a slippy tile at {@link BLOB_TILE_Z}. */
export interface Cell {
	ix: number;
	iy: number;
	// ⚠️ z is NOT always BLOB_TILE_Z — a pin near a tile edge is promoted to a shallower tile so its radius fits. Anything deriving a key or a frame must use this, never the constant, or the address and geometry disagree.
	z: number;
}

/** The cell's bounding box in degrees: west/south/east/north. */
export interface CellBox {
	w: number;
	s: number;
	e: number;
	n: number;
}

/** Mercator-normalised Y (0..1) for a latitude. */
function mercY(lat: number): number {
	const s = Math.sin((lat * Math.PI) / 180);
	return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Latitude for a mercator-normalised Y — the inverse of {@link mercY}. */
function latOfMercY(y: number): number {
	const n = Math.PI * (1 - 2 * y);
	return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Which cell contains this point. Plain slippy-tile maths — no state, no
 *  origin negotiation, identical on the Worker and the phone. */
export function cellOf(lng: number, lat: number): Cell {
	const n = 2 ** BLOB_TILE_Z;
	return {
		ix: Math.floor(((lng + 180) / 360) * n),
		iy: Math.floor(mercY(lat) * n),
		z: BLOB_TILE_Z,
	};
}

/** The bounding box of a cell. */
export function cellBox(c: Cell): CellBox {
	const n = 2 ** c.z;
	return {
		w: (c.ix / n) * 360 - 180,
		e: ((c.ix + 1) / n) * 360 - 180,
		n: latOfMercY(c.iy / n), // north = SMALLER mercator y
		s: latOfMercY((c.iy + 1) / n),
	};
}

/** A cell's stable id — also its dedup key. */
export function cellKey(c: Cell): string {
	return `${c.z}_${c.ix}_${c.iy}`;
}

/** Parse a cell id back. Returns null for anything malformed. */
export function parseCellKey(key: string): Cell | null {
	const m = /^(\d+)_(-?\d+)_(-?\d+)$/.exec(key);
	if (!m) return null;
	return { z: Number(m[1]), ix: Number(m[2]), iy: Number(m[3]) };
}

// ⛔ The storage key AND the slippy address MapLibre requests — deliberately the same string. A separate cell key + tile address failed to stay in sync before, and the map went silently blank or wrong; this is why the grid file must be byte-identical (grid.lockstep.test.ts).
export function cellTileKey(c: Cell): string {
	return `${c.z}/${c.ix}/${c.iy}`;
}

// ⛔ Not cellTileKey alone — two pins can share a grid square, so one pin's roads were served under the other pin's key (measured: a Yellowstone pin served a box 36.6 km south of itself). Key = the pin's own coords + the cell, at 5 decimals (~1 m); both sides must spell it identically or the map is silently blank.
export function pinTileKey(lng: number, lat: number, c: Cell): string {
	return `pin/${lng.toFixed(5)},${lat.toFixed(5)}/${cellTileKey(c)}`;
}

/** Is this a pin-addressed roads key? */
export function isPinTileKey(key: string): boolean {
	return key.startsWith("pin/");
}

/** The SHALLOW tier's storage key — the pin-keyed law of {@link pinTileKey}, on
 * a `shallow/` host so the phone routes it to the SHALLOW store and it can
 * never answer a main-tier z8 request mis-framed (the direction1/pv46
 * incident). Both sides must spell it identically or the tier is silently
 * blank — this is the one definition. */
export function shallowTileKey(lng: number, lat: number, c: Cell): string {
	return `shallow/${lng.toFixed(5)},${lat.toFixed(5)}/${cellTileKey(c)}`;
}

/** Is this a shallow-tier roads key? */
export function isShallowTileKey(key: string): boolean {
	return key.startsWith("shallow/");
}

// ⛔ pinFrame is deleted and must not come back — it wrote pin-box coords into a tile-addressed blob, and MapLibre stretched the roads 1.86x anchored top-left; centring belongs to radiusBox, not the frame.

/** The box to read for a pin — the radius around it, not a tile (the blob's address is a tile; its contents are the pin's radius). */
export function radiusBox(lng: number, lat: number): CellBox {
	const dLat = GRID_RADIUS_KM / 110.574;
	const dLng =
		GRID_RADIUS_KM / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
	return { w: lng - dLng, e: lng + dLng, s: lat - dLat, n: lat + dLat };
}

// ⛔ Must return exactly ONE cell — not a stub, and it must not grow; a pin needing a second blob to satisfy its radius is the exact failure this design deletes.
// ⛔ Returns EVERY cell the pin's radius touches (up to 4) — a single tile clips at its edge (measured: a Timbuktu pin lost roads on two sides), and a bigger tile doesn't fix it (only ~21% of a z8 tile is >30 km from every edge). Bake all overlapping tiles instead, one request, nothing clipped.
export function cellsFor(lng: number, lat: number): Cell[] {
	const box = radiusBox(lng, lat);
	const n = 2 ** BLOB_TILE_Z;
	const X = (lo: number) =>
		Math.min(n - 1, Math.max(0, Math.floor(((lo + 180) / 360) * n)));
	const Y = (la: number) =>
		Math.min(n - 1, Math.max(0, Math.floor(mercY(la) * n)));

	const x0 = X(box.w);
	const x1 = X(box.e);
	const y0 = Y(box.n); // north = smaller y
	const y1 = Y(box.s);

	const home = cellOf(lng, lat);
	const out: Cell[] = [];
	const seen = new Set<string>();
	// The pin's OWN cell first — callers bake in order and it is the one the map
	// reads at the pin, so it must not queue behind its neighbours.
	const push = (c: Cell) => {
		const k = cellKey(c);
		if (seen.has(k)) return;
		seen.add(k);
		out.push(c);
	};
	push(home);
	for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
		for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
			push({ ix: x, iy: y, z: BLOB_TILE_Z });
		}
	}
	return out;
}

/**
 * The shallow-tier cells for a pin — every z=SHALLOW_Z tile the radius touches.
 * A z6 tile spans the whole 30 km box, so this is usually ONE cell (at most a
 * handful if the box straddles edges). Same pin-keyed law as cellsFor; the
 * pin's own cell first.
 */
export function shallowCellsFor(lng: number, lat: number): Cell[] {
	const box = radiusBox(lng, lat);
	const n = 2 ** SHALLOW_Z;
	const X = (lo: number) =>
		Math.min(n - 1, Math.max(0, Math.floor(((lo + 180) / 360) * n)));
	const Y = (la: number) =>
		Math.min(n - 1, Math.max(0, Math.floor(mercY(la) * n)));

	const x0 = X(box.w);
	const x1 = X(box.e);
	const y0 = Y(box.n); // north = smaller y
	const y1 = Y(box.s);

	const out: Cell[] = [];
	const seen = new Set<string>();
	const push = (c: Cell) => {
		const k = cellKey(c);
		if (seen.has(k)) return;
		seen.add(k);
		out.push(c);
	};
	push({ ix: X(lng), iy: Y(lat), z: SHALLOW_Z });
	for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
		for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
			push({ ix: x, iy: y, z: SHALLOW_Z });
		}
	}
	return out;
}

/** Does ONE tile at `z` hold the whole radius at this latitude? The invariant
 *  the whole design rests on — asserted by oneBlobIsEnough.test.ts. */
export function tileHoldsRadius(z: number, lat: number): boolean {
	const n = 2 ** z;
	const wDeg = 360 / n;
	const widthKm = km(0, lat, wDeg, lat);
	// The tile must span the full DIAMETER, or a centred pin would not fit.
	return widthKm >= GRID_RADIUS_KM * 2;
}
