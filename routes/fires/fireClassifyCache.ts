/**
 * fireClassifyCache.ts — classify a hotspot ONCE, not on every paint.
 *
 * ── The bug this exists to kill ──
 * The city rule (`isUrban`) linearly scans 11,878 urban polygons per hotspot.
 * Measured on a real cache: **17.8 ms per 1,000 hotspots**, so a normal paint of
 * ~11,400 survivors cost **~200 ms of blocking main-thread work** — 10–50× every
 * other step in the paint combined (IndexedDB read 14 ms, union 12, wall 4,
 * GeoJSON 2, structured clone 7). And `paint()` runs on every pan.
 *
 * The layer was making the map feel sluggish, which is unacceptable: fires are
 * an afterthought. 95%+ of the time a planter is looking for something else
 * entirely, and a hazard overlay must never cost them a frame.
 *
 * ── Why a cache rather than a faster scan ──
 * A spatial index would make `isUrban` maybe 20× faster and still recompute the
 * same answer for the same coordinate on every single pan. But **whether a
 * hotspot sits in a city is a property of the hotspot, not of the paint.** It
 * cannot change between frames. So the fix is to compute it once and remember
 * it, which is O(1) forever after and survives zoom, pan and re-entry.
 *
 * Keyed by the ~375 m cell (`cellKey`), not the raw coordinate: neighbouring
 * detections in the same cell share an answer, which collapses tens of
 * thousands of lookups into a few hundred distinct ones.
 *
 * In-memory only, deliberately. It rebuilds in milliseconds from the polygons
 * already in memory, and persisting it would mean a schema, a version and an
 * invalidation story for a value that is free to recompute.
 */

import { cellKey } from "./masks/staticHeatSources";

/** cellKey → is this cell urban. */
const verdicts = new Map<string, boolean>();

/**
 * How many cells to classify per synchronous slice.
 *
 * Sized from the measurement: ~17.8 ms per 1,000 raw lookups, and distinct
 * cells are far fewer than detections, so 400 keeps any single slice comfortably
 * inside one frame's budget even on a slow phone.
 */
export const CLASSIFY_SLICE = 400;

/** Already-known verdict for a coordinate, or null if not yet classified. */
export function peekUrbanVerdict(lng: number, lat: number): boolean | null {
	const v = verdicts.get(cellKey(lng, lat));
	return v === undefined ? null : v;
}

/** Record a verdict. */
export function setUrbanVerdict(lng: number, lat: number, urban: boolean): void {
	verdicts.set(cellKey(lng, lat), urban);
}

/**
 * Classify any coordinates we haven't seen, in frame-sized slices, yielding
 * between each so the map keeps painting.
 *
 * Returns true when it actually learned something — the caller repaints only
 * then, so a pan over already-known ground costs nothing.
 *
 * ⚠️ Never await this before a first paint. The layer must draw immediately
 * with whatever it knows and refine afterwards; blocking the map on fire
 * classification is the exact problem this module exists to remove.
 */
export async function classifyPending(
	coords: readonly (readonly [number, number])[],
	isUrbanFn: (lng: number, lat: number) => boolean,
	sliceSize: number = CLASSIFY_SLICE,
): Promise<boolean> {
	// Distinct unknown cells only — tens of thousands of detections collapse to
	// a few hundred questions.
	const todo = new Map<string, readonly [number, number]>();
	for (const c of coords) {
		const key = cellKey(c[0], c[1]);
		if (!verdicts.has(key) && !todo.has(key)) todo.set(key, c);
	}
	if (todo.size === 0) return false;

	let i = 0;
	for (const [key, c] of todo) {
		verdicts.set(key, isUrbanFn(c[0], c[1]));
		if (++i % sliceSize === 0) {
			// Yield the thread. A macrotask, not a microtask — microtasks run
			// before paint and would not release the frame.
			await new Promise((r) => setTimeout(r, 0));
		}
	}
	return true;
}

/** How many cells are classified — for diagnostics and tests. */
export function classifiedCount(): number {
	return verdicts.size;
}

/** Test seam. */
export function __resetClassifyCacheForTest(): void {
	verdicts.clear();
}
