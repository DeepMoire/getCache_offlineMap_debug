/**
 * fireClassifyCache.test.ts — fires must never cost the map a frame.
 *
 * The measured problem: `isUrban` scans 11,878 polygons per hotspot, at
 * **17.8 ms per 1,000**. A normal paint (~11,400 hotspots past the 500 km wall)
 * blocked the main thread for **~200 ms**, on every pan — 10–50× every other
 * step combined (IndexedDB 14 ms, union 12, wall 4, GeoJSON 2, clone 7).
 *
 * Fires are an afterthought: 95%+ of the time a planter is looking for something
 * else entirely. These tests pin the properties that keep the overlay free.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetClassifyCacheForTest,
	classifiedCount,
	classifyPending,
	peekUrbanVerdict,
	setUrbanVerdict,
} from "./fireClassifyCache";
import { CELL_DEG } from "./masks/staticHeatSources";

beforeEach(() => {
	__resetClassifyCacheForTest();
});

const at = (i: number): [number, number] => [-121 + i * 0.01, 50];

describe("a verdict is remembered, not recomputed", () => {
	it("returns null before anything is known", () => {
		expect(peekUrbanVerdict(-121, 50)).toBeNull();
	});

	it("remembers what it was told", () => {
		setUrbanVerdict(-121, 50, true);
		expect(peekUrbanVerdict(-121, 50)).toBe(true);
		setUrbanVerdict(-122, 50, false);
		expect(peekUrbanVerdict(-122, 50)).toBe(false);
	});

	it("shares one verdict across a ~375 m CELL, not per coordinate", () => {
		// This is what collapses tens of thousands of detections into a few
		// hundred real questions — neighbouring hits are the same ground.
		//
		// Anchored at a cell CENTRE (an exact multiple of CELL_DEG) so the test
		// exercises sharing rather than the rounding boundary.
		const centre = Math.round(-121 / CELL_DEG) * CELL_DEG;
		setUrbanVerdict(centre, 50, true);
		expect(peekUrbanVerdict(centre + CELL_DEG * 0.4, 50)).toBe(true);
		expect(peekUrbanVerdict(centre - CELL_DEG * 0.4, 50)).toBe(true);
		// ...and a genuinely different cell is a separate question.
		expect(peekUrbanVerdict(centre + CELL_DEG * 2, 50)).toBeNull();
	});
});

describe("classifyPending — the expensive call happens ONCE per cell", () => {
	it("asks the expensive question once per distinct cell, not per detection", () => {
		const isUrbanFn = vi.fn(() => false);
		// 500 detections, all on ONE cell.
		const coords = Array.from({ length: 500 }, () => [-121, 50] as const);
		return classifyPending(coords, isUrbanFn).then(() => {
			expect(isUrbanFn).toHaveBeenCalledTimes(1);
		});
	});

	it("never re-asks a question it has already answered", async () => {
		const isUrbanFn = vi.fn(() => false);
		const coords = [at(0), at(1), at(2)];
		await classifyPending(coords, isUrbanFn);
		expect(isUrbanFn).toHaveBeenCalledTimes(3);
		// A second pan over the same ground must cost NOTHING.
		isUrbanFn.mockClear();
		await classifyPending(coords, isUrbanFn);
		expect(isUrbanFn).not.toHaveBeenCalled();
	});

	it("reports whether it learned anything, so paint isn't re-run for free", async () => {
		const coords = [at(0)];
		expect(await classifyPending(coords, () => false)).toBe(true);
		// Nothing new → false → the caller skips its repaint.
		expect(await classifyPending(coords, () => false)).toBe(false);
	});

	it("does nothing at all for an empty list", async () => {
		const isUrbanFn = vi.fn(() => false);
		expect(await classifyPending([], isUrbanFn)).toBe(false);
		expect(isUrbanFn).not.toHaveBeenCalled();
	});

	it("stores the verdicts it computed", async () => {
		await classifyPending([at(0), at(1)], (lng) => lng < -120.995);
		expect(peekUrbanVerdict(...at(0))).toBe(true);
		expect(peekUrbanVerdict(...at(1))).toBe(false);
		expect(classifiedCount()).toBe(2);
	});

	it("YIELDS between slices so the map keeps painting", async () => {
		// The property that stops a big classify run freezing a pan. Without the
		// await, 5,000 cells would run as one blocking task.
		const coords = Array.from({ length: 1000 }, (_, i) => at(i));
		let resolved = false;
		const p = classifyPending(coords, () => false, 100).then(() => {
			resolved = true;
		});
		// Still in flight after a microtask drain — proof it did not run to
		// completion synchronously.
		await Promise.resolve();
		expect(resolved).toBe(false);
		await p;
		expect(resolved).toBe(true);
	});
});

describe("the paint path never blocks on classification", () => {
	it("an unknown cell reads as NOT urban, so the fire renders", () => {
		// Failing toward SHOWING is the right direction for a hazard layer: an
		// unclassified city dot that vanishes a moment later is a blink; a real
		// fire suppressed because classification hadn't finished is the failure
		// this whole layer exists to prevent.
		expect(peekUrbanVerdict(-121, 50)).toBeNull();
		// The paint predicate is `=== true`, so null renders the hotspot.
		expect(peekUrbanVerdict(-121, 50) === true).toBe(false);
	});
});
