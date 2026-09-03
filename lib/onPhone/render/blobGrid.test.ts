// direction2.5 — THE GHOST GRID. The squares must be EXACTLY the radiusBox
// of each pin (the bounding box of the tileset the downloader generates for
// it — NOT the z8 tiles of cellsFor, which are just the blob's ADDRESS and
// read as a huge regular tile grid), the layer must sit UNDER every tileset
// layer, and the fade must be the spec verbatim: opacity 0 at z≥8, LINEAR
// 0→0.01 between BLOB_TILE_Z−0.1 and SHALLOW_Z, flat 0.01 below. MapLibre
// CLAMPS an interpolation outside its stops, so the two stops alone produce
// all three regimes — no extra stop may be added.
import { describe, expect, it } from "vitest";
import { BLOB_GRID_SOURCE, blobGridFeatures } from "./blobGrid";
import { wallLayers } from "./wallStyle";
import {
	BLOB_TILE_Z,
	GRID_RADIUS_KM,
	SHALLOW_Z,
	radiusBox,
} from "../../contract/grid";

/** The page's first literal pin — Ottawa valley. */
const OTTAWA: readonly [number, number] = [-76.16797958683314, 45.061348227515055];

/** Sorted "w,s,e,n" strings — bbox fingerprints for set-style comparison. */
const bboxes = (fc: GeoJSON.FeatureCollection): string[] =>
	fc.features
		.map((f) => {
			const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]!;
			const lngs = ring.map((c) => c[0]!);
			const lats = ring.map((c) => c[1]!);
			return `${Math.min(...lngs)},${Math.min(...lats)},${Math.max(...lngs)},${Math.max(...lats)}`;
		})
		.sort();

describe("THE GHOST GRID — the tileset footprint of the pins", () => {
	it("one square per pin: its radiusBox — the bbox of the tileset it generates", () => {
		const b = radiusBox(OTTAWA[0], OTTAWA[1]);
		// ⛔ if this ever goes red because radiusBox changed, the GHOST GRID
		// and the PACK disagree — reconcile them, do not edit this expectation.
		expect(bboxes(blobGridFeatures([OTTAWA]))).toEqual([
			`${b.w},${b.s},${b.e},${b.n}`,
		]);
	});

	it("the square is the 2×RADIUS box, not a whole z8 tile", () => {
		const b = radiusBox(OTTAWA[0], OTTAWA[1]);
		// North-south span is the diameter in degrees; a z8 tile (~100+ km)
		// would be far larger. This is the regression line for the first
		// version, which painted the cellsFor tiles instead.
		expect(b.n - b.s).toBeCloseTo((GRID_RADIUS_KM * 2) / 110.574, 6);
	});

	it("identical anchors dedupe; neighbouring pins keep their own squares", () => {
		// Same anchor twice → ONE square (same tileset).
		expect(
			bboxes(blobGridFeatures([OTTAWA, OTTAWA])),
		).toHaveLength(1);
		// A pin ~10 m away is a DIFFERENT tileset — its own, slightly-offset
		// square, not a dedup into one.
		const near: readonly [number, number] = [OTTAWA[0] + 0.0001, OTTAWA[1] + 0.0001];
		expect(blobGridFeatures([OTTAWA, near]).features).toHaveLength(2);
	});

	it("each square is a closed ring on the box's exact bounds", () => {
		const fc = blobGridFeatures([OTTAWA]);
		const b = radiusBox(OTTAWA[0], OTTAWA[1]);
		for (const f of fc.features) {
			const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]!;
			expect(ring).toHaveLength(5);
			expect(ring[0]).toEqual(ring[4]);
			expect(ring).toContainEqual([b.w, b.s]);
			expect(ring).toContainEqual([b.e, b.s]);
			expect(ring).toContainEqual([b.e, b.n]);
			expect(ring).toContainEqual([b.w, b.n]);
		}
	});

	it("the layer sits at the BOTTOM of the stack — under every tileset", () => {
		const layers = wallLayers();
		// LayerSpecification is a union (background layers have no source),
		// so read the shared slots through a narrow, honest shape.
		const grid = layers[0]! as {
			id: string;
			type: string;
			source?: string;
			paint?: Record<string, unknown>;
		};
		expect(grid.id).toBe("v4-blob-grid-fill");
		expect(grid.type).toBe("fill");
		expect(grid.source).toBe(BLOB_GRID_SOURCE);
		// under the water fills, the shallow tier, the roads — everything.
		for (const id of ["v4-water-fill", "v4-roads-shallow", "v4-roads"]) {
			expect(layers.findIndex((l) => l.id === id), id).toBeGreaterThan(0);
		}
	});

	it("fill only, white — NO outline (the user: “bordo invisibile”)", () => {
		const paint = (wallLayers()[0] as { paint?: Record<string, unknown> }).paint!;
		expect(paint["fill-color"]).toBe("#ffffff");
		expect(paint["fill-outline-color"]).toBeUndefined();
	});

	it("opacity is the direction2.5 spec, DERIVED from the contract constants", () => {
		const paint = (wallLayers()[0] as { paint?: Record<string, unknown> }).paint!;
		expect(paint["fill-opacity"]).toEqual([
			"interpolate",
			["linear"],
			["zoom"],
			// flat 0.01 at z≤6 (clamped below the bottom stop) …
			SHALLOW_Z,
			0.01,
			// … linear to 0 at BLOB_TILE_Z−0.1, clamped 0 at z≥8.
			BLOB_TILE_Z - 0.1,
			0,
		]);
	});
});
