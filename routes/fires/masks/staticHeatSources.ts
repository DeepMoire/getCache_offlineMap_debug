/**
 * staticHeatSources.ts — replicates NASA's own FIRMS type-2 "static land source" rule (unavailable in the NRT feed) via PERSISTENCE: a cell seen on PERSIST_DAYS+ distinct days in a year is flagged.
 * ⚠️ Urban land cover alone is NOT sufficient — the Richmond tank farm sits just OUTSIDE the mapped urban area; urban cover is a secondary signal only, never primary.
 * ⚠️ FLAG, NEVER DELETE — a refinery can genuinely catch fire; hard-deleting would mean the app says nothing the one day it matters most.
 * Pure logic; the mask is injected. Loading lives in staticHeatIndex.ts.
 */

/** Grid cell size in degrees latitude ≈ 375 m, matching VIIRS's pixel. */
export const CELL_DEG = 0.00375;

/** Distinct detection-days in a year that make a cell "static". NASA uses 16; we use 12 — tuned for a field tool where a mislabelled flare erodes trust, and safe to lower since FLAG (not delete) keeps a wrongly-flagged cell reachable. */
export const PERSIST_DAYS = 12;

/** Cell key for a coordinate. Integer pair, so it is exact and hashable. */
export function cellKey(lng: number, lat: number): string {
	return `${Math.round(lat / CELL_DEG)},${Math.round(lng / CELL_DEG)}`;
}

/** The mask: the set of persistent-source cell keys. */
export type StaticMask = ReadonlySet<string>;

/** Is this detection on a known permanent heat source? Checks the cell and its 8 neighbours — a pixel wanders between passes, so exact-cell matching alone would let the same flare slip through about half the time. */
export function isStaticSource(
	lng: number,
	lat: number,
	mask: StaticMask,
): boolean {
	if (mask.size === 0) return false;
	const gy = Math.round(lat / CELL_DEG);
	const gx = Math.round(lng / CELL_DEG);
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			if (mask.has(`${gy + dy},${gx + dx}`)) return true;
		}
	}
	return false;
}

/** Split detections into the ones to show and the ones to flag. */
export function partitionStatic<T extends { coordinates: readonly [number, number] }>(
	detections: readonly T[],
	mask: StaticMask,
): { wildfire: T[]; industrial: T[] } {
	const wildfire: T[] = [];
	const industrial: T[] = [];
	for (const d of detections) {
		if (isStaticSource(d.coordinates[0], d.coordinates[1], mask)) {
			industrial.push(d);
		} else {
			wildfire.push(d);
		}
	}
	return { wildfire, industrial };
}

/** Build a mask from raw archive detections. Exported so a future rebuild can run the same code the asset was generated with, rather than a second implementation that drifts from it. */
export function buildMask(
	detections: readonly { lat: number; lng: number; day: string }[],
	persistDays: number = PERSIST_DAYS,
): Set<string> {
	const days = new Map<string, Set<string>>();
	for (const d of detections) {
		const key = cellKey(d.lng, d.lat);
		let set = days.get(key);
		if (set === undefined) {
			set = new Set();
			days.set(key, set);
		}
		set.add(d.day);
	}
	const mask = new Set<string>();
	for (const [key, seen] of days) {
		if (seen.size >= persistDays) mask.add(key);
	}
	return mask;
}

/** What the card says for a flagged detection — plain, not apologetic; a fact about the source, not a hedge about the data. */
export const INDUSTRIAL_LABEL = "Industrial heat source";
