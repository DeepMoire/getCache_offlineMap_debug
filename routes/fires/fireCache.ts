/**
 * v4FireCache — wildfire hotspots on disk, so the layer survives losing signal.
 *
 * Fetch-on-map-open is exactly the moment this feature would fail: the planter
 * is AT the block, which is where there is no signal. So hotspots ride the same
 * rails as the wall map — downloaded ahead of time by the bake service around
 * the same feature anchors, stored in their own IndexedDB box, read back on
 * route entry whether or not there's a network.
 *
 * ── How this differs from every other offline box, and why ──
 * Tiles and satellite photos are effectively IMMUTABLE: a road doesn't move, so
 * a cached tile is as good as a fresh one forever. Hotspots are the opposite —
 * a 3-day-old detection says nothing about what's burning now. Two consequences,
 * both load-bearing:
 *
 *   1. Every record carries `fetchedAt`, and the UI MUST show its age. Silently
 *      painting stale dots as if they were live is the one genuinely dangerous
 *      failure this layer has.
 *   2. Records are refreshed on a TTL, not just when missing — unlike
 *      `areaTilesPresent`, "we already have it" is not sufficient here.
 *
 * What we do NOT do is hide the layer once it's stale. Law 1 is constant
 * presence, and in the field a day-old fire you can see beats a blank screen.
 * Age is communicated, never used as an excuse to show nothing.
 *
 * Its own IndexedDB DB (big local-only payload — never TinyBase; see
 * big-map-storage-split), sandbox-aware via keyedIdbStore.
 */

import { kmBetween } from "../../lib/shared/kmGeo";
import { makeKeyedIdbStore } from "../../lib/onPhone/store/keyedIdbStore";

/**
 * Bump when the stored shape changes — a stale-format record reads as absent
 * and one bake pass replaces it.
 *
 * ⚠️ ALSO BUMP WHEN THE DATA ITSELF WAS WRONG, not just its shape. That is what
 * v2 is: v1 records were fetched while the Worker asked FIRMS for `DAY_RANGE=1`,
 * which means "today UTC" rather than "the last 24 h", so every disc pulled
 * after UTC midnight cached a legitimately-formatted, completely EMPTY answer.
 * Those records then sat inside the 1 h TTL refusing to refetch, and the viewer
 * faithfully reported "0 hotspots from 29 area(s)" over a burning province.
 *
 * A TTL only protects against data going STALE. It does nothing about data that
 * was WRONG when written — the record looks perfectly fresh. The version is the
 * only lever that invalidates on content rather than on age, and it costs one
 * bake pass to heal every device. Bump it whenever a fix changes what a correct
 * response looks like.
 *
 * v3: adds the optional `px` (pixel footprint km) and `dn` (day/night) fields
 * that feed the hotspot tap card. v2 records are perfectly valid but simply
 * lack the new keys, so without a bump the card would silently fall back to its
 * defaults forever on any device that had already cached a disc. Same rule as
 * v2 — a TTL expires STALE data, never INCOMPLETE data.
 */
export const FIRE_CACHE_VERSION = 3;

/**
 * Disc radius requested per area — the smoke shed, not just the block.
 *
 * MUST match what the /fires route treats as its default, or the presence probe
 * and the fetch disagree about what "covered" means.
 *
 * ⚠️ STAYS AT 500, and it is now also the RENDER wall (fireRelevance.ts
 * HARD_CUTOFF_KM) — we draw exactly what we download, nothing further.
 *
 * This was briefly cut to 300 to stop the layer dominating the map. That failed,
 * as did shrinking the cluster circles, and as did filtering to the screen box
 * (at continental zoom the screen IS the continent). All three treated the
 * symptom. The real cause was that NOTHING in the render path measured distance
 * from the USER — this number was only ever a download bbox handed to NASA, and
 * discs were fetched around the CAMERA, so every pan minted another one.
 *
 * 500 km is the smoke shed, costs ~180 KB gzipped, and cutting it would throw
 * away genuine information about a fire upwind of a block. Don't shrink it to
 * fix a rendering problem — the rendering rule lives in fireRelevance.ts.
 */
export { FIRE_RADIUS_KM } from "../../lib/shared/fireContract";

/**
 * How long the PHONE keeps its own copy before asking the Worker again.
 *
 * ⚠️ This was 1 HOUR — the same as the Worker's edge cache — on the reasoning
 * that a shorter TTL just re-fetches the same bytes. That reasoning was wrong,
 * and it produced the field report: **`Last checked — 5h ago` with the app
 * sitting open.** Measured on a real device, every cached disc was 6+ hours old
 * and none had refreshed.
 *
 * Two caches in a row do NOT add up to the longer of the two — they COMPOUND.
 * The phone's hour and the edge's hour can be offset, so the phone can hold a
 * copy that was already 59 minutes old when it arrived, and keep it for another
 * hour: two hours of drift from two one-hour caches. Add a phone that never
 * re-asks (the arrival flag is consumed by whichever `ensure()` runs first, and
 * there are three call sites racing for it) and the drift is unbounded.
 *
 * **The edge cache is what protects NASA — not this one.** A phone re-asking
 * every 5 minutes costs the Worker a cache HIT, not a NASA call, so the only
 * cost is a few KB gzipped. Making the phone eager and letting Cloudflare do
 * the rate-limiting is the whole point of having the Worker in the middle.
 *
 * So: 5 minutes. Online, `Last checked` can now only ever read 0–65 min
 * (5 min of phone + up to 60 of edge), and anything larger means the user was
 * genuinely offline — which is exactly when that number earns its keep.
 */
export const FIRE_TTL_MS = 5 * 60 * 1000;

// `FIRE_STALE_MS` (24 h) lived here and is DELETED, not commented out: it fed a
// staleness stamp that no longer exists. Age is now reported in words on the tap
// card (`First detected` / `Last updated`), and the only thing that removes a
// detection is positive evidence it is out — a newer fetch that covered its
// ground and did not list it (see `unionHotspots`). A bare "older than 24 h"
// threshold has no right value and nothing left to drive.

/** VIIRS confidence, categorical (l/n/h) — mirrors the Worker's enum. */
export type { FireConfidence } from "../../lib/shared/fireContract";

export type { FireHotspot } from "../../lib/shared/fireContract";
import type { FireHotspot } from "../../lib/shared/fireContract";

export interface FireCacheEntry {
	cacheVersion: number;
	/** When WE fetched it — drives the "as of Xh ago" stamp. Distinct from each
	 *  hotspot's own `t` (when the SATELLITE saw it); both matter. */
	fetchedAt: number;
	/** Area centre this was fetched for, [lng, lat]. */
	center: [number, number];
	radiusKm: number;
	/** How many of the three satellites reported. < 3 = degraded coverage. */
	sourcesOk: number;
	hotspots: FireHotspot[];
}

const idb = makeKeyedIdbStore<FireCacheEntry>({
	dbName: "rt-fire-cache",
	storeName: "fires",
});

/**
 * This area's hotspots, or null if absent / written by an older format.
 *
 * Deliberately returns stale records: freshness is the CALLER's decision
 * (`isFresh`), because the viewer wants whatever exists — however old — while
 * the bake service wants to know whether to re-fetch. One store, two questions.
 */
export async function readFireCache(
	key: string,
): Promise<FireCacheEntry | null> {
	const e = await idb.get(key);
	if (!e) return null;
	if (e.cacheVersion !== FIRE_CACHE_VERSION) return null;
	return e;
}

export async function writeFireCache(
	key: string,
	entry: Omit<FireCacheEntry, "cacheVersion">,
): Promise<void> {
	await idb.put(key, { ...entry, cacheVersion: FIRE_CACHE_VERSION });
	invalidateFireEntries();
}

/** Drop one area's hotspots — called by the bake service's eviction pass so a
 *  pruned area sheds ALL its data together (photo + tiles + fires). */
export async function deleteFireCache(key: string): Promise<void> {
	await idb.delete(key);
	invalidateFireEntries();
}

/** What `unionHotspots` returns — named so the memo can hold it. */
export interface UnionResult {
	hotspots: FireHotspot[];
	oldestFetchedAt: number | null;
	degraded: boolean;
}

/**
 * ── The per-pan memo ──
 *
 * `allFireEntries()` reads EVERY cached disc out of IndexedDB and
 * `unionHotspots()` dedupes them into one list. Measured on a real device cache:
 * **24 ms to read 73,225 hotspots + 25 ms to union them = ~49 ms**, and the
 * fire layer re-ran both on every `moveend`.
 *
 * That work produced a byte-identical answer every time. Panning the camera
 * cannot add, remove or change a cached hotspot — only `writeFireCache` and
 * `deleteFireCache` can, and both invalidate here. So the pan path is pure
 * re-derivation of a value that did not change, which is the definition of
 * waste.
 *
 * Same shape as the fix in `fireClassifyCache.ts`, for the same reason: what the
 * cache holds is a property of the DATA, not of the frame. Compute on write,
 * reuse on read.
 *
 * ⚠️ THIS MEMO IS ABOUT CPU TIME, NOT MEMORY — do not delete it on memory
 * grounds. A later audit measured the whole fire dataset at **0.02% of total
 * allocation**, which refuted an earlier (wrong) diagnosis that fires-as-a-
 * dataset were a heap problem. That finding says nothing about the ~49 ms of
 * blocked main thread this memo removes from every pan, which is the only thing
 * it was ever added for. The real heap wins were elsewhere: `getAll()` loading
 * Blobs (see `keyedIdbStore.getAllProjected`) and the world-scale gazetteer /
 * urban assets (see `assetRegion.ts`).
 */
let entriesMemo: FireCacheEntry[] | null = null;
let unionMemo: UnionResult | null = null;
/** The exact array `unionMemo` was computed from — see the identity check in
 *  `unionHotspots`. Two memo'd reads exist, holding different discs. */
let unionMemoSrc: readonly FireCacheEntry[] | null = null;
/** The origin-filtered read's memo + the origin set it was built for. Separate
 *  from `entriesMemo` because it answers a narrower question ("discs that could
 *  render from HERE"); both are cleared together by `invalidateFireEntries`. */
let nearMemo: FireCacheEntry[] | null = null;
let nearMemoKey = "";
/** Declared here beside its siblings, not next to `fireCoverage` below, so all
 *  three memos this module invalidates together are visible in one place. */
let coverageMemo: FireCoverage[] | null = null;

/** Drop the memo. Exported so a test — or any future writer that bypasses the
 *  two functions above — can force the next read to hit disk. */
export function invalidateFireEntries(): void {
	entriesMemo = null;
	unionMemo = null;
	coverageMemo = null;
	nearMemo = null;
	nearMemoKey = "";
	unionMemoSrc = null;
}

/** Every cached area's hotspots. The viewer unions these into one layer rather
 *  than picking a single area — a planter near two anchors should see both
 *  discs' fires, not whichever happens to be nearest.
 *
 *  Memoized — see the note above. Invalidated by every write and delete, so a
 *  freshly-baked disc still appears on the very next paint. */
export async function allFireEntries(): Promise<FireCacheEntry[]> {
	if (entriesMemo !== null) return entriesMemo;
	// CURSOR, never `getAll()`. `getAll()` deserializes every disc's hotspot array
	// into one main-thread task, and on a real device cache that measured
	// **616 MB — 90.4% of the entire allocation profile** (DevTools allocation
	// sampling, 2026-08-10), plus a 7,498 ms blocked 'success' handler. Same store,
	// same file: `fireCoverage()` below already learned this and costs 17 kB.
	//
	// The cursor cannot make the RESULT smaller — every surviving disc is still
	// held — but it stops all of them existing in a second throwaway array at the
	// same time, and it splits the deserialization across many small tasks instead
	// of one uninterruptible one. That is the difference between a map that hitches
	// and a tab that OOM-crashes.
	entriesMemo = (
		await idb.getAllProjected((e) =>
			e?.cacheVersion === FIRE_CACHE_VERSION ? e : null,
		)
	).filter((e): e is FireCacheEntry => e !== null);
	return entriesMemo;
}

/**
 * Discs that could possibly RENDER, given where the user actually is.
 *
 * ── Why this exists ──
 * `allFireEntries()` holds every cached disc's hotspots in the memo, forever.
 * But `fireRelevance.HARD_CUTOFF_KM` is an absolute promise: nothing further than
 * 500 km from an anchor is ever drawn, at any size. So a disc whose entire area
 * lies beyond that wall contributes zero pixels and pure heap — it is retained
 * only to be discarded downstream on every paint.
 *
 * A planter's cache accumulates discs along everywhere they have worked; the
 * ones that matter are the handful around them now. Filtering at the READ is the
 * only place it saves anything, because past that point the array already exists.
 *
 * `maxKm` is the wall plus the disc's own radius: a disc CENTRED 900 km away can
 * still hold a hotspot 400 km from its centre that lands inside the wall, so the
 * test must be "could any part of this disc be in range", never "is its centre".
 * Getting that backwards silently hides real fires at the edge.
 *
 * ⚠️ THE CENTRE-VS-REACH RULE ABOVE IS A CORRECTNESS CONSTRAINT, not an
 * optimisation note. Narrowing this test to the disc's centre would make the
 * layer stop drawing fires it has already downloaded — silently, and worst at
 * the edge of the wall, which is exactly where the user is least able to notice.
 * The heap saving is the lesser reason this function exists; keep it whichever
 * way the memory numbers move.
 */
export function discCouldRender(
	disc: { center: [number, number]; radiusKm: number },
	origins: readonly (readonly [number, number])[],
	maxKm: number,
): boolean {
	const reach = maxKm + disc.radiusKm;
	for (const o of origins) {
		if (kmBetween([o[0], o[1]], disc.center) <= reach) return true;
	}
	return false;
}

export async function fireEntriesNear(
	origins: readonly (readonly [number, number])[],
	maxKm = 0,
): Promise<FireCacheEntry[]> {
	if (origins.length === 0) return allFireEntries();
	// ⚠️ MEMOIZED ON THE SELECTED DISCS, **NEVER ON THE ORIGINS**.
	//
	// This distinction is load-bearing and cost a measured 7,270 ms — 44.5% of the
	// main thread — when it was got wrong. Origins include the map-centre fallback,
	// so they change on EVERY PAN. Keying on them minted a new array each pan, and
	// everything downstream memoizes on the IDENTITY of this array:
	//   `unionHotspots` → its `hotspots` array → `fireOutlines`' memo key.
	// A new array at the bottom therefore invalidated the whole chain and dragged
	// the ~52 ms hull rebuild back onto every pan gesture — the exact cost those
	// memos were built to remove.
	//
	// Panning a few metres does not change WHICH discs are in range. So: do the
	// cheap coverage scan first, build the key from the disc set it selects, and
	// return the SAME ARRAY OBJECT whenever that set is unchanged. Reference
	// stability is the contract; see the note at the `outlineSrc` write in
	// fireLayer.ts before touching this.
	const cov = await fireCoverage();
	const selected = cov
		.filter((c) => discCouldRender(c, origins, maxKm))
		.map((c) => `${c.center[0].toFixed(4)},${c.center[1].toFixed(4)}`)
		.sort();
	const key = `${maxKm}|${selected.join(";")}`;
	if (nearMemo !== null && nearMemoKey === key) return nearMemo;
	const want = new Set(selected);
	const rows = (
		await idb.getAllProjected((e) =>
			e?.cacheVersion === FIRE_CACHE_VERSION &&
			want.has(`${e.center[0].toFixed(4)},${e.center[1].toFixed(4)}`)
				? e
				: null,
		)
	).filter((e): e is FireCacheEntry => e !== null);
	nearMemo = rows;
	nearMemoKey = key;
	return rows;
}

/**
 * One disc's COVERAGE ONLY — where and when, with no hotspots attached.
 *
 * ── Why this exists ──
 * Two of the three `allFireEntries()` callers ask a purely geographic question:
 * "is this view already covered by a fresh disc?" (the map layer's fetch gate,
 * and the bake service's containment gate). Neither one reads a single hotspot.
 * But `allFireEntries()` hands back the FULL records, so asking that question
 * forced tens of thousands of hotspot objects to stay reachable — and because
 * the answer was memoized, permanently resident.
 *
 * Measured cache: 73,225 hotspots across the discs. Holding them to answer a
 * question about circle centres is the memory equivalent of the per-pan
 * recompute the memo above already killed — same disease, different axis.
 *
 * The coverage list is tens of entries at most (one per cached area, capped by
 * the bake service's area budget), so this memo is small enough to hold forever
 * without apology, unlike the one it replaces.
 */
export interface FireCoverage {
	readonly center: [number, number];
	readonly radiusKm: number;
	readonly fetchedAt: number;
}

/**
 * Where and when each cached disc was fetched — WITHOUT its hotspots.
 *
 * Use this for every coverage / freshness / containment question. Reach for
 * `allFireEntries()` only when you genuinely need the detections themselves,
 * which in practice means painting.
 */
export async function fireCoverage(): Promise<FireCoverage[]> {
	if (coverageMemo !== null) return coverageMemo;
	// PROJECTED, never `getAll()`. Holding fewer hotspots was only half the fix:
	// `getAll()` still READ every one off disk, deserializing 73,225 detections in
	// a single main-thread task to answer a question about circle centres. The
	// browser named it outright — `'success' handler took 600–1140 ms`. The
	// cursor projection drops each record the moment its centre is copied.
	const rows = await idb.getAllProjected((e) =>
		e?.cacheVersion === FIRE_CACHE_VERSION
			? {
					center: e.center,
					radiusKm: e.radiusKm,
					fetchedAt: e.fetchedAt,
				}
			: null,
	);
	coverageMemo = rows.filter((r): r is FireCoverage => r !== null);
	return coverageMemo;
}

/** True when this coverage record is inside its TTL. Mirrors `isFresh`, but
 *  takes the light shape so a caller need not hold a full entry to ask. */
export function isCoverageFresh(
	c: FireCoverage,
	now: number = Date.now(),
): boolean {
	return now - c.fetchedAt < FIRE_TTL_MS;
}

/** True when this record is inside its TTL (i.e. no re-fetch needed). */
export function isFresh(
	entry: FireCacheEntry,
	now: number = Date.now(),
): boolean {
	return now - entry.fetchedAt < FIRE_TTL_MS;
}

/**
 * ⛔ SUPERSEDED GROUND — why a fire cannot linger for 23 hours.
 *
 * ── The bug, in one sentence ──
 * We downloaded fire data yesterday, downloaded fresh data today, and then drew
 * BOTH PILES MIXED TOGETHER — so yesterday's fires stayed on the map even
 * though today's data says they are out.
 *
 * ── Why the old pile survived ──
 * The dedupe key is `position + HOUR`, so the same ground seen at 06:00
 * yesterday and 06:00 today are DIFFERENT keys and both are kept. That is
 * correct for merging overlapping discs fetched at the same time; it is
 * catastrophic across discs fetched a day apart. Meanwhile `needsFireDisc`
 * geographic containment means the stale disc is never re-fetched (a fresh
 * neighbour "covers" it), so nothing ever replaced or removed its rows.
 *
 * Measured on a real device: a disc fetched 23.5 h ago sat beside one fetched
 * minutes ago, both covering Harrison Hot Springs. The card read
 * `Last detected — 23h ago` for a fire the newest data does not contain.
 *
 * ── The rule ──
 * **If a NEWER fetch covered this ground and did not report a fire there, the
 * fire is out.** A satellite that has looked since and seen nothing is
 * evidence, and continuing to draw the old sighting is the map lying — the
 * failure mode the whole layer exists to prevent, pointed the other way.
 *
 * So each hotspot must survive a horizon test: any detection older than the
 * newest fetch COVERING ITS LOCATION is dropped. This is evidence-based rather
 * than a hardcoded "older than N hours" — no arbitrary threshold to get wrong,
 * and ground nobody has re-checked keeps its last known fire (Law 1: constant
 * presence — we only discard when we have newer evidence about THAT SPOT).
 */
const SUPERSEDE_SLACK_MS = 30 * 60 * 1000;

/** Is this coordinate inside the disc `e` covered when it was fetched? */
function coveredBy(e: FireCacheEntry, lng: number, lat: number): boolean {
	return kmBetween([lng, lat], e.center) <= e.radiusKm;
}

/**
 * Union every cached area into ONE deduplicated hotspot list for rendering,
 * plus the OLDEST contributing fetch time.
 *
 * Oldest, not newest, on purpose: the stamp must describe the weakest data on
 * screen. Reporting the freshest area's time would let one recently-refreshed
 * disc vouch for a stale one sitting right beside it.
 */
export function unionHotspots(entries: readonly FireCacheEntry[]): UnionResult {
	if (entries.length === 0) {
		return { hotspots: [], oldestFetchedAt: null, degraded: false };
	}
	// Memoized on the SAME array identity the memo above hands out, so a pan —
	// which re-reads nothing — skips the 25 ms dedupe entirely. A caller passing
	// its own array (a test, a subset) computes normally and never poisons it.
	// Keyed on the EXACT array the union was built from, because there are now two
	// memo'd reads (the full one and the origin-filtered one) and they hold
	// DIFFERENT discs. Memoizing on "is this one of them" would let a full read be
	// served a union computed from the near subset — silently dropping fires. A
	// caller passing its own array (a test, a subset) computes normally.
	if (unionMemo !== null && entries === unionMemoSrc) return unionMemo;
	// Overlapping discs re-report the same fire. Key on rounded position + hour,
	// matching the Worker's dedupe so one fire stays one dot across areas.
	// PRECOMPUTED, never per-hotspot: only discs fetched AFTER this one can
	// supersede it, and there are tens of discs against tens of thousands of
	// hotspots. Doing the covering test inside the hotspot loop would be O(n²)
	// and reintroduce the per-pan hitch the memo above exists to prevent.
	const newerThan = entries.map((e) =>
		entries.filter((o) => o.fetchedAt > e.fetchedAt),
	);
	const best = new Map<string, FireHotspot>();
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const newer = newerThan[i];
		for (const h of e.hotspots) {
			// SUPERSEDED? Find the newest LATER fetch that covered THIS spot. If it
			// happened after this detection (plus slack for NASA's own processing
			// lag, so a fire detected shortly before a fetch that could not yet
			// include it is never wrongly erased), the satellite has looked since
			// and this sighting did not survive into that data.
			let newestCover = 0;
			for (const other of newer) {
				if (
					other.fetchedAt > newestCover &&
					coveredBy(other, h.coordinates[0], h.coordinates[1])
				) {
					newestCover = other.fetchedAt;
				}
			}
			if (newestCover - SUPERSEDE_SLACK_MS > h.t) {
				continue; // out — newer data covers this ground and doesn't list it
			}
			const key = [
				h.coordinates[0].toFixed(3),
				h.coordinates[1].toFixed(3),
				Math.floor(h.t / 3_600_000),
			].join("|");
			const prev = best.get(key);
			if (prev === undefined || h.frp > prev.frp) best.set(key, h);
		}
	}
	const result: UnionResult = {
		hotspots: [...best.values()],
		// codestyle-allow-spread: one entry per cached fire AREA (tens at most, capped
		// by the bake service's area budget) — never near the argument-count limit.
		oldestFetchedAt: Math.min(...entries.map((e) => e.fetchedAt)),
		degraded: entries.some((e) => e.sourcesOk < 3),
	};
	if (entries === entriesMemo || entries === nearMemo) {
		unionMemo = result;
		unionMemoSrc = entries;
	}
	return result;
}

/** GeoJSON for the Mapbox source. Properties stay SHORT (`t`/`c`/`frp`) — this
 *  is the same shape the Worker emits, so there is one vocabulary end to end. */
export function hotspotsToGeoJSON(
	hotspots: readonly FireHotspot[],
): GeoJSON.FeatureCollection {
	return {
		type: "FeatureCollection",
		features: hotspots.map((h) => ({
			type: "Feature",
			geometry: { type: "Point", coordinates: [...h.coordinates] },
			properties: {
				t: h.t,
				c: h.c,
				frp: h.frp,
				...(h.px === undefined ? {} : { px: h.px }),
				...(h.dn === undefined ? {} : { dn: h.dn }),
			},
		})),
	};
}

/**
 * Plain-English age for the staleness stamp ("2h ago", "3 days ago").
 *
 * Reads as SAFETY COPY, not a debug string — a planter deciding whether to
 * trust these dots reads this line. `null` yields the honest "no fire data"
 * rather than an implied-fresh blank.
 */
export function fireAgeLabel(
	fetchedAt: number | null,
	now: number = Date.now(),
): string {
	if (fetchedAt === null) return "no fire data";
	const mins = Math.max(0, Math.floor((now - fetchedAt) / 60_000));
	if (mins < 2) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "1 day ago" : `${days} days ago`;
}
