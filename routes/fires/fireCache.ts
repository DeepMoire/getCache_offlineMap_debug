/**
 * v4FireCache — wildfire hotspots on disk, so the layer survives losing signal.
 *
 * ⚠️ UI MUST show each record's fetchedAt age — painting stale dots as live is the one dangerous failure here.
 * Refreshed on TTL, not just when missing (unlike areaTilesPresent, "already have it" isn't enough).
 * ⚠️ Never hides the layer for being stale — age is shown, never hidden (Law 1: constant presence).
 * Own IndexedDB DB (never TinyBase — big local-only payload), sandbox-aware via keyedIdbStore.
 */

import { kmBetween, kmToDegSpan } from "../../lib/shared/kmGeo";
import { makeKeyedIdbStore } from "../../lib/onPhone/store/keyedIdbStore";

/**
 * Bump when the stored shape OR the data's correctness changes — a stale-format record reads as absent and a bake pass replaces it.
 * ⚠️ A TTL only catches STALE data, never WRONG data — bump the version whenever a fix changes what a correct response looks like.
 */
export const FIRE_CACHE_VERSION = 3;

/**
 * Disc radius requested per area — the smoke shed, not just the block.
 * MUST match the /fires route's default, or the presence probe and fetch disagree about "covered".
 * ⚠️ STAYS AT 500 — also the RENDER wall (fireRelevance.ts HARD_CUTOFF_KM); don't shrink it to fix a rendering problem, that rule lives there.
 */
export { FIRE_RADIUS_KM } from "../../lib/shared/fireContract";

/**
 * How long the PHONE keeps its own copy before asking the Worker again.
 * ⚠️ Was 1h (matching the edge) — wrong: two TTLs COMPOUND, not add, and produced `Last checked — 5h ago` with the app open.
 * The edge cache (not this one) protects NASA — a phone re-asking costs a cache hit, not a NASA call, so staying eager here is free.
 */
export const FIRE_TTL_MS = 5 * 60 * 1000;

// don't reintroduce a flat "stale after N hours" threshold — removed FIRE_STALE_MS had no right value; unionHotspots' newer-fetch-supersedes rule replaced it.

/** VIIRS confidence, categorical (l/n/h) — mirrors the Worker's enum. */
export type { FireConfidence } from "../../lib/shared/fireContract";

export type { FireHotspot } from "../../lib/shared/fireContract";
import type { FireHotspot } from "../../lib/shared/fireContract";

export interface FireCacheEntry {
	cacheVersion: number;
	/** When WE fetched it (vs each hotspot's own `t` — when the SATELLITE saw it); both matter. */
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

/** This area's hotspots, or null if absent / written by an older format. Freshness is unchecked here — see `isFresh`. */
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

/** Drop one area's hotspots — called by the bake service's eviction pass so a pruned area sheds all its data together (photo + tiles + fires). */
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
 * Memoized: recomputing unionHotspots on every pan is pure re-derivation of unchanged data — compute on write, reuse on read (same pattern as fireClassifyCache.ts).
 * ⚠️ THIS MEMO IS ABOUT CPU TIME, NOT MEMORY — don't delete it on memory grounds; the real heap wins are elsewhere (keyedIdbStore.getAllProjected, assetRegion.ts).
 */
let entriesMemo: FireCacheEntry[] | null = null;
let unionMemo: UnionResult | null = null;
/** The exact array `unionMemo` was computed from — see the identity check in `unionHotspots` (two memo'd reads exist, holding different discs). */
let unionMemoSrc: readonly FireCacheEntry[] | null = null;
/** Origin-filtered read's memo + the origin set it was built for — cleared together with `entriesMemo` by `invalidateFireEntries`. */
let nearMemo: FireCacheEntry[] | null = null;
let nearMemoKey = "";
let coverageMemo: FireCoverage[] | null = null;

/** Drop the memo. Exported so a test — or any future writer that bypasses the two functions above — can force the next read to hit disk. */
export function invalidateFireEntries(): void {
	entriesMemo = null;
	unionMemo = null;
	coverageMemo = null;
	nearMemo = null;
	nearMemoKey = "";
	unionMemoSrc = null;
}

/** Every cached area's hotspots, unioned across areas (not just the nearest) so a planter near two anchors sees both. Memoized; invalidated by every write/delete. */
export async function allFireEntries(): Promise<FireCacheEntry[]> {
	if (entriesMemo !== null) return entriesMemo;
	// CURSOR, never getAll() — getAll() deserialized the whole disc set in one task, measured 616 MB / 90.4% of allocation + 7,498ms blocked handler; cursor splits it instead.
	entriesMemo = (
		await idb.getAllProjected((e) =>
			e?.cacheVersion === FIRE_CACHE_VERSION ? e : null,
		)
	).filter((e): e is FireCacheEntry => e !== null);
	return entriesMemo;
}

/**
 * Discs that could possibly RENDER given the user's actual position (filters allFireEntries by HARD_CUTOFF_KM).
 * ⚠️ CORRECTNESS, not just perf: test must be "could any part of the disc be in range" (maxKm + disc radius), never "is the disc's centre in range" — centre-only testing silently hides real fires at the edge.
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
	// ⚠️ MEMOIZED ON THE SELECTED DISCS, NEVER ON THE ORIGINS — origins change every pan; keying on them cost 7,270ms/44.5% main thread by invalidating the downstream unionHotspots → fireOutlines memo chain. Return the SAME array object when the disc set is unchanged (see the `outlineSrc` note in fireLayer.ts).
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

/** One disc's coverage only — where and when, no hotspots attached. */
export interface FireCoverage {
	readonly center: [number, number];
	readonly radiusKm: number;
	readonly fetchedAt: number;
}

/** Where/when each cached disc was fetched, without hotspots — use for coverage/freshness/containment; reach for `allFireEntries()` only when you need the detections themselves (painting). */
export async function fireCoverage(): Promise<FireCoverage[]> {
	if (coverageMemo !== null) return coverageMemo;
	// PROJECTED, never getAll() — getAll() still deserializes all 73,225 detections in one task just to read circle centres (browser flagged a 600–1140ms 'success' handler); projection drops each record after copying its centre.
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

/** True when this coverage record is inside its TTL. Mirrors `isFresh`, but takes the light shape so a caller need not hold a full entry to ask. */
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

// ⛔ a hotspot must be dropped once a NEWER fetch covers its ground and doesn't report it — the dedupe key (position+hour) doesn't do this alone, so without this rule stale fires from an old disc linger next to a fresh one.
const SUPERSEDE_SLACK_MS = 30 * 60 * 1000;

/** Is this coordinate inside the disc `e` covered when it was fetched? */
function coveredBy(e: FireCacheEntry, lng: number, lat: number): boolean {
	return kmBetween([lng, lat], e.center) <= e.radiusKm;
}

interface DiscBox {
	w: number;
	s: number;
	e: number;
	n: number;
}

/** Degree box that contains the whole disc — dLng taken at the box's own worst latitude so the reject can never drop a point `coveredBy` would accept (kmBetween's cos runs at the POINT's latitude, not the centre's). */
function discBox(entry: FireCacheEntry): DiscBox {
	const [lng, lat] = entry.center;
	const worstLat = Math.min(89, Math.abs(lat) + entry.radiusKm / 111);
	const { dLat, dLng } = kmToDegSpan(entry.radiusKm, worstLat);
	return { w: lng - dLng, s: lat - dLat, e: lng + dLng, n: lat + dLat };
}

/** Unions every cached area into one deduplicated hotspot list, plus the OLDEST (not newest) contributing fetch time — newest would let one fresh disc vouch for a stale one sitting beside it. */
export function unionHotspots(entries: readonly FireCacheEntry[]): UnionResult {
	if (entries.length === 0) {
		return { hotspots: [], oldestFetchedAt: null, degraded: false };
	}
	// Memoized on the EXACT array identity (two memo'd reads exist, holding different discs) — memoizing on "is this one of them" would silently serve the wrong union and drop fires; a caller's own array always computes fresh.
	if (unionMemo !== null && entries === unionMemoSrc) return unionMemo;
	// Key on rounded position + hour, matching the Worker's dedupe, so one fire stays one dot across areas.
	// PRECOMPUTED outside the hotspot loop — doing the newer-covers test per-hotspot would be O(n²) (tens of discs × tens of thousands of hotspots) and reintroduce the per-pan hitch.
	// Sorted NEWEST-FIRST so the covering search below can stop at its first hit.
	const boxes = entries.map(discBox);
	const newerThan = entries.map((e) =>
		entries
			.map((other, j) => ({ other, box: boxes[j] }))
			.filter(({ other }) => other.fetchedAt > e.fetchedAt)
			.sort((a, b) => b.other.fetchedAt - a.other.fetchedAt),
	);
	const best = new Map<string, FireHotspot>();
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		const newer = newerThan[i];
		for (const h of e.hotspots) {
			// Find the newest later fetch covering this spot; slack accounts for NASA's processing lag so a very recent detection isn't wrongly erased by a fetch too soon to include it.
			// Box-reject before kmBetween — the trig call per (hotspot × newer disc) was the 119% idle-CPU bug; the box keeps distance calls proportional to hotspots, not hotspots × discs.
			const [lng, lat] = h.coordinates;
			let newestCover = 0;
			for (const { other, box } of newer) {
				if (lng < box.w || lng > box.e || lat < box.s || lat > box.n) {
					continue;
				}
				if (coveredBy(other, lng, lat)) {
					newestCover = other.fetchedAt; // first hit IS the newest — newerThan is sorted
					break;
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
		// codestyle-allow-spread: one entry per cached fire area (tens at most) — never near the argument-count limit.
		oldestFetchedAt: Math.min(...entries.map((e) => e.fetchedAt)),
		degraded: entries.some((e) => e.sourcesOk < 3),
	};
	if (entries === entriesMemo || entries === nearMemo) {
		unionMemo = result;
		unionMemoSrc = entries;
	}
	return result;
}

/** GeoJSON for the Mapbox source. Properties stay SHORT (`t`/`c`/`frp`) — this is the same shape the Worker emits, so there is one vocabulary end to end. */
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

/** Plain-English age for the staleness stamp ("2h ago", "3 days ago") — safety copy, not a debug string. `null` yields "no fire data" rather than an implied-fresh blank. */
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
