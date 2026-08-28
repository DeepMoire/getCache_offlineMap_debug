/**
 * urbanExclusion.ts — no wildfires inside the city.
 *
 * ── The rule, and why it is the RIGHT rule ──
 * This is a WILDFIRE layer. Wildfire agencies do not plot fires inside built-up
 * areas, and every serious wildfire map follows the same convention: a hotspot
 * in a city is industrial heat, a flare, an incinerator or a rooftop — not the
 * thing a planter is scanning for. Showing one discredits the whole layer.
 *
 * So: a detection inside (or within `URBAN_BUFFER_KM` of) a mapped urban area
 * is EXCLUDED, everywhere in the world, unconditionally.
 *
 * ── Why this replaced the archive-persistence rule as the PRIMARY filter ──
 * The first attempt derived a mask from a year of FIRMS history: flag any
 * ~375 m cell seen on >= 12 distinct days. It worked on the cell it was tuned
 * against and then missed the very next one the user found — that marker's
 * cells showed **9 and 8 days**, real industrial persistence sitting just under
 * the threshold. Measured, not guessed.
 *
 * Chasing that with a lower threshold is the wrong move: it trades one
 * arbitrary number for another, needs a year of archive per region, and has to
 * be rebuilt annually. Geography is the stable signal. The persistence mask is
 * KEPT as a secondary catch for isolated industry out in the bush (mills, camp
 * flares) where no urban polygon exists — but the city rule does the heavy
 * lifting and needs no history at all.
 *
 * ── Why the buffer ──
 * Natural Earth's urban polygons hug the built-up core. Measured against the
 * four false alarms around Vancouver: at 0 km only ONE was caught; at 5 km all
 * four were, while a fire in deep BC bush and the town of Whitecourt stayed.
 * Industrial land — tank farms, rail yards, port terminals — sits in exactly
 * that fringe just outside the mapped edge.
 *
 * ⚠️ This EXCLUDES rather than flags, deliberately, and it is the one place in
 * this layer that hides data. The reasoning is different from the refinery
 * case: a lone refinery out in the trees is a landmark worth showing dimmed,
 * whereas a hotspot in downtown Vancouver is noise that makes the map look
 * broken. City fires are a municipal fire department's business, not a tree
 * planter's, and a planter has no use for one either way.
 *
 * Pure geometry; polygons are injected. Loading lives in `urbanIndex.ts`.
 */

import { bboxInRegion, type RegionBox } from "../../../lib/shared/assetRegion";

/** Ring of [lng, lat] pairs. */
export type Ring = readonly (readonly number[])[];

/** One urban area, pre-bounded so the hot path can reject fast. */
export interface UrbanPoly {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly ring: Ring;
}

/**
 * How far outside a mapped urban edge still counts as "city".
 *
 * 5 km, measured. See the header: at 0 km three of four real false alarms
 * survived; at 5 km all four were caught with no wanted fire lost. Don't raise
 * it casually — every extra kilometre eats real bush.
 */
export const URBAN_BUFFER_KM = 5;

const KM_PER_DEG_LAT = 110.57;

/** Even-odd point-in-polygon. */
export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
	let inside = false;
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % n];
		if (
			y1 > lat !== y2 > lat &&
			lng < ((x2 - x1) * (lat - y1)) / (y2 - y1 || 1e-12) + x1
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** Approximate km from a point to a ring's nearest VERTEX.
 *
 *  Vertex distance rather than true segment distance: Natural Earth rings are
 *  dense enough that the difference is well under the buffer's own precision,
 *  and this runs per-hotspot on every paint. Correct-enough beats exact-and-slow
 *  when the threshold is itself a judgement call. */
export function kmToRing(lng: number, lat: number, ring: Ring): number {
	const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180);
	let best = Number.POSITIVE_INFINITY;
	for (const p of ring) {
		const dx = (p[0] - lng) * kmPerDegLng;
		const dy = (p[1] - lat) * KM_PER_DEG_LAT;
		const d = Math.hypot(dx, dy);
		if (d < best) best = d;
	}
	return best;
}

/** Prepare raw GeoJSON polygons for fast repeated testing. */
export function prepareUrban(
	features: readonly { geometry: { type: string; coordinates: unknown } }[],
	/** Keep only polygons overlapping this window. `null`/omitted = keep the whole
	 *  world (the original behaviour, and the correct fallback — a wrongly windowed
	 *  asset silently stops excluding city hotspots). See assetRegion.ts. */
	region: RegionBox | null = null,
): UrbanPoly[] {
	const out: UrbanPoly[] = [];
	for (const f of features) {
		if (f.geometry?.type !== "Polygon") continue;
		const ring = (f.geometry.coordinates as number[][][])[0];
		if (!Array.isArray(ring) || ring.length < 3) continue;
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const p of ring) {
			if (p[0] < minX) minX = p[0];
			if (p[0] > maxX) maxX = p[0];
			if (p[1] < minY) minY = p[1];
			if (p[1] > maxY) maxY = p[1];
		}
		// THE WINDOW. Out-of-region polygons are dropped WITHOUT retaining `ring` —
		// which is the whole point. The ring is the expensive part (a boxed array of
		// boxed [lng,lat] pairs, ~80-100 bytes per 16 bytes of numbers), so filtering
		// later would mean paying for all 11,878 of them first. Nothing here holds a
		// reference, so the parsed input stays collectable.
		if (region && !bboxInRegion(region, minX, minY, maxX, maxY)) continue;
		out.push({ minX, minY, maxX, maxY, ring });
	}
	return out;
}

/**
 * Is this detection in (or near) a city?
 *
 * Returns false when there are no polygons — a missing asset must never hide
 * fires. Failing toward SHOWING is the safe direction for a hazard layer.
 */
export function isUrban(
	lng: number,
	lat: number,
	polys: readonly UrbanPoly[],
	bufferKm: number = URBAN_BUFFER_KM,
): boolean {
	if (polys.length === 0) return false;
	// Degrees of padding for the bbox pre-filter. Generous on purpose — this is
	// only a cheap reject, and the real test follows.
	const padY = bufferKm / KM_PER_DEG_LAT;
	const padX = padY / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
	for (const p of polys) {
		if (
			lng < p.minX - padX ||
			lng > p.maxX + padX ||
			lat < p.minY - padY ||
			lat > p.maxY + padY
		) {
			continue;
		}
		if (pointInRing(lng, lat, p.ring)) return true;
		if (bufferKm > 0 && kmToRing(lng, lat, p.ring) <= bufferKm) return true;
	}
	return false;
}
