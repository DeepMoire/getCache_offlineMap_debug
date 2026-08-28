/**
 * fireCacheV2 — one disc of wildfire detections on disk, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY V2 EXISTS — read this before touching anything in this folder.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * V1 was measured, on an idle page with nothing moving, at:
 *
 *     ~4,000 MB total JS heap  (the tab eventually crashed)
 *     119% CPU
 *     kmBetween      7,982 ms   30.1% of the main thread
 *     unionHotspots  5,474 ms   20.6%
 *     paintInner                63.6% of TOTAL time
 *
 * Turning the fire layer off — and ONLY the fire layer — took the same page to
 * 963 MB, and the online map to 274 MB. A 15× swing from one subsystem.
 *
 * The cause was never one bad function. It was an ARCHITECTURE in which the
 * phone holds every raw detection and re-derives geometry from them:
 *
 *   • ~36,489 raw detections cached for a single 500 km disc
 *   • a union pass that deduped every detection against every other disc
 *   • a supersede pass that ran a distance test per (detection × newer disc)
 *   • a hull builder that clustered 12,197 cells into 142 outlines
 *   • an urban classifier walking the same pile again
 *   • five separate memo layers bolted on to stop all of that running per-pan
 *
 * ~3,200 lines across 9 modules, to draw dots on a map.
 *
 * ── THE V2 RULE ──
 * **The phone renders. It does not compute geometry.**
 * A disc arrives from the Worker already deduped, already clustered, already
 * outlined, already urban-filtered — render-ready. The phone stores those bytes
 * and hands them to Mapbox. There is no union, no hull, no distance loop, and
 * therefore nothing to memoize. This is the `server-is-hot-phone-is-cold`
 * memory applied to the one subsystem that broke it hardest.
 *
 * What that buys, structurally: the expensive passes cannot come back, because
 * the data the phone holds is no longer the shape you could run them on.
 *
 * ── WHAT V2 KEEPS FROM V1, DELIBERATELY ──
 * Every one of these was learned from a field failure. They are not carried
 * over out of caution; each is load-bearing.
 *
 *   • `fetchedAt` on every record, and an age shown in words. Painting stale
 *     dots as live is the one genuinely dangerous failure this layer has.
 *   • A version stamp that invalidates on CONTENT, not just shape — a TTL
 *     expires stale data, never data that was WRONG when written.
 *   • Never clear on failure. Stale dots with an honest age beat an empty map
 *     that reads as "no fires near you".
 *   • A phone TTL well UNDER the edge cache's (20 min vs ~1 h). Two caches in a
 *     row compound rather than overlap; the edge cache is what protects NASA,
 *     not this one.
 *
 * Its own IndexedDB DB, sandbox-aware, via the shared keyedIdbStore.
 */

import { makeKeyedIdbStore } from "../../../lib/onPhone/store/keyedIdbStore";

/**
 * Bump when the stored shape changes OR when the DATA was wrong.
 *
 * v1 of the V2 format. Distinct DB from the v1 system (`rt-fire-cache`), so
 * both can coexist during the cutover and neither reads the other's records.
 */
export const FIRE_V2_VERSION = 1;

/**
 * Disc radius requested per area — the smoke shed, not just the block.
 *
 * ⚠️ STAYS AT 500. This was briefly cut to 300 in v1 to stop the layer
 * dominating the map; that failed, as did shrinking the circles and filtering
 * to the screen box. All three treated a rendering symptom by throwing away
 * DOWNLOADED INFORMATION. 500 km is the smoke shed and costs ~180 KB gzipped.
 * If the layer looks too busy, that is a RENDER rule (zoom gates), never a
 * reason to know less about a fire upwind of a block.
 */
export const FIRE_V2_RADIUS_KM = 500;

/**
 * How long the phone keeps its own copy before asking the Worker again.
 *
 * ⚠️ 20 MINUTES, NOT AN HOUR. v1 used an hour — matching the Worker's edge
 * cache — and produced the field report **"Last checked — 5h ago" with the app
 * sitting open**. Two one-hour caches do not overlap, they COMPOUND: the phone
 * can receive a copy that is already 59 minutes old and hold it another hour.
 * Staying well under the edge TTL is what stops that compounding.
 *
 * ── Why 20 minutes is safe, and what it actually governs ──
 * The TTL is NOT the mechanism that keeps a field phone current. `fireArrival`
 * is. It arms a bypass debt at the three ARRIVAL moments — app open, the app
 * becoming visible again, and connectivity returning — and those are precisely
 * the moments when staleness matters: someone drives back into service and
 * opens the app to find out whether the fire has moved. An arrival bypasses the
 * TTL outright, so no arrival is ever answered from a 19-minute-old copy.
 *
 * That leaves the TTL governing exactly ONE scenario: the app held continuously
 * in the foreground, never backgrounded, never losing signal, for 20+ minutes.
 * FIRMS itself refreshes roughly hourly, so a 20-minute ceiling on that case is
 * comfortably inside the upstream cadence — nothing new is being missed.
 *
 * The cost side is what changed: with conditional GETs (`If-None-Match`, see
 * `fireFetchV2`) a re-ask inside the edge window is a bodiless 304 rather than
 * ~180 KB. Raising 5 → 20 cuts the redundant round trips by 4× on top of that.
 *
 * ⚠️ Do NOT read `fireArrival` as a permanent override. Its debt is per-READER
 * (`bake` and `map` refresh different ground and cannot discharge each other's
 * debt), it is PEEKED at the gate and only settled once a fetch has actually
 * been attempted, and it is cleared on consumption. A pass that never runs
 * leaves nothing armed. Do not modify `fireArrival` to prop this TTL up.
 */
export const FIRE_V2_TTL_MS = 20 * 60 * 1000;

/** VIIRS confidence, categorical — mirrors the Worker's enum. */
export type FireConfidenceV2 = "low" | "nominal" | "high";

/**
 * ONE RENDER-READY DISC.
 *
 * The three GeoJSON members are handed to `setData()` untouched. They are
 * stored as SERIALIZED STRINGS, not objects, and that is deliberate on three
 * counts:
 *
 *   1. A string is one heap object regardless of how many features it encodes.
 *      v1 held ~36,489 live JS objects per disc, each with its own coordinate
 *      array — the shape that made every pass over them expensive.
 *   2. `JSON.parse` at paint time produces a plain object with no `$state`
 *      proxies, which is exactly what the GL worker boundary requires
 *      (mapbox-boundary law: proxies corrupt the transfer and features silently
 *      vanish). v1 needed a defensive `JSON.parse(JSON.stringify(...))` clone
 *      on every paint; here the stored form is already safe.
 *   3. IndexedDB stores it without structured-cloning a deep object graph.
 *
 * The phone never inspects what is inside these strings. If it ever needs to,
 * that is the Worker's job — add a field, do not add a parser.
 */
export interface FireDiscV2 {
	readonly version: number;
	/** Server's fetch time. The edge may serve a cached slice, so our own clock
	 *  would overstate freshness by up to the cache TTL. */
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
	/** How many detections the Worker put in `pointsJson`. Stored so the UI can
	 *  say "0 fires here" WITHOUT parsing the payload — the one number the phone
	 *  legitimately needs about the contents. */
	readonly pointCount: number;
	/**
	 * The Worker's `ETag` for the body in `pointsJson`/`clustersJson`/
	 * `outlinesJson`, when it sent one. Replayed as `If-None-Match` on the next
	 * fetch so an unchanged disc costs a bodiless 304 instead of ~180 KB.
	 *
	 * OPTIONAL, and deliberately NOT a reason to bump `FIRE_V2_VERSION`: records
	 * written before this field existed simply lack it, so their first fetch
	 * after upgrade is an ordinary 200 that fills it in. Absent means "ask
	 * unconditionally", never "invalid".
	 */
	readonly etag?: string;
}

const idb = makeKeyedIdbStore<FireDiscV2>({
	dbName: "rt-fire-v2",
	storeName: "discs",
});

/** A stable key for a disc centre. Same ~11 m rounding the rest of the offline
 *  system uses, so a moving user does not mint a new disc every few paces. */
export function fireDiscKey(center: readonly [number, number]): string {
	return `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
}

/**
 * This disc, or null if absent / written by an older format.
 *
 * Deliberately returns STALE records. Freshness is the caller's decision
 * (`isFreshV2`), because the viewer wants whatever exists — however old — while
 * a refresh is in flight. Returning null for "stale" would blank the map at
 * exactly the moment a planter is checking it.
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
 * THE LIGHT INDEX — every stored disc's centre, radius and age. Never payloads.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⛔ THIS IS THE ONLY WHOLE-STORE READ IN V2, AND IT MUST STAY LIGHT.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every question the app asks ACROSS discs is geographic or temporal:
 *   "is this view covered?"  "is that disc stale?"  "which should I evict?"
 * None of them needs a single detection.
 *
 * v1 answered exactly these questions by loading full records, and a DevTools
 * allocation profile put that read at **616 MB — 90.4% of the entire profile**,
 * with the browser reporting a `'success' handler took 600–1140 ms`. The fix
 * there was `getAllProjected`; here the projection is the ONLY way in, so the
 * expensive read has no door to come back through.
 *
 * `getAllProjected` cursor-streams: each record is deserialized, reduced to
 * these four scalars, and immediately collectable. Peak heap is one disc, not
 * all of them. See `scripts/check-blob-getall.mjs` for the guard that stops a
 * future caller reaching for `getAll()` instead.
 */
export interface FireDiscMetaV2 {
	readonly key: string;
	readonly center: readonly [number, number];
	readonly radiusKm: number;
	readonly fetchedAt: number;
	readonly pointCount: number;
}

/** Memoized because the index is tiny (tens of entries) and read on every
 *  coverage check. Invalidated by every write and delete, so a freshly-baked
 *  disc is visible to the very next question. */
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
 * Age in plain English. SAFETY COPY, not a debug string — this is what a
 * planter reads before deciding whether to trust the dots.
 *
 * Never reports a negative age: a phone whose clock has drifted behind the
 * server's would otherwise render "in 3 minutes", which reads as nonsense at
 * the exact moment the number matters.
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
