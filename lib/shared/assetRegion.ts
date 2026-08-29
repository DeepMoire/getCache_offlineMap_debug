/**
 * assetRegion.ts — THE REGION WINDOW for world-scale bundled assets.
 *
 * ⚠️ This is a WINDOW, not a download boundary — assets still ship whole and work with no signal; we just refuse to keep the parts of the planet the user is nowhere near. Move far enough and it rebuilds from the same bundled file (see `regionChanged`).
 */

// degree/km conversions come from offlineShared/geo, the ONE place that math lives — nothing here re-derives a pole guard or cos(lat) divisor.
import { degBoxAround, kmBetween } from "./kmGeo";

/** Half-width of the retained window, in km — 1,500km is ~3× the 500km fire-relevance wall: tight enough to avoid holding a continent, wide enough that distant-fire place names don't go blank. */
export const DEFAULT_REGION_KM = 1500;

/** A lng/lat window. Degrees, west/south/east/north. */
export interface RegionBox {
	readonly w: number;
	readonly s: number;
	readonly e: number;
	readonly n: number;
}

/** The retained window around a centre — straight through `degBoxAround` (owns the km→degree conversion and pole guard); longitude degrees shrink toward the poles, so `kmToDegSpan` widens the east-west span by 1/cos(lat) to hold a constant km distance. */
export function regionAround(
	centre: readonly [number, number],
	km: number = DEFAULT_REGION_KM,
): RegionBox {
	const [w, s, e, n] = degBoxAround(
		[centre[0], centre[1]] as [number, number],
		km,
	);
	return { w, s, e, n };
}

/** Is this point inside the window? */
export function inRegion(box: RegionBox, lng: number, lat: number): boolean {
	return lng >= box.w && lng <= box.e && lat >= box.s && lat <= box.n;
}

/** Does this bbox overlap the window at all? (Polygons, which have extent.) */
export function bboxInRegion(
	box: RegionBox,
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): boolean {
	return !(maxX < box.w || minX > box.e || maxY < box.s || minY > box.n);
}

/** Has the user moved far enough to need a different window? Threshold is HALF the window's half-width (wide hysteresis) — without it, a user near a boundary would re-parse ~6MB on every GPS jitter. `null` (never loaded) always counts as changed. */
export function regionChanged(
	loadedAt: readonly [number, number] | null,
	now: readonly [number, number],
	km: number = DEFAULT_REGION_KM,
): boolean {
	if (loadedAt === null) return true;
	return (
		kmBetween(
			[loadedAt[0], loadedAt[1]] as [number, number],
			[now[0], now[1]] as [number, number],
		) >
		km / 2
	);
}
