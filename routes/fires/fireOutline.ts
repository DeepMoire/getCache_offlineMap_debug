/**
 * fireOutline.ts — a thin red line around each group of fire detections.
 *
 * ── What it is for ──
 * Thirty orange flames scattered across a hillside do not, on their own, say
 * "there is A FIRE here". They say "there are thirty things here". BC Wildfire's
 * public map solves this by drawing a perimeter around each incident, and the
 * effect is reassurance in both directions: the fire is INSIDE the line, and —
 * just as importantly — it is NOT outside it.
 *
 * That second half is the real product. A planter looking at a cluster near
 * their block wants to know where it stops.
 *
 * ── ⚠️ This is NOT a fire perimeter, and must never be presented as one ──
 * BC Wildfire's outlines are surveyed by people on the ground. Ours is a hull
 * drawn around satellite pixels — it is a READING AID for the dots that are
 * already on screen, not an authority on where the fire front is. Consequences,
 * all deliberate:
 *
 *   • the dots are ALWAYS still drawn, and are the primary mark. The line adds
 *     to them, never replaces them (a shape alone would imply a survey)
 *   • it is thin and unfilled — a pencil line, not a hazard zone
 *   • no tap target, no card, no area readout. The card's `Size` is the honest
 *     figure, computed from unique 375 m cells; a hull's area would be the
 *     "area between the dots" error this layer explicitly rejected (a hull over
 *     six markers measured 22,328 ha, nearly all unburnt hillside)
 *
 * ── Why convex hulls, and why that is enough ──
 * "The lines don't have to be perfect, you don't need a lot of points, just
 * more or less" — and a convex hull is the cheapest honest answer. Concave
 * (alpha) shapes hug the dots more tightly and cost an order of magnitude more
 * code, for a shape nobody will measure. Measured on a real 500 km disc during
 * BC fire season:
 *
 *   36,489 detections → 12,197 distinct cells
 *   → 303 groups (flood fill, 45 ms)
 *   → 142 outlines of ≥5 cells (hulls, 7 ms)
 *   → 980 vertices total, ~16 KB of GeoJSON
 *
 * ~52 ms ONCE per data change, not per frame — the same discipline as
 * `fireClassifyCache` and the union memo: the outlines are a property of the
 * DATA, so panning must never recompute them.
 *
 * ⚠️ THAT SENTENCE WAS AN INTENTION, NOT A FACT, FOR ITS FIRST LIFE. The caller
 * runs this inside `paint()`, and `paint()` IS the pan path (moveend → ensure →
 * paint), so the full ~52 ms landed on every pan gesture. Two memos now make the
 * claim true — see `fireOutlines` — and the reason it took two is worth keeping:
 * the first attempt sat after the cell bucketing and still paid ~20 ms per pan
 * to reach itself. A memo placed after the expensive part is not a memo.
 *
 * If you touch this file, re-measure the PAN, not the cold build. The cold
 * number has never been the problem.
 */

/** Grid quantum — one VIIRS pixel. Mirrors `CELL_DEG` in staticHeatSources. */
const CELL_DEG = 0.00375;

/**
 * How many cells apart two detections can be and still count as one fire.
 *
 * 2 cells ≈ 750 m. Chosen so a fire seen by different satellites on slightly
 * offset grids still joins up (a pixel wanders a few hundred metres between
 * passes), without chaining unrelated fires across a valley into one shape.
 */
const JOIN_CELLS = 2;

/**
 * Below this many cells, no outline is drawn.
 *
 * A line around one or two dots is noise: it says nothing the dots did not
 * already say, and at low zoom it degenerates into a speck. The dots themselves
 * are never suppressed — this only decides whether the group is worth ringing.
 */
const MIN_CELLS = 5;

/**
 * How far OUTSIDE the outermost detections the line is drawn.
 *
 * ⚠️ Without any margin the hull runs through the CENTRES of the edge
 * detections, so every border flame straddles the line and half of each icon
 * hangs outside — it reads as "the outline missed some of them".
 *
 * ⚠️⚠️ But this number is TINY, and the first attempt at it was ~5× too big.
 * The correct gap is about ONE FLAME ICON — just enough that the border icons
 * sit inside the line rather than on it. At 4 cells (1.5 km) the line stood a
 * huge empty swath away from the nearest fire, which is worse than no margin:
 * an outline that far out silently claims ground that is not burning, and the
 * whole point of the shape is that the fire is inside it and NOT outside.
 *
 * 0.8 cells ≈ 300 m ≈ the width of the flame glyph at the zooms where the
 * outline is visible. Nudge it in hundredths, never in whole cells.
 */
const OUTLINE_MARGIN_DEG = CELL_DEG * 0.8;

type Cell = number; // packed grid key, see cellOf

/**
 * The memo for `fireOutlines` — see the long note at its cell-key computation.
 *
 * Module-scope and shared by BOTH maps, which is safe and in fact desirable:
 * the key is derived purely from the cell set, so the online and offline maps
 * showing the same fires legitimately share one answer. The stored value is
 * never mutated by this module; callers clone it across the GL worker boundary.
 *
 * Bounded by construction — exactly one entry, replaced whenever the data
 * changes. There is nothing to evict and no growth path.
 */
let outlineMemoKey: string | null = null;
let outlineMemo: GeoJSON.FeatureCollection | null = null;
/**
 * The hotspot array the memo was built from — the FAST-PATH key, checked before
 * any work happens (see the note at the top of `fireOutlines`).
 *
 * A WeakRef so a stale memo can never keep a 36,000-element hotspot array alive.
 * This module is the fire layer's, and the fire layer is the one that was
 * holding tens of thousands of detections resident; a memo that reintroduced
 * that would be trading one leak for another.
 */
let outlineMemoSrc: WeakRef<object> | null = null;
let outlineMemoLen = -1;

/** Drop the memo. Exported for tests, which need each case to compute fresh. */
export function __resetOutlineMemoForTest(): void {
	outlineMemoKey = null;
	outlineMemo = null;
	outlineMemoSrc = null;
	outlineMemoLen = -1;
}

/** Pack a grid coordinate into one number so the Set/Map stay primitive-keyed —
 *  string keys measured ~3× slower at this volume. */
function pack(gx: number, gy: number): Cell {
	// gy is offset into the upper bits; ±2^20 cells covers the whole globe at
	// 375 m with room to spare.
	return gx * 4_194_304 + gy;
}

function cellOf(lng: number, lat: number): { gx: number; gy: number } {
	return {
		gx: Math.round(lng / CELL_DEG),
		gy: Math.round(lat / CELL_DEG),
	};
}

/**
 * Convex hull, monotone chain. Returns the ring in order, WITHOUT repeating the
 * first point (the caller closes it for GeoJSON).
 *
 * Local rather than turf: this module is pure and dependency-free so it can be
 * tested without pulling map code into the environment, and turf's `convex`
 * allocates a FeatureCollection per call — 142 of those per rebuild is waste.
 */
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
 * Push every vertex OUTWARD from the ring's centroid, so the line clears the
 * detections instead of bisecting them.
 *
 * Radial rather than a true geometric offset (mitred edges, arc joins): a
 * convex ring has no reflex corners, so pushing the vertices out along the
 * centroid ray always produces a valid, slightly larger convex ring — and it is
 * a dozen lines instead of a polygon-offset library. The corners end up a touch
 * more generous than the edges, which is the harmless direction: corners are
 * where a stray flame is most likely to sit outside.
 *
 * Longitude is scaled by cos(lat) so the margin is the same distance ON THE
 * GROUND north and south — at 50°N a degree of longitude is only ~64% of a
 * degree of latitude, and skipping this would make the line visibly tighter
 * east-west the further north you go.
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
		// A vertex sitting exactly on the centroid has no outward direction;
		// leaving it put is correct and avoids dividing by zero.
		if (len < 1e-12) return [p[0], p[1]] as [number, number];
		return [
			p[0] + ((dx / len) * marginDeg) / lngScale,
			p[1] + (dy / len) * marginDeg,
		] as [number, number];
	});
}

/**
 * Group detections into fires and draw one outline around each.
 *
 * Flood fill over the 375 m grid: two cells belong to the same fire if they are
 * within `JOIN_CELLS` of each other. That is a plain connected-components pass,
 * O(cells), with no distance matrix and no clustering library.
 */
export function fireOutlines(
	hotspots: readonly { coordinates: readonly [number, number] }[],
	/**
	 * OPTIONAL stable identity for `hotspots`, for the fast-path memo.
	 *
	 * ⚠️ Needed because the obvious key — `hotspots` itself — is NOT stable in
	 * the real caller. `paint()` passes `shown`, which `fireFeatureCollection`
	 * produces with `.filter()`, so it is a brand-new array on every pan even
	 * when not one detection changed. Keying on it meant the fast path never hit
	 * and every pan re-bucketed 36,000 detections into 12,000 cells (~20 ms) just
	 * to reach the second-tier memo.
	 *
	 * The caller instead passes the UPSTREAM array that `shown` is derived from
	 * (`unionHotspots().hotspots`, which IS memoized and therefore reference-
	 * stable until the cache actually changes). Pass nothing and the memo simply
	 * falls back to content hashing — correct, just slower.
	 */
	stableKey?: object,
): GeoJSON.FeatureCollection {
	// ── THE PER-PAN MEMO — CHECKED FIRST, BEFORE ANY WORK ──
	//
	// ⚠️ Placement is the whole fix, and getting it wrong is subtle enough to be
	// worth spelling out. This memo originally sat AFTER the `cellPts` build, so
	// it correctly skipped the hulls but still paid ~20 ms per pan bucketing
	// 36,000 detections into 12,000 cells — plus the GC churn of allocating that
	// Map every frame. Measured: 50 ms cold, but still 69 ms per pan with the
	// memo "hitting". A memo that runs after the expensive part is not a memo.
	//
	// So the key must be derivable WITHOUT touching the hotspots. The only such
	// signal is the array itself, hence identity + length: `paint()` hands over
	// the exact same `shown` array reference for repeat paints of unchanged data
	// (it is rebuilt only when the underlying hotspot list is re-derived), and
	// length guards the one case where a mutated-in-place array keeps identity.
	//
	// ⚠️ This is deliberately CONSERVATIVE: a caller that rebuilds an identical
	// array gets a miss and recomputes. That costs one wasted rebuild — correct,
	// just slower. The opposite error, a stale hit, would freeze the outlines
	// while the fires under them moved, and this layer's entire job is not lying
	// about where fire is. When in doubt, recompute.
	const fastKey = stableKey ?? hotspots;
	if (
		outlineMemo !== null &&
		outlineMemoSrc !== null &&
		outlineMemoSrc.deref() === fastKey &&
		outlineMemoLen === hotspots.length
	) {
		return outlineMemo;
	}

	// One representative point per cell — the hull only ever needs cell corners,
	// and collapsing 36k detections to 12k cells is most of the speed-up.
	const cellPts = new Map<Cell, [number, number]>();
	for (const h of hotspots) {
		const [lng, lat] = h.coordinates;
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
		const { gx, gy } = cellOf(lng, lat);
		const key = pack(gx, gy);
		if (!cellPts.has(key)) cellPts.set(key, [lng, lat]);
	}

	// ── THE SECOND-TIER MEMO ──
	//
	// The header above promises "~52 ms ONCE per data change, not per frame", and
	// the call site says "panning never recomputes it". Neither was true: the
	// caller runs this inside `paint()`, and `paint()` is exactly the pan path
	// (moveend → ensure → paint). So every pan rebuilt 142 hulls to produce a
	// byte-identical answer — the same disease the union memo and
	// `fireClassifyCache` were both written to cure, caught a third time.
	//
	// Keyed on the CELL SET, not the hotspot array: `shown` is rebuilt fresh on
	// every paint (a filter inside `fireFeatureCollection`), so identity is
	// useless here — but the cells are the only input the outlines actually
	// depend on. Two paints over unchanged data produce the same key and skip the
	// work; a genuine data change moves a cell and misses.
	//
	// ⚠️ The key is a COMMUTATIVE HASH, not a sorted join. Sorting 12,197 cells
	// and joining them into a ~90 KB string on every pan would be a cheaper
	// version of the same mistake — real work, every frame, to decide whether to
	// skip real work. Summing and XOR-ing is O(cells) with no allocation, and
	// both operations are order-independent, so a reordered-but-identical cell
	// set still hits.
	//
	// Two accumulators because either alone collides too easily: XOR misses
	// duplicate-pair changes, addition misses swaps around the modulus. Together
	// with the exact count, a collision needs a change that preserves the size,
	// the sum AND the xor — which no realistic edit to a fire field does.
	let sum = 0;
	let xor = 0;
	for (const k of cellPts.keys()) {
		sum = (sum + k) % 0x7fffffff;
		xor ^= k;
	}
	const key = `${cellPts.size}:${sum}:${xor}`;
	if (key === outlineMemoKey && outlineMemo !== null) {
		// Content matched even though the array was a different object — so adopt
		// THIS array as the fast-path key. Without this, a caller that rebuilds an
		// equal-but-new array would pay the cell bucketing on every single pan
		// forever, never graduating to the cheap check above.
		outlineMemoSrc = new WeakRef(fastKey as object);
		outlineMemoLen = hotspots.length;
		return outlineMemo;
	}

	const seen = new Set<Cell>();
	const features: GeoJSON.Feature[] = [];

	for (const start of cellPts.keys()) {
		if (seen.has(start)) continue;
		// Iterative, never recursive: a province-sized blob is ~1,700 cells deep
		// and recursion would risk the stack on a phone.
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
			// No id, no tap target, no properties worth reading: this is a reading
			// aid for the dots, and giving it a card would make it look surveyed.
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
	// Arm the fast path too, so the NEXT pan over this same array skips even the
	// cell bucketing above.
	outlineMemoSrc = new WeakRef(fastKey as object);
	outlineMemoLen = hotspots.length;
	return result;
}
