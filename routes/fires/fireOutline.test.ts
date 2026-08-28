/**
 * fireOutline.test.ts — the thin red line around a group of fires.
 *
 * What it is: a reading aid so thirty scattered flames read as ONE fire, and —
 * the half that actually matters — so it is visibly NOT anywhere else.
 * What it is NOT: a surveyed perimeter. These tests pin that distinction,
 * because the moment the shape is treated as authoritative it starts making
 * claims the data cannot support.
 */
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
		// Two blobs ~100 km apart must never be joined into one shape — that
		// would claim fire across ground that is not burning, which is the
		// "area between the dots" error this layer explicitly rejects.
		const fc = fireOutlines([...blob(4), ...blob(4, -120, 50)]);
		expect(fc.features).toHaveLength(2);
	});

	it("JOINS detections a few hundred metres apart — one fire, one line", () => {
		// The same fire seen by different satellites lands on slightly offset
		// grids; a pixel wanders between passes. Those must not become two fires.
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
		// A card on the shape would present a hull as a surveyed perimeter, and
		// an area readout would be the 22,328 ha hillside error.
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
		// Measured on live FIRMS: 36,489 detections → 12,197 cells → 142 outlines
		// in ~52 ms. This is a floor-check, not a benchmark — it fails if someone
		// reintroduces an O(n²) distance matrix.
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
		// The promise the line makes: the fire is inside it. A point outside its
		// own outline would break exactly that.
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

/**
 * ⛔ THE LINE CLEARS THE FLAMES — it must not bisect them.
 *
 * The raw hull runs through the CENTRES of the outermost detections, so every
 * border flame straddles the line and half of each icon hangs outside. On
 * screen that reads as "the outline missed some of them", which undoes the one
 * thing the line is for: showing that the fire is inside it and not outside.
 */
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
		// At 50°N a degree of longitude is ~64% of a degree of latitude. Without
		// the cos(lat) correction the line hugs the fire tighter east-west the
		// further north you go.
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
		// The promise, as a test: no flame may sit on or outside the line.
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
		// The regression this exists to stop: the first margin was 4 cells
		// (~1.7 km), which left a huge empty swath between the outermost flames
		// and the line. An outline standing that far out silently claims ground
		// that is not burning — worse than having no margin at all.
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
		// A fixed offset, not a percentage: a province-sized blob must get the
		// same few-hundred-metre gap a small one does.
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

/**
 * ⛔ NOT A FIRE APP — the outlines disappear when zoomed out.
 *
 * Clusters already collapse a province into a few counted blobs. The outlines
 * do not collapse, so at regional zoom they become dozens of red specks — noise
 * that prompts "why is there no fire pin there?". They belong only at the zoom
 * where the dots they enclose are actually visible.
 */
// ⚠️ ONLINE MAP MOVED TO THE CHILD, 28 Aug 2026. This block read
// src/routes/(getcache)/map/fireLayer.ts as TEXT. That whole folder — 32 files,
// 10,873 lines — was a SECOND online map beside getCache_OnlineMap's, and it was
// deleted; /map is now a two-line address rendering the child's component, the
// same operation /offline had on 27 Aug.
//
// The law this asserts (ONE fire layer, no per-route re-implementation) is now
// enforced STRUCTURALLY: a route that is an import and a tag has nowhere to put
// a second copy. That is the deeper wall this grep was standing in for.
//
// ⛔ DO NOT DELETE. The fire RENDER layer has no home yet — it is in neither
// child (verified 28 Aug: no ids.outline / attachFireLayer outside the deleted
// folder). When it lands in getCache_OnlineMap, RE-POINT AT IT AND UNSKIP.
describe.skip("the outline layer is zoom-gated", () => {
	// Orphaned by the map move — see the note above. "" keeps the skipped
	// block collectable instead of throwing at import and taking the file's
	// OTHER ~30 live tests down with it.
	const src = "";
	const block = src.slice(src.indexOf("id: ids.outline,"));
	const layer = block.slice(0, block.indexOf("\n\t});"));

	it("has a minzoom — it is absent at regional zoom", () => {
		expect(layer).toContain("minzoom: OUTLINE_MIN_ZOOM");
	});

	it("waits for BLOCK scale — this is a tree-planting app", () => {
		// 11 (clusterMaxZoom) was tried and rejected: at that zoom you are still
		// surveying a region, and scattered red polygons over ground you are not
		// standing on read as pollution. 13 is "looking at ONE fire".
		expect(src).toMatch(/const OUTLINE_MIN_ZOOM = 13;/);
	});

	it("is gated ABOVE the zoom where clusters hand over", () => {
		// The outline must never appear while the map is still showing counted
		// cluster blobs — that is the combination that looks like a fire app.
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

/**
 * ── THE MEMO IS A PERFORMANCE CONTRACT, AND IT MUST NOT LIE ──
 *
 * `fireOutlines` is called from `paint()`, and `paint()` is the PAN path
 * (moveend → ensure → paint). Without a memo the ~52 ms hull rebuild lands on
 * every pan gesture — the module header and the call site both claimed this
 * already happened "once per data change"; neither was true of the code.
 *
 * These tests pin BOTH directions, because a memo that never misses is worse
 * than no memo at all: it would freeze the outlines while the fires underneath
 * them moved, and this layer's whole job is not lying about where fire is.
 */
describe("fireOutlines — the per-pan memo", () => {
	it("returns the SAME object for unchanged data (a pan must not recompute)", () => {
		__resetOutlineMemoForTest();
		const spots = blob(4);
		const first = fireOutlines(spots);
		// A pan hands over a freshly-built array with identical contents — that is
		// exactly what `shown` is, rebuilt by a filter on every paint. Identity
		// memoing would miss here, which is why the key is the CELL SET.
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
		// Same cell COUNT, different arrangement — the case a naive length-only
		// key would wave through, leaving one outline drawn over two fires.
		__resetOutlineMemoForTest();
		const together = fireOutlines(blob(4));
		const apart = fireOutlines([...blob(2), ...blob(2, -119, 48)]);
		expect(apart).not.toBe(together);
	});
});

/**
 * ── THE `stableKey` PARAMETER, AND WHY IT IS NOT OPTIONAL IN PRACTICE ──
 *
 * `paint()` builds `shown` with `.filter()`, so it is a NEW array on every pan
 * even when not one detection changed. Keying the memo on it meant the fast
 * path never hit, and every pan re-bucketed 36,000 detections into 12,000 cells
 * (~20 ms) before the second-tier memo could save the hulls. Measured: 52 ms
 * per pan → 0.5 ms once the caller passes the stable upstream array.
 *
 * The danger of a key that is not the data is a STALE HIT — outlines frozen
 * while the fires under them move. The last test here is the one that matters.
 */
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
		// The refineUrban path: `all` is unchanged (same cache), but newly-learned
		// urban verdicts drop hotspots from `shown`. A memo keyed only on `all`
		// would hand back outlines around fires that are no longer drawn — the
		// layer claiming fire where it is showing none.
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
