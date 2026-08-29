/**
 * fireCacheV2 — one disc of wildfire detections on disk, and nothing else.
 *
 * RULE: the phone renders — it does not compute geometry (no union, no hull, no distance loop, nothing to memoize).
 *
 * Kept from v1, deliberately — each load-bearing, each learned from a field failure:
 *   • fetchedAt on every record — painting stale dots as live is the one genuinely dangerous failure this layer has.
 *   • Version stamp invalidates on CONTENT, not just shape — a TTL expires stale data, never data that was WRONG when written.
 *   • Never clear on failure — stale dots with an honest age beat an empty map reading as "no fires near you".
 *   • Phone TTL stays well UNDER the edge cache's (20 min vs ~1h) — two caches in a row compound rather than overlap.
 *
 * Its own IndexedDB DB, sandbox-aware, via the shared keyedIdbStore.
 */

import { makeKeyedIdbStore } from "../../../lib/onPhone/store/keyedIdbStore";

/** Bump when the stored shape changes OR when the DATA was wrong. Distinct DB from v1 (`rt-fire-cache`) — both coexist during cutover; neither reads the other's records. */
export const FIRE_V2_VERSION = 1;

/** Disc radius requested per area — the smoke shed, not just the block. ⚠️ STAYS AT 500 — cutting it (or shrinking circles / filtering to the screen box, both tried in v1) treats a RENDER symptom by throwing away downloaded information; use zoom gates instead. */
export const FIRE_V2_RADIUS_KM = 500;

/**
 * How long the phone keeps its own copy before asking the Worker again.
 *
 * ⚠️ 20 MINUTES, NOT AN HOUR — two one-hour caches don't overlap, they COMPOUND (v1: "Last checked — 5h ago" with the app open); staying well under the edge TTL stops that.
 *
 * ⚠️ Do NOT read `fireArrival` as a permanent override — its debt is per-READER (bake/map can't discharge each other's), peeked at the gate, settled only after a fetch attempt, cleared on consumption; do not modify `fireArrival` to prop this TTL up.
 */
export const FIRE_V2_TTL_MS = 20 * 60 * 1000;

/** VIIRS confidence, categorical — mirrors the Worker's enum. */
export type FireConfidenceV2 = "low" | "nominal" | "high";

/**
 * ONE RENDER-READY DISC.
 *
 * Stored as SERIALIZED STRINGS, not objects — parsed objects carry no `$state` proxies, and proxies crossing the mapbox-boundary corrupt the transfer with features silently vanishing (mapbox-boundary law).
 *
 * The phone never inspects what's inside these strings — if it needs to, that's the Worker's job: add a field, do not add a parser.
 */
export interface FireDiscV2 {
	readonly version: number;
	/** Server's fetch time — our own clock would overstate freshness by up to the cache TTL if used instead. */
	readonly fetchedAt: number;
	/** Disc centre this was fetched for, [lng, lat]. */
	readonly center: readonly [number, number];
	readonly radiusKm: number;
	/** How many of the three satellites reported. < 3 = degraded coverage. */
	readonly sourcesOk: number;
	/** Render-ready point features — deduped and urban-filtered by the Worker. */
	readonly pointsJson: string;
	/** Render-ready cluster features, pre-aggregated per zoom bucket. */
	readonly clustersJson: string;
	/** Render-ready outline polygons. Empty FeatureCollection if none. */
	readonly outlinesJson: string;
	/** How many detections the Worker put in `pointsJson` — lets the UI say "0 fires here" without parsing the payload. */
	readonly pointCount: number;
	/**
	 * The Worker's `ETag` for pointsJson/clustersJson/outlinesJson, replayed as `If-None-Match` so an unchanged disc costs a bodiless 304 instead of ~180 KB.
	 *
	 * OPTIONAL — deliberately NOT a reason to bump `FIRE_V2_VERSION`; absent means "ask unconditionally", never "invalid".
	 */
	readonly etag?: string;
}

const idb = makeKeyedIdbStore<FireDiscV2>({
	dbName: "rt-fire-v2",
	storeName: "discs",
});

/** A stable key for a disc centre — same ~11 m rounding the rest of the offline system uses, so a moving user does not mint a new disc every few paces. */
export function fireDiscKey(center: readonly [number, number]): string {
	return `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
}

/**
 * This disc, or null if absent / written by an older format.
 *
 * Deliberately returns STALE records — freshness is the caller's call (`isFreshV2`); returning null for "stale" would blank the map exactly when a planter checks it.
 */
export async function readFireDisc(key: string): Promise<FireDiscV2 | null> {
	const rec = await idb.get(key);
	return rec && rec.version === FIRE_V2_VERSION ? rec : null;
}

export async function writeFireDisc(
	key: string,
	disc: FireDiscV2,
): Promise<void> {
	await idb.put(key, disc);
	invalidateDiscIndex();
}

export async function deleteFireDisc(key: string): Promise<void> {
	await idb.delete(key);
	invalidateDiscIndex();
}

/**
 * THE LIGHT INDEX — every stored disc's centre, radius, age; never payloads.
 *
 * ⛔ THE ONLY WHOLE-STORE READ IN V2 — MUST STAY LIGHT.
 *
 * `getAllProjected` cursor-streams — each record is deserialized, reduced to four scalars, and immediately collectable; peak heap is one disc, not all of them.
 *
 * A guard in `scripts/check-blob-getall.mjs` stops a future caller reaching for `getAll()` instead.
 */
export interface FireDiscMetaV2 {
	readonly key: string;
	readonly center: readonly [number, number];
	readonly radiusKm: number;
	readonly fetchedAt: number;
	readonly pointCount: number;
}

/** Memoized — the index is tiny (tens of entries) and read on every coverage check; invalidated by every write/delete so a freshly-baked disc is visible next question. */
let indexMemo: FireDiscMetaV2[] | null = null;

export function invalidateDiscIndex(): void {
	indexMemo = null;
}

export async function fireDiscIndex(): Promise<FireDiscMetaV2[]> {
	if (indexMemo !== null) return indexMemo;
	const [keys, metas] = await Promise.all([
		idb.keys(),
		idb.getAllProjected((d) =>
			d?.version === FIRE_V2_VERSION
				? {
						center: d.center,
						radiusKm: d.radiusKm,
						fetchedAt: d.fetchedAt,
						pointCount: d.pointCount,
					}
				: null,
		),
	]);
	// `keys()` and the cursor walk the same store in the same key order.
	const out: FireDiscMetaV2[] = [];
	for (let i = 0; i < keys.length; i++) {
		const m = metas[i];
		if (m) out.push({ key: keys[i], ...m });
	}
	indexMemo = out;
	return out;
}

/** Inside the TTL? */
export function isFreshV2(
	disc: { fetchedAt: number },
	now = Date.now(),
): boolean {
	return now - disc.fetchedAt < FIRE_V2_TTL_MS;
}

/**
 * Age in plain English. SAFETY COPY, not a debug string — what a planter reads before trusting the dots.
 *
 * Never reports a negative age — clock drift would otherwise render "in 3 minutes", reading as nonsense exactly when it matters.
 */
export function fireAgeLabelV2(
	fetchedAt: number | null,
	now = Date.now(),
): string {
	if (fetchedAt === null) return "no fire data";
	const mins = Math.max(0, Math.round((now - fetchedAt) / 60_000));
	if (mins < 2) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}
