import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	__resetOutlineMemoForTest,
	convexHull,
	expandRing,
	fireOutlines,
} from "./fireOutline";

const CELL = 0.00375;
/** n cells east of a base point — guaranteed distinct cells. */
const row = (n: number, lng = -121, lat = 50) =>
	Array.from({ length: n }, (_, i) => ({
		coordinates: [lng + i * CELL, lat] as [number, number],
	}));

/** A compact blob of `n × n` cells. */
const blob = (n: number, lng = -121, lat = 50) => {
	const out: { coordinates: [number, number] }[] = [];
	for (let x = 0; x < n; x++)
		for (let y = 0; y < n; y++)
			out.push({ coordinates: [lng + x * CELL, lat + y * CELL] });
	return out;
};

describe("convexHull", () => {
	it("returns a ring for a square", () => {
		const h = convexHull([
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		]);
		expect(h).toHaveLength(4);
	});

	it("drops interior points — only the outline survives", () => {
		const h = convexHull([
			[0, 0],
			[2, 0],
			[2, 2],
			[0, 2],
			[1, 1], // inside
		]);
		expect(h).toHaveLength(4);
		expect(h).not.toContainEqual([1, 1]);
	});

	it("handles degenerate input without throwing", () => {
		expect(convexHull([])).toEqual([]);
		expect(convexHull([[0, 0]])).toHaveLength(1);
	});
});

describe("fireOutlines — one line per fire", () => {
	it("draws ONE outline around one group", () => {
		const fc = fireOutlines(blob(4));
		expect(fc.features).toHaveLength(1);
		expect(fc.features[0].geometry.type).toBe("Polygon");
	});

	it("draws SEPARATE outlines for fires far apart", () => {
		// must never join fires ~100km apart — false "area between the dots" claim
		const fc = fireOutlines([...blob(4), ...blob(4, -120, 50)]);
		expect(fc.features).toHaveLength(2);
	});

	it("JOINS detections a few hundred metres apart — one fire, one line", () => {
		// different satellites' offset pixels must not become two fires
		const a = blob(3);
		const b = blob(3, -121 + 2 * CELL, 50);
		expect(fireOutlines([...a, ...b]).features).toHaveLength(1);
	});

	it("ignores a lone detection — a ring around one dot says nothing", () => {
		expect(fireOutlines(row(1)).features).toHaveLength(0);
		expect(fireOutlines(row(2)).features).toHaveLength(0);
	});

	it("closes every ring, as GeoJSON requires", () => {
		const fc = fireOutlines(blob(4));
		for (const f of fc.features) {
			const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
			expect(ring[0]).toEqual(ring[ring.length - 1]);
			expect(ring.length).toBeGreaterThanOrEqual(4);
		}
	});

	it("carries NO properties — it is not tappable and makes no claims", () => {
		// no properties — a card/area readout would misrepresent the hull as surveyed (22,328 ha error)
		const fc = fireOutlines(blob(5));
		expect(fc.features[0].properties).toEqual({});
	});

	it("survives garbage coordinates rather than throwing", () => {
		// Fires must never break the map.
		const junk = [
			{ coordinates: [Number.NaN, 50] as [number, number] },
			{ coordinates: [-121, Number.POSITIVE_INFINITY] as [number, number] },
			...blob(4),
		];
		expect(() => fireOutlines(junk)).not.toThrow();
		expect(fireOutlines(junk).features).toHaveLength(1);
	});

	it("returns nothing for no input — an empty layer, never a crash", () => {
		expect(fireOutlines([]).features).toHaveLength(0);
	});

	it("stays cheap at province scale", () => {
		// floor-check: fails if an O(n²) distance matrix creeps back in (measured ~52ms/142 outlines)
		const many: { coordinates: [number, number] }[] = [];
		for (let i = 0; i < 20_000; i++) {
			many.push({
				coordinates: [-121 + (i % 200) * CELL, 50 + Math.floor(i / 200) * CELL],
			});
		}
		const t0 = performance.now();
		const fc = fireOutlines(many);
		expect(performance.now() - t0).toBeLessThan(2000);
		expect(fc.features.length).toBeGreaterThan(0);
	});

	it("the hull ENCLOSES every detection it was built from", () => {
		// promise: the fire is inside the hull — a point outside would break it
		const pts = blob(6);
		const ring = (fireOutlines(pts).features[0].geometry as GeoJSON.Polygon)
			.coordinates[0];
		const xs = ring.map((p) => p[0]);
		const ys = ring.map((p) => p[1]);
		for (const p of pts) {
			expect(p.coordinates[0]).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-9);
			expect(p.coordinates[0]).toBeLessThanOrEqual(Math.max(...xs) + 1e-9);
			expect(p.coordinates[1]).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-9);
			expect(p.coordinates[1]).toBeLessThanOrEqual(Math.max(...ys) + 1e-9);
		}
	});
});

// ⛔ the line must not bisect flames — raw hull runs through detection centres, leaving border flames straddling it
describe("the margin — the outline sits OUTSIDE every detection", () => {
	it("pushes the ring outward from the centre", () => {
		const square: [number, number][] = [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		];
		const out = expandRing(square, 0.1);
		const xs = out.map((p) => p[0]);
		const ys = out.map((p) => p[1]);
		expect(Math.min(...xs)).toBeLessThan(0);
		expect(Math.max(...xs)).toBeGreaterThan(1);
		expect(Math.min(...ys)).toBeLessThan(0);
		expect(Math.max(...ys)).toBeGreaterThan(1);
	});

	it("keeps the same number of vertices — a bigger ring, not a new shape", () => {
		const tri: [number, number][] = [
			[0, 0],
			[1, 0],
			[0, 1],
		];
		expect(expandRing(tri, 0.1)).toHaveLength(3);
	});

	it("scales longitude by latitude so the gap is even on the GROUND", () => {
		// without cos(lat) correction, line hugs tighter east-west further north (~64% at 50°N)
		const at = (lat: number) => {
			const r: [number, number][] = [
				[0, lat],
				[1, lat],
				[1, lat + 1],
				[0, lat + 1],
			];
			const e = expandRing(r, 0.1);
			return Math.max(...e.map((p) => p[0])) - 1;
		};
		expect(at(60)).toBeGreaterThan(at(0));
	});

	it("EVERY detection ends up strictly inside its own outline", () => {
		// no flame may sit on or outside the line
		const pts = blob(6);
		const ring = (fireOutlines(pts).features[0].geometry as GeoJSON.Polygon)
			.coordinates[0];
		const xs = ring.map((p) => p[0]);
		const ys = ring.map((p) => p[1]);
		for (const p of pts) {
			expect(p.coordinates[0]).toBeGreaterThan(Math.min(...xs));
			expect(p.coordinates[0]).toBeLessThan(Math.max(...xs));
			expect(p.coordinates[1]).toBeGreaterThan(Math.min(...ys));
			expect(p.coordinates[1]).toBeLessThan(Math.max(...ys));
		}
	});

	it("the gap is ONE FLAME WIDE — a few hundred metres, never kilometres", () => {
		// regression guard: first margin (4 cells/~1.7km) left an empty swath that silently claimed unburnt ground
		const pts = blob(6, -121, 49);
		const ring = (fireOutlines(pts).features[0].geometry as GeoJSON.Polygon)
			.coordinates[0];
		const lats = pts.map((p) => p.coordinates[1]);
		const ringLats = ring.map((p) => p[1]);
		// How far past the northernmost detection does the line sit, in metres?
		const gapM = (Math.max(...ringLats) - Math.max(...lats)) * 111_320;
		expect(gapM).toBeGreaterThan(100); // still clears the icon
		expect(gapM).toBeLessThan(700); // and never a kilometre-wide swath
	});

	it("the gap does NOT grow with the size of the fire", () => {
		// fixed offset, not a percentage — province-sized blob gets the same gap as a small one
		const gapOf = (n: number) => {
			const pts = blob(n, -121, 49);
			const ring = (fireOutlines(pts).features[0].geometry as GeoJSON.Polygon)
				.coordinates[0];
			return (
				Math.max(...ring.map((p) => p[1])) -
				Math.max(...pts.map((p) => p.coordinates[1]))
			);
		};
		const small = gapOf(5);
		const large = gapOf(40);
		expect(Math.abs(large - small)).toBeLessThan(small * 0.5);
	});

	it("does not throw on a degenerate ring", () => {
		expect(() => expandRing([], 0.1)).not.toThrow();
		expect(() =>
			expandRing(
				[
					[0, 0],
					[0, 0],
					[0, 0],
				],
				0.1,
			),
		).not.toThrow();
	});
});

// ⛔ outlines disappear when zoomed out — undissolved, they'd become dozens of noisy red specks at regional zoom
// ⛔ DO NOT DELETE — fire render layer has no home yet (moved out of deleted online-map folder 28 Aug); re-point at getCache_OnlineMap and unskip when it lands
describe.skip("the outline layer is zoom-gated", () => {
	// orphaned by the map move; "" keeps this block collectable instead of breaking the other ~30 live tests at import
	const src = "";
	const block = src.slice(src.indexOf("id: ids.outline,"));
	const layer = block.slice(0, block.indexOf("\n\t});"));

	it("has a minzoom — it is absent at regional zoom", () => {
		expect(layer).toContain("minzoom: OUTLINE_MIN_ZOOM");
	});

	it("waits for BLOCK scale — this is a tree-planting app", () => {
		// 11 (clusterMaxZoom) was tried and rejected — reads as pollution while still surveying; 13 means "looking at ONE fire"
		expect(src).toMatch(/const OUTLINE_MIN_ZOOM = 13;/);
	});

	it("is gated ABOVE the zoom where clusters hand over", () => {
		// outline must never appear while clusters still show counted blobs — that combo reads as a fire app
		const clusterMax = Number(src.match(/clusterMaxZoom: (\d+)/)?.[1]);
		const outlineMin = Number(src.match(/OUTLINE_MIN_ZOOM = (\d+)/)?.[1]);
		expect(outlineMin).toBeGreaterThan(clusterMax);
	});

	it("fades in rather than popping into existence", () => {
		expect(layer).toContain('"line-opacity"');
		expect(layer).toContain('"interpolate"');
	});

	it("sits UNDER the flames — the dots stay the primary mark", () => {
		expect(src.indexOf("id: ids.outline,")).toBeLessThan(
			src.indexOf("id: ids.flame"),
		);
	});
});

// ⚠️ memo must not lie: a memo that never misses is worse than none — it would freeze outlines while fires move
describe("fireOutlines — the per-pan memo", () => {
	it("returns the SAME object for unchanged data (a pan must not recompute)", () => {
		__resetOutlineMemoForTest();
		const spots = blob(4);
		const first = fireOutlines(spots);
		// pan rebuilds an array with identical contents — identity memoing would miss, so the key is the CELL SET
		const second = fireOutlines([...spots]);
		expect(second).toBe(first);
	});

	it("RECOMPUTES when a fire actually moves", () => {
		__resetOutlineMemoForTest();
		const first = fireOutlines(blob(4));
		const moved = fireOutlines(blob(4, -120, 50));
		expect(moved).not.toBe(first);
		// ...and the new answer describes the new place, not the cached one.
		const ring = (moved.features[0].geometry as GeoJSON.Polygon).coordinates[0];
		expect(ring.every(([lng]) => lng > -120.1)).toBe(true);
	});

	it("RECOMPUTES when a fire grows", () => {
		__resetOutlineMemoForTest();
		const small = fireOutlines(blob(4));
		const bigger = fireOutlines(blob(6));
		expect(bigger).not.toBe(small);
	});

	it("distinguishes a group SPLITTING from one that merely moved", () => {
		// same cell count, different arrangement — a length-only key would miss this, drawing one outline over two fires
		__resetOutlineMemoForTest();
		const together = fireOutlines(blob(4));
		const apart = fireOutlines([...blob(2), ...blob(2, -119, 48)]);
		expect(apart).not.toBe(together);
	});
});

// ⚠️ stableKey is not optional in practice — a wrong key risks a STALE HIT: outlines frozen while fires move (measured 52ms → 0.5ms with the right key)
describe("fireOutlines — stableKey", () => {
	it("hits across rebuilt `shown` arrays when given a stable key", () => {
		__resetOutlineMemoForTest();
		const all = blob(4);
		// Exactly the paint() shape: fresh filter each call, stable upstream array.
		const first = fireOutlines([...all], all);
		const second = fireOutlines([...all], all);
		expect(second).toBe(first);
	});

	it("⛔ does NOT serve a stale outline when `shown` shrinks under a stable key", () => {
		// refineUrban path: `all` stays same but `shown` shrinks — a memo keyed only on `all` would show outlines for fires no longer drawn
		__resetOutlineMemoForTest();
		const all = [...blob(4), ...blob(4, -119, 48)];
		const both = fireOutlines([...all], all);
		expect(both.features).toHaveLength(2);
		const half = fireOutlines(blob(4), all);
		expect(half).not.toBe(both);
		expect(half.features).toHaveLength(1);
	});

	it("still works with no key at all (content hashing fallback)", () => {
		__resetOutlineMemoForTest();
		const a = fireOutlines(blob(4));
		const b = fireOutlines([...blob(4)]);
		expect(b).toBe(a);
	});
});
