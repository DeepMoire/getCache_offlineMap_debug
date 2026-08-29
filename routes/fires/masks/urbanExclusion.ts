/**
 * urbanExclusion.ts — no wildfires inside the city.
 *
 * A detection inside (or within URBAN_BUFFER_KM of) a mapped urban area is excluded, everywhere in the world, unconditionally.
 * ⚠️ Deliberately EXCLUDES rather than flags — the only place in this layer that hides data; city fires aren't a tree planter's business.
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

/** 5 km, measured — how far outside a mapped urban edge still counts as "city". Don't raise casually: every extra km eats real bush. */
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

/** Approximate km from a point to a ring's nearest VERTEX. */
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
	/** Keep only polygons overlapping this window; null/omitted = keep the whole world — the correct fallback, since a wrongly windowed asset silently stops excluding city hotspots. */
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
		if (region && !bboxInRegion(region, minX, minY, maxX, maxY)) continue;
		out.push({ minX, minY, maxX, maxY, ring });
	}
	return out;
}

/** Is this detection in (or near) a city? Returns false when there are no polygons — a missing asset must never hide fires. */
export function isUrban(
	lng: number,
	lat: number,
	polys: readonly UrbanPoly[],
	bufferKm: number = URBAN_BUFFER_KM,
): boolean {
	if (polys.length === 0) return false;
	// Degrees of padding for the bbox pre-filter; a cheap reject before the exact test.
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
