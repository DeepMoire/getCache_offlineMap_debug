// ⛔ this file guards: the blob is stored as ONE tile at ONE zoom — a list of zooms is the pyramid bug that made zooming out delete roads.
import { describe, expect, it } from "vitest";
import {
	BLOB_DETAIL_LEVEL,
	BLOB_MAX_Z,
	BLOB_MIN_Z,
	BLOB_ZOOMS,
	SHALLOW_Z,
	cellKmAt,
	GRID_RADIUS_KM,
	tileKm,
} from "./blob";
import { shallowCellsFor } from "./grid";
import { blobHasZoom } from "./roadBlob";

describe("the blob's shape", () => {
	it("⛔ is stored at exactly ONE zoom — a list is the pyramid bug", () => {
		// if this ever has two entries, the map holds different data at different levels and zooming out starts deleting roads again.
		expect(BLOB_ZOOMS).toHaveLength(1);
		expect(BLOB_MIN_Z).toBe(BLOB_MAX_Z);
	});

	it("⚠️ the stored zoom IS the shallowest zoom the blob is visible at", () => {
		// ⚠️ MapLibre only overzooms UP — the stored zoom is a hard floor, below it the map is blank silently; z8 because one tile must hold the whole radius (~112km at lat 44 vs 60km diameter); ⚠️ the user asked for "stop at 5" and this does not deliver it (needs the shallow IMAGE tier in EXPLAINER.md).
		expect(BLOB_MIN_Z).toBe(8);
	});

	it("reads from a level shallower than the old z15 speed bug", () => {
		// read COUNT is the build bottleneck (see blob.ts) — z15 measured a ~65s cold build; this constant governs it.
		expect(BLOB_DETAIL_LEVEL).toBeLessThan(15);
	});

	it("⛔ ONE TILE IS BIGGER THAN THE RADIUS — the whole law", () => {
		// ⚠️ must span the full diameter, checked per-latitude since a slippy tile narrows with cos(lat) — falling short needs a second blob per pin, the nine-blobs-per-pin failure that made the map a lottery.
		expect(cellKmAt(0)).toBeGreaterThan(cellKmAt(60));
		for (const lat of [0, 46.5, 60, 66]) {
			expect(cellKmAt(lat), `too small at lat ${lat}`).toBeGreaterThanOrEqual(
				GRID_RADIUS_KM * 2,
			);
		}
	});

	it("tileKm shrinks with zoom and with latitude", () => {
		expect(tileKm(13, 46.5)).toBeLessThan(tileKm(12, 46.5));
		expect(tileKm(13, 60)).toBeLessThan(tileKm(13, 0));
	});

	it("the SHALLOW tier sits below the main floor and one tile holds the radius", () => {
		// the z6 tier exists so the pin's roads survive camera z6–z7, where the z8 tile is silent (MapLibre overzooms never goes down).
		expect(SHALLOW_Z).toBeLessThan(BLOB_MIN_Z);
		for (const lat of [0, 46.5, 60, 66]) {
			expect(tileKm(SHALLOW_Z, lat), `too small at lat ${lat}`).toBeGreaterThanOrEqual(
				GRID_RADIUS_KM * 2,
			);
		}
	});

	it("⛔ the shallow tier is NOT a blob zoom — the main-path quarantine holds", () => {
		// a stored z6 answering the MAIN lookup's z8 request is the direction1/pv46 incident: mis-framed, mis-scaled interstates. Shallow tiles live in their own store, served by their own source — never in the main namespace.
		expect(BLOB_ZOOMS).not.toContain(SHALLOW_Z);
		expect(blobHasZoom(SHALLOW_Z)).toBe(false);
	});

	it("shallowCellsFor covers the pin at z=SHALLOW_Z, home cell first, a handful at most", () => {
		for (const [lng, lat] of [
			[-111.5, 46.6],
			[-108.3021, 44.4966],
			[12.4964, 41.9028],
		] as const) {
			const cells = shallowCellsFor(lng, lat);
			expect(cells.length, `cell count at ${lng},${lat}`).toBeGreaterThanOrEqual(1);
			expect(cells.length, `cell count at ${lng},${lat}`).toBeLessThanOrEqual(4);
			expect(cells.every((c) => c.z === SHALLOW_Z)).toBe(true);
			// a z6 tile spans the whole radius box — one cell is the norm, straddles are the exception
			expect(cells[0]).toEqual({
				ix: expect.any(Number),
				iy: expect.any(Number),
				z: SHALLOW_Z,
			});
		}
	});
});
