// ⚠️ live position must pass containment before reaching note() — raw fixes at ~4-decimal precision mint a new area (and a fresh photo + fire fetch) every ~11m step.
// ⚠️ distance-MOVED thresholds are wrong here: they re-fire on a loop that returns inside coverage, and never fire on a slow creeping drift — measure distance from nearest COVERAGE instead.
// pure + synchronous: no IndexedDB, no geolocation, no permission checks.
import { kmBetween, type LngLat } from "./kmGeo";
import { BLOB_RADIUS_KM } from "../contract/roadBlob";
import { BAKE_RADIUS_KM } from "../onPhone/satellite/satelliteImage";
import { FIRE_RADIUS_KM } from "./fireContract";

/** The widest thing a map blob covers — the road disc. ⛔ Re-exported from roadBlob.ts, NEVER a literal — BLOB_RADIUS_KM owns the one road radius; not what MAP_TRIGGER_KM is measured against. */
export const MAP_COVERAGE_KM = BLOB_RADIUS_KM;

/** What "covered" means for a person looking at the screen — the satellite photo (2 km), not the road disc. ⚠️ THE DARKNESS BUG: this used to measure against the wider road ring (30km), so users could be "covered" while looking at blank ground — hit hardest via the always-noted Ottawa demo blob, which swallowed every nearby user. */
export const PHOTO_COVERAGE_KM = BAKE_RADIUS_KM;

/** How far from the nearest blob centre before we bake a new one — 75% of the photo radius (1.5 km), a containment test not a distance-moved test. */
export const MAP_TRIGGER_KM = PHOTO_COVERAGE_KM * 0.75;

/** The fire disc's reach, re-exported so callers reason about one pair of numbers (coverage + trigger) without importing from two modules. */
export const FIRE_COVERAGE_KM = FIRE_RADIUS_KM;

/** How far before we pull a fresh fire disc. 70% of the disc — the same margin logic as MAP_TRIGGER_KM. ~350 km, i.e. four or five hours of driving. */
export const FIRE_TRIGGER_KM = Math.round(FIRE_COVERAGE_KM * 0.7);

/** Distance to the nearest of centres, in km; Infinity when there are none, so the first fix always triggers a bake. */
export function kmToNearest(
	pos: LngLat,
	centres: readonly LngLat[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (const c of centres) {
		const d = kmBetween(pos, c);
		if (d < best) best = d;
	}
	return best;
}

/** Should the live position become an anchor for a new MAP blob? centres includes feature anchors — a planter beside their own pin must not mint a second blob 11m away. */
export function needsMapBlob(
	pos: LngLat,
	centres: readonly LngLat[],
): boolean {
	return kmToNearest(pos, centres) > MAP_TRIGGER_KM;
}

/** Should the live position pull a fresh FIRE disc? Geography only — time-based freshness is a separate axis owned by fireIsFresh in v4FireCache; don't conflate the two. */
export function needsFireDisc(
	pos: LngLat,
	fireCentres: readonly LngLat[],
): boolean {
	return kmToNearest(pos, fireCentres) > FIRE_TRIGGER_KM;
}

/** The live position snapped to a coarse grid (~0.25°), for use as an area key — belt-and-braces behind containment. Deliberately NOT satImageKey (4-decimal); must never hand a moving point that key. */
export function snapLiveAnchor(pos: LngLat): LngLat {
	const step = 0.25;
	// + 0 normalises -0 → 0 — Math.round(-0.04) is -0, which differs from 0 under Object.is/Map keys, else a coordinate near Greenwich could occupy two cells.
	const snap = (n: number): number => Math.round(n / step) * step + 0;
	return [snap(pos[0]), snap(pos[1])];
}

/** Guard against a satellite-tagged or corrupt fix reaching the bake pass. */
export function isUsableFix(pos: unknown): pos is LngLat {
	if (!Array.isArray(pos) || pos.length !== 2) return false;
	const [lng, lat] = pos as number[];
	return (
		Number.isFinite(lng) &&
		Number.isFinite(lat) &&
		Math.abs(lng) <= 180 &&
		Math.abs(lat) <= 90 &&
		// 0,0 is the Gulf of Guinea — overwhelmingly a zeroed struct, not a real fix; baking there wastes budget on ocean.
		!(lng === 0 && lat === 0)
	);
}
