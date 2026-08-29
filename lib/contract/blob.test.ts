// ⛔ this file guards: the blob is stored as ONE tile at ONE zoom — a list of zooms is the pyramid bug that made zooming out delete roads.
import { describe, expect, it } from "vitest";
import {
	BLOB_DETAIL_LEVEL,
	BLOB_MAX_Z,
	BLOB_MIN_Z,
	BLOB_ZOOMS,
	cellKmAt,
	GRID_RADIUS_KM,
	tileKm,
} from "./blob";

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
});
