/**
 * fireClassifyCache.ts — classify a hotspot ONCE, not on every paint.
 *
 * Whether a hotspot sits in a city is a property of the hotspot, not of the paint — it cannot change between frames, so compute once and reuse forever.
 * Keyed by the ~375 m cell (`cellKey`), not the raw coordinate — neighbouring detections share an answer.
 * In-memory only, deliberately — rebuilds in milliseconds from polygons already in memory; not worth a persistence schema for a value this cheap to recompute.
 */

import { cellKey } from "./masks/staticHeatSources";

/** cellKey → is this cell urban. */
const verdicts = new Map<string, boolean>();

/** How many cells to classify per synchronous slice. Sized from measurement (~17.8 ms/1,000 lookups) so 400 keeps a slice inside one frame's budget even on a slow phone. */
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
 * Classifies any coordinates not yet seen, in frame-sized slices, yielding between each so the map keeps painting. Returns true only when it learned something, so a pan over already-known ground costs nothing.
 * ⚠️ Never await this before a first paint — the layer must draw immediately with whatever it knows and refine afterwards; blocking the map on classification is the exact problem this module exists to remove.
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
			// Yield via a macrotask, not a microtask — microtasks run before paint
			// and wouldn't release the frame.
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
