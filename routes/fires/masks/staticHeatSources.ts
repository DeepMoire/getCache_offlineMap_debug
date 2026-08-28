/**
 * staticHeatSources.ts — "why does Richmond look like it's on fire?"
 *
 * Refineries, mills, gas flares, steel plants and landfill gas register as
 * hotspots every single day. They are the single biggest source of false-alarm
 * complaints in every FIRMS-based product, and they are why a tank farm on the
 * Fraser River kept reading as a wildfire beside Vancouver.
 *
 * ── NASA already solved this; the NRT feed just doesn't carry the answer ──
 * FIRMS defines an inferred hotspot `type`: 0 = presumed vegetation fire,
 * 1 = active volcano, 2 = other static land source, 3 = offshore. A refinery is
 * textbook type 2. But **`type` is only populated in the science-quality
 * monthly products** (MCD14ML / VNP14IMGML), never in the near-real-time feeds
 * we depend on. So we replicate NASA's own rule instead of inventing one.
 *
 * ── The rule: PERSISTENCE ──
 * NASA's type 2 covers "static hotspots repeatedly detected for 16 or more days
 * in any calendar year". We pull a year of the FIRMS archive, grid it to ~375 m
 * cells, and flag any cell seen on `PERSIST_DAYS` or more distinct days. That
 * catches refineries, mills, flares and kilns worldwide without hand-listing a
 * single one — and it stays true as industry changes, because the next rebuild
 * re-derives it.
 *
 * Measured over Vancouver (Apr–Aug 2026): the tank-farm cell was detected on
 * **14 distinct days**, while genuine transient fires in the same bbox showed
 * 1–4. The separation is not subtle.
 *
 * ── ⚠️ Why urban land cover is NOT sufficient on its own ──
 * The obvious cheap rule — "flag anything inside an urban polygon" — was tested
 * first and REJECTED: the Richmond tank farm sits on industrial land just
 * OUTSIDE the mapped urban area, so an urban-only filter misses the exact case
 * this module exists for. Urban cover is kept as a secondary signal, never the
 * primary one.
 *
 * ── ⚠️ FLAG, NEVER DELETE ──
 * A refinery genuinely can catch fire, and slash piles do burn on urban fringes.
 * NASA labels rather than removes; so do we. A flagged detection is dimmed and
 * excluded from the default view, but it is still in the data, still tappable,
 * and its card says plainly what it is. Hard-deleting would mean the app says
 * NOTHING on the day Burnaby's refinery actually goes up — the one day it would
 * matter most.
 *
 * Pure logic; the mask is injected. Loading lives in `staticHeatIndex.ts`.
 */

/** Grid cell size in degrees latitude ≈ 375 m, matching VIIRS's pixel. */
export const CELL_DEG = 0.00375;

/**
 * Distinct detection-days in a year that make a cell "static".
 *
 * NASA uses 16. We use 12: their number is tuned for a global science product
 * where a false positive is a data-quality issue, while ours is tuned for a
 * field tool where a permanent flare mislabelled as a wildfire erodes trust in
 * the whole layer. Lowering it trades a little sensitivity for far fewer false
 * alarms — and because we FLAG rather than delete, a wrongly-flagged cell is
 * still reachable rather than gone.
 */
export const PERSIST_DAYS = 12;

/** Cell key for a coordinate. Integer pair, so it is exact and hashable. */
export function cellKey(lng: number, lat: number): string {
	return `${Math.round(lat / CELL_DEG)},${Math.round(lng / CELL_DEG)}`;
}

/** The mask: the set of persistent-source cell keys. */
export type StaticMask = ReadonlySet<string>;

/**
 * Is this detection on a known permanent heat source?
 *
 * Checks the cell and its 8 neighbours: a fire's pixel wanders by a few hundred
 * metres between passes (viewing angle, swath position), so an exact-cell match
 * alone would let the same flare stack slip through half the time.
 */
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

/**
 * Build a mask from raw archive detections.
 *
 * Exported so the rule is testable and so a future rebuild can run the same
 * code the asset was generated with, rather than a second implementation that
 * drifts from it.
 */
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

/** What the card says for a flagged detection. Plain, not apologetic — this is
 *  a fact about the source, not a hedge about the data. */
export const INDUSTRIAL_LABEL = "Industrial heat source";
