/**
 * fireOutline.ts — a thin red line around each group of fire detections.
 * ⚠️ NOT a fire perimeter — a reading aid over satellite pixels, never a surveyed authority; dots stay primary, no tap target/card/area readout.
 * ⚠️ A memo placed after the expensive part is not a memo — re-measure the PAN cost (not the cold build) when touching this file.
 */

/** Grid quantum — one VIIRS pixel. Mirrors `CELL_DEG` in staticHeatSources. */
const CELL_DEG = 0.00375;

/** How many cells apart two detections still count as one fire (2 cells ≈ 750 m — joins offset satellite passes, not unrelated fires). */
const JOIN_CELLS = 2;

/** Below this many cells, no outline is drawn — a line around 1-2 dots is noise; the dots themselves are never suppressed. */
const MIN_CELLS = 5;

/**
 * How far OUTSIDE the outermost detections the line is drawn (0.8 cells ≈ 300 m — nudge in hundredths, never whole cells).
 * ⚠️ No margin → hull runs through detection centres, border flames straddle the line.
 * ⚠️ Too big a margin is worse than none — 4 cells (1.5km) silently claimed unburnt ground; keep it ~one flame icon wide.
 */
const OUTLINE_MARGIN_DEG = CELL_DEG * 0.8;

type Cell = number; // packed grid key, see cellOf

/** Module-scope memo shared by both maps (key = cell set); never mutated here — callers clone it across the GL worker boundary. Bounded: one entry, replaced on change. */
let outlineMemoKey: string | null = null;
let outlineMemo: GeoJSON.FeatureCollection | null = null;
/** Fast-path key for the memo (checked before any work). WeakRef — a strong ref here would leak the 36k-element hotspot array. */
let outlineMemoSrc: WeakRef<object> | null = null;
let outlineMemoLen = -1;

/** Drop the memo. Exported for tests, which need each case to compute fresh. */
export function __resetOutlineMemoForTest(): void {
	outlineMemoKey = null;
	outlineMemo = null;
	outlineMemoSrc = null;
	outlineMemoLen = -1;
}

/** Pack a grid coordinate into one number — primitive Set/Map keys measured ~3× faster than strings at this volume. */
function pack(gx: number, gy: number): Cell {
	// gy is offset into upper bits; ±2^20 cells covers the whole globe at 375m with room to spare.
	return gx * 4_194_304 + gy;
}

function cellOf(lng: number, lat: number): { gx: number; gy: number } {
	return {
		gx: Math.round(lng / CELL_DEG),
		gy: Math.round(lat / CELL_DEG),
	};
}

/** Convex hull, monotone chain. Returns the ring in order, WITHOUT repeating the first point (caller closes it for GeoJSON). */
export function convexHull(
	points: readonly (readonly [number, number])[],
): [number, number][] {
	const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (pts.length <= 2) return pts.map((p) => [p[0], p[1]]);
	const cross = (
		o: readonly [number, number],
		a: readonly [number, number],
		b: readonly [number, number],
	): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

	const lower: (readonly [number, number])[] = [];
	for (const p of pts) {
		while (
			lower.length >= 2 &&
			cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
		)
			lower.pop();
		lower.push(p);
	}
	const upper: (readonly [number, number])[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (
			upper.length >= 2 &&
			cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
		)
			upper.pop();
		upper.push(p);
	}
	lower.pop();
	upper.pop();
	return [...lower, ...upper].map((p) => [p[0], p[1]]);
}

/**
 * Push every vertex outward from the ring's centroid so the line clears detections instead of bisecting them.
 * Longitude scaled by cos(lat) — skipping this makes the line visibly tighter east-west further north (~64% at 50°N).
 */
export function expandRing(
	ring: readonly (readonly [number, number])[],
	marginDeg: number,
): [number, number][] {
	if (ring.length < 3 || marginDeg <= 0) return ring.map((p) => [p[0], p[1]]);
	let cx = 0;
	let cy = 0;
	for (const p of ring) {
		cx += p[0];
		cy += p[1];
	}
	cx /= ring.length;
	cy /= ring.length;
	const lngScale = Math.max(0.2, Math.cos((cy * Math.PI) / 180));
	return ring.map((p) => {
		// Compare in ground units so a wide-but-short blob expands evenly.
		const dx = (p[0] - cx) * lngScale;
		const dy = p[1] - cy;
		const len = Math.hypot(dx, dy);
		// vertex exactly on centroid has no outward direction — leave it put, avoids divide-by-zero
		if (len < 1e-12) return [p[0], p[1]] as [number, number];
		return [
			p[0] + ((dx / len) * marginDeg) / lngScale,
			p[1] + (dy / len) * marginDeg,
		] as [number, number];
	});
}

/** Group detections into fires and draw one outline around each — flood fill over the 375m grid, O(cells), no distance matrix. */
export function fireOutlines(
	hotspots: readonly { coordinates: readonly [number, number] }[],
	/** OPTIONAL stable identity for `hotspots`, for the fast-path memo. ⚠️ `hotspots` itself is NOT stable — paint() passes a freshly-filtered `shown` every pan; pass the upstream stable array (e.g. unionHotspots().hotspots) instead, or omit to fall back to slower content hashing. */
	stableKey?: object,
): GeoJSON.FeatureCollection {
	// ⚠️ memo placement is the fix — must run BEFORE any work, or "hitting" still costs ~20ms/pan re-bucketing; a memo after the expensive part is not a memo.
	// ⚠️ deliberately conservative: a miss just recomputes (slow), but a stale hit would freeze outlines while fires move — when in doubt, recompute.
	const fastKey = stableKey ?? hotspots;
	if (
		outlineMemo !== null &&
		outlineMemoSrc !== null &&
		outlineMemoSrc.deref() === fastKey &&
		outlineMemoLen === hotspots.length
	) {
		return outlineMemo;
	}

	// one representative point per cell — hull only needs cell corners; collapsing 36k detections to 12k cells is most of the speed-up
	const cellPts = new Map<Cell, [number, number]>();
	for (const h of hotspots) {
		const [lng, lat] = h.coordinates;
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
		const { gx, gy } = cellOf(lng, lat);
		const key = pack(gx, gy);
		if (!cellPts.has(key)) cellPts.set(key, [lng, lat]);
	}

	// second-tier memo: keyed on the CELL SET (not the hotspot array), since `shown` is rebuilt fresh every paint but cells are the real input.
	// ⚠️ key is a commutative hash (sum + xor, O(cells), no allocation) — NOT a sorted join, which would just be the same "real work every frame" mistake again.
	let sum = 0;
	let xor = 0;
	for (const k of cellPts.keys()) {
		sum = (sum + k) % 0x7fffffff;
		xor ^= k;
	}
	const key = `${cellPts.size}:${sum}:${xor}`;
	if (key === outlineMemoKey && outlineMemo !== null) {
		// content matched despite a new array object — adopt it as the fast-path key, or an equal-but-new array pays cell bucketing forever
		outlineMemoSrc = new WeakRef(fastKey as object);
		outlineMemoLen = hotspots.length;
		return outlineMemo;
	}

	const seen = new Set<Cell>();
	const features: GeoJSON.Feature[] = [];

	for (const start of cellPts.keys()) {
		if (seen.has(start)) continue;
		// iterative, never recursive — a province-sized blob is ~1,700 cells deep; recursion would risk the stack on a phone
		const stack: Cell[] = [start];
		seen.add(start);
		const group: [number, number][] = [];

		while (stack.length > 0) {
			const cur = stack.pop() as Cell;
			const pt = cellPts.get(cur);
			if (pt) group.push(pt);
			const gy = ((cur % 4_194_304) + 4_194_304) % 4_194_304;
			const gx = Math.round((cur - gy) / 4_194_304);
			for (let dx = -JOIN_CELLS; dx <= JOIN_CELLS; dx++) {
				for (let dy = -JOIN_CELLS; dy <= JOIN_CELLS; dy++) {
					if (dx === 0 && dy === 0) continue;
					const n = pack(gx + dx, gy + dy);
					if (cellPts.has(n) && !seen.has(n)) {
						seen.add(n);
						stack.push(n);
					}
				}
			}
		}

		if (group.length < MIN_CELLS) continue;
		const ring = expandRing(convexHull(group), OUTLINE_MARGIN_DEG);
		if (ring.length < 3) continue;
		features.push({
			type: "Feature",
			// no id/tap target/properties — a card here would make the hull look surveyed
			properties: {},
			geometry: {
				type: "Polygon",
				coordinates: [[...ring, ring[0]]], // GeoJSON rings must close
			},
		});
	}

	const result: GeoJSON.FeatureCollection = {
		type: "FeatureCollection",
		features,
	};
	outlineMemoKey = key;
	outlineMemo = result;
	// arm the fast path too, so the NEXT pan over this array skips even the cell bucketing above
	outlineMemoSrc = new WeakRef(fastKey as object);
	outlineMemoLen = hotspots.length;
	return result;
}
