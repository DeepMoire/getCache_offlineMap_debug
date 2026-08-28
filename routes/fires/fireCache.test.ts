/**
 * v4FireCache.test.ts — the pure logic of the offline hotspot cache.
 *
 * The load-bearing tests are the STALENESS ones. Everything else is plumbing;
 * the age stamp is the safety surface a planter reads before trusting the dots.
 */

import { describe, expect, it, vi } from "vitest";

/**
 * `kmBetween` is COUNTED, not stubbed — the wrapper delegates to the real
 * implementation, so every test in this file exercises the true maths while the
 * cost block below can assert on how often the expensive path is reached.
 *
 * This is the quantity a DevTools profile put at 30.1% of the main thread on
 * 2026-08-10 (see the cost block at the bottom of this file), which is why it is
 * worth instrumenting rather than inferring from wall clock.
 */
let kmBetweenCalls = 0;
vi.mock("../../lib/shared/kmGeo", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../../lib/shared/kmGeo")>();
	return {
		...real,
		kmBetween: (a: [number, number], b: [number, number]) => {
			kmBetweenCalls++;
			return real.kmBetween(a, b);
		},
	};
});

import {
	discCouldRender,
	FIRE_TTL_MS,
	type FireCacheEntry,
	type FireHotspot,
	fireAgeLabel,
	hotspotsToGeoJSON,
	invalidateFireEntries,
	isCoverageFresh,
	isFresh,
	unionHotspots,
} from "./fireCache";

const T0 = Date.UTC(2026, 7, 7, 18, 0);

const spot = (
	lng: number,
	lat: number,
	frp = 5,
	t = T0,
	c: FireHotspot["c"] = "nominal",
): FireHotspot => ({ coordinates: [lng, lat], t, c, frp });

const entry = (
	fetchedAt: number,
	hotspots: FireHotspot[],
	sourcesOk = 3,
): FireCacheEntry => ({
	cacheVersion: 1,
	fetchedAt,
	center: [-75.7, 45.4],
	radiusKm: 500,
	sourcesOk,
	hotspots,
});

describe("the per-pan memo — never at the cost of correctness", () => {
	// Measured before this memo existed: every `moveend` re-read 73,225 hotspots
	// from IndexedDB (24 ms) and re-deduped them (25 ms) to produce a
	// byte-identical answer. ~49 ms of blocked main thread per pan, for nothing.
	//
	// The risk a memo introduces is the ONLY thing that matters here: a stale
	// answer would mean a freshly-baked fire not appearing. These tests pin that
	// it cannot happen.

	it("a caller's OWN array is never served from the memo", () => {
		// Only the array `allFireEntries()` hands out is memoized. Anything a
		// caller builds itself — a test, a filtered subset — computes fresh, so
		// the memo can never answer a question it wasn't asked.
		const a = [entry(T0, [spot(-120, 50, 5)])];
		const b = [entry(T0, [spot(-121, 51, 9)])];
		expect(unionHotspots(a).hotspots[0].coordinates).toEqual([-120, 50]);
		expect(unionHotspots(b).hotspots[0].coordinates).toEqual([-121, 51]);
	});

	it("still dedupes correctly when called repeatedly with equal-but-distinct arrays", () => {
		const mk = (): FireCacheEntry[] => [
			entry(T0, [spot(-120, 50), spot(-120, 50)]),
		];
		expect(unionHotspots(mk()).hotspots).toHaveLength(1);
		expect(unionHotspots(mk()).hotspots).toHaveLength(1);
	});

	it("invalidate is safe to call at any time, including twice", () => {
		// Writers call it unconditionally; it must never throw or corrupt state.
		expect(() => {
			invalidateFireEntries();
			invalidateFireEntries();
		}).not.toThrow();
		expect(unionHotspots([entry(T0, [spot(-120, 50)])]).hotspots).toHaveLength(
			1,
		);
	});
});

/**
 * `discCouldRender` decides which discs are even READ off disk. Reading every
 * one measured 616 MB — 90% of the whole allocation profile — so this filter is
 * load-bearing for memory. But it is filtering the SAFETY layer, so the only
 * acceptable failure direction is reading too MUCH.
 *
 * The trap it exists to avoid: testing the disc's CENTRE against the wall. A
 * disc centred 900 km away still reaches 400 km inward, and a fire sitting in
 * that overlap is genuinely on screen. Centre-testing would silently hide it —
 * a fire the user can see out the window, missing from the map.
 */
describe("discCouldRender — the read filter must never hide a visible fire", () => {
	const WALL = 500; // HARD_CUTOFF_KM
	const HOME: readonly [number, number] = [-75.7, 45.4]; // Ottawa
	const disc = (center: [number, number], radiusKm = 500) => ({
		center,
		radiusKm,
	});

	it("keeps the disc you are standing in", () => {
		expect(discCouldRender(disc([-75.7, 45.4]), [HOME], WALL)).toBe(true);
	});

	it("keeps a FAR-CENTRED disc whose edge still reaches inside the wall", () => {
		// ~900 km east of Ottawa. Its centre is way past the 500 km wall, but with a
		// 500 km radius it covers ground only ~400 km out — which renders. Centre-
		// testing would drop this disc and hide those fires.
		const farCentre = disc([-64.3, 45.4]);
		const centreDist = 900;
		expect(centreDist).toBeGreaterThan(WALL); // centre IS beyond the wall
		expect(discCouldRender(farCentre, [HOME], WALL)).toBe(true);
	});

	it("drops a disc that cannot reach the wall from any origin", () => {
		// Vancouver — ~3,500 km from Ottawa, far past wall + radius (1,000 km).
		expect(discCouldRender(disc([-123.1, 49.3]), [HOME], WALL)).toBe(false);
	});

	it("keeps a disc near ANY origin, not just the first", () => {
		const vancouver: readonly [number, number] = [-123.1, 49.3];
		const d = disc([-123.1, 49.3]);
		expect(discCouldRender(d, [HOME], WALL)).toBe(false);
		expect(discCouldRender(d, [HOME, vancouver], WALL)).toBe(true);
	});

	it("with no origins, decides nothing — the caller falls back to reading all", () => {
		expect(discCouldRender(disc([-123.1, 49.3]), [], WALL)).toBe(false);
	});

	it("a bigger disc reaches further — radius is part of the test, not decoration", () => {
		const centre: [number, number] = [-64.3, 45.4]; // ~900 km out
		expect(discCouldRender(disc(centre, 100), [HOME], WALL)).toBe(false);
		expect(discCouldRender(disc(centre, 500), [HOME], WALL)).toBe(true);
	});
});

/**
 * REFERENCE STABILITY — the contract that broke, and what it cost.
 *
 * `unionHotspots` memoizes on the identity of the array handed to it, and
 * `fireOutlines` in turn memoizes on the identity of the `hotspots` array that
 * comes out. So the read at the bottom of that chain must return the SAME ARRAY
 * OBJECT whenever the underlying disc selection has not changed.
 *
 * When the near-read was keyed on the ORIGINS instead (which include the map
 * centre, so they change on every pan), each pan minted a new array, invalidated
 * the whole memo chain, and dragged the ~52 ms hull rebuild back onto every
 * gesture: measured at 7,270 ms self time, 44.5% of the main thread.
 *
 * These tests pin the invariant at the `unionHotspots` layer, which is the one
 * that is pure and reachable without IndexedDB.
 */
describe("memo identity — a new array on every pan is a performance bug", () => {
	// The near-read's KEY is what decides whether the same array comes back, so
	// that is what these pin. `discCouldRender` is the selector behind the key:
	// two origin sets that select the SAME discs must produce the SAME key, or
	// every pan mints a new array and the whole downstream memo chain dies.
	const WALL = 500;
	const disc = (center: [number, number]) => ({ center, radiusKm: 500 });
	const keyOf = (
		discs: { center: [number, number]; radiusKm: number }[],
		origins: readonly (readonly [number, number])[],
	) =>
		discs
			.filter((d) => discCouldRender(d, origins, WALL))
			.map((d) => `${d.center[0].toFixed(4)},${d.center[1].toFixed(4)}`)
			.sort()
			.join(";");

	const DISCS = [disc([-75.7, 45.4]), disc([-123.1, 49.3])];

	it("a small pan does NOT change the key — same discs, same array downstream", () => {
		// Two camera positions a few km apart. This is the pan case that was
		// minting a new array every gesture and costing 44.5% of the main thread.
		const before = keyOf(DISCS, [[-75.7, 45.4]]);
		const after = keyOf(DISCS, [[-75.75, 45.45]]);
		expect(after).toBe(before);
		expect(before).not.toBe(""); // guard: the test would be vacuous if empty
	});

	it("crossing into a new disc's range DOES change the key", () => {
		const east = keyOf(DISCS, [[-75.7, 45.4]]);
		const west = keyOf(DISCS, [[-123.1, 49.3]]);
		expect(west).not.toBe(east);
	});

	it("key is order-independent — the same disc set never reads as two keys", () => {
		const a = keyOf(DISCS, [
			[-75.7, 45.4],
			[-123.1, 49.3],
		]);
		const b = keyOf([...DISCS].reverse(), [
			[-123.1, 49.3],
			[-75.7, 45.4],
		]);
		expect(b).toBe(a);
	});
});

describe("isFresh", () => {
	it("is fresh inside the TTL", () => {
		expect(isFresh(entry(T0, []), T0 + FIRE_TTL_MS - 1000)).toBe(true);
	});

	it("is stale past the TTL", () => {
		expect(isFresh(entry(T0, []), T0 + FIRE_TTL_MS + 1000)).toBe(false);
	});
});

describe("unionHotspots", () => {
	it("returns an honest empty state with a null timestamp", () => {
		const u = unionHotspots([]);
		expect(u.hotspots).toEqual([]);
		// null, NOT Date.now() — an empty cache must not claim to be fresh.
		expect(u.oldestFetchedAt).toBeNull();
	});

	it("merges several areas into one list", () => {
		const u = unionHotspots([
			entry(T0, [spot(-75.6, 45.5)]),
			entry(T0, [spot(-79.4, 43.7)]),
		]);
		expect(u.hotspots).toHaveLength(2);
	});

	it("dedupes the same fire reported by two OVERLAPPING areas", () => {
		const u = unionHotspots([
			entry(T0, [spot(-75.6001, 45.5001, 10)]),
			entry(T0, [spot(-75.6002, 45.5002, 25)]),
		]);
		expect(u.hotspots).toHaveLength(1);
		expect(u.hotspots[0].frp).toBe(25); // keeps the strongest reading
	});

	it("reports the OLDEST fetch time, so a fresh area can't vouch for a stale one", () => {
		const stale = T0 - 48 * 3600_000;
		const u = unionHotspots([
			entry(T0, [spot(-75.6, 45.5)]),
			entry(stale, [spot(-79.4, 43.7)]),
		]);
		expect(u.oldestFetchedAt).toBe(stale);
	});

	it("flags degraded coverage when a satellite was missing", () => {
		expect(unionHotspots([entry(T0, [], 2)]).degraded).toBe(true);
		expect(unionHotspots([entry(T0, [], 3)]).degraded).toBe(false);
	});
});

describe("fireAgeLabel — safety copy, not a debug string", () => {
	it("says 'no fire data' for a null stamp rather than implying freshness", () => {
		expect(fireAgeLabel(null, T0)).toBe("no fire data");
	});

	it("reads in plain English across the ranges", () => {
		expect(fireAgeLabel(T0, T0 + 30_000)).toBe("just now");
		expect(fireAgeLabel(T0, T0 + 25 * 60_000)).toBe("25 min ago");
		expect(fireAgeLabel(T0, T0 + 3 * 3600_000)).toBe("3h ago");
		expect(fireAgeLabel(T0, T0 + 26 * 3600_000)).toBe("1 day ago");
		expect(fireAgeLabel(T0, T0 + 72 * 3600_000)).toBe("3 days ago");
	});

	it("never reports a negative age from clock skew", () => {
		expect(fireAgeLabel(T0, T0 - 60_000)).toBe("just now");
	});
});

describe("hotspotsToGeoJSON", () => {
	it("emits a FeatureCollection Mapbox can consume directly", () => {
		const fc = hotspotsToGeoJSON([spot(-75.6, 45.5, 3.2, T0, "high")]);
		expect(fc.type).toBe("FeatureCollection");
		expect(fc.features[0].geometry).toEqual({
			type: "Point",
			coordinates: [-75.6, 45.5],
		});
		expect(fc.features[0].properties).toEqual({ t: T0, c: "high", frp: 3.2 });
	});

	it("copies coordinates so a later mutation can't corrupt the GL source", () => {
		// Mapbox boundary law: plain JSON, no shared/proxied references.
		const h = spot(-75.6, 45.5);
		const fc = hotspotsToGeoJSON([h]);
		const coords = (fc.features[0].geometry as GeoJSON.Point).coordinates;
		expect(coords).not.toBe(h.coordinates);
	});

	it("handles an empty list", () => {
		expect(hotspotsToGeoJSON([]).features).toEqual([]);
	});
});

/**
 * ⛔ A FIRE THE SATELLITE HAS LOOKED FOR AND NOT FOUND IS OUT.
 *
 * The field report: a card read `Last detected — 23h ago` while the app was
 * fetching every hour. That is self-contradictory on its face — if we keep
 * checking and the fire is not in the new data, it is not burning.
 *
 * Measured cause, on a real device: a disc fetched 23.5 h ago sat in the cache
 * beside one fetched minutes earlier, both covering the same ground. Nothing
 * refetched the old one (geographic containment says a fresh neighbour covers
 * it) and nothing dropped it, so `unionHotspots` merged BOTH PILES and the
 * day-old sighting painted as a live fire.
 */
describe("superseded ground — newer evidence wins", () => {
	const HOUR = 3_600_000;
	const NOW = 1_800_000_000_000;
	const HARRISON: [number, number] = [-121.78, 49.3];

	const disc = (
		fetchedAt: number,
		centre: [number, number],
		hotspots: { coordinates: [number, number]; t: number; frp: number }[],
	) => ({
		cacheVersion: 3,
		fetchedAt,
		center: centre,
		radiusKm: 500,
		sourcesOk: 3,
		hotspots: hotspots.map((h) => ({ ...h, c: "nominal" as const })),
	});

	it("drops a day-old fire when a NEWER fetch covered that ground", () => {
		// THE BUG, exactly as measured.
		const stale = disc(NOW - 23.5 * HOUR, HARRISON, [
			{ coordinates: HARRISON, t: NOW - 23 * HOUR, frp: 12 },
		]);
		const fresh = disc(NOW, HARRISON, []); // looked again — nothing there
		const { hotspots } = unionHotspots([stale, fresh]);
		expect(hotspots).toHaveLength(0);
	});

	it("KEEPS it when no newer fetch covered that ground", () => {
		// Law 1, constant presence: we only discard on newer evidence about THAT
		// SPOT. A fire nobody has re-checked keeps its last known sighting.
		const stale = disc(NOW - 23.5 * HOUR, HARRISON, [
			{ coordinates: HARRISON, t: NOW - 23 * HOUR, frp: 12 },
		]);
		// Fresh disc 2,000 km away — covers nothing near Harrison.
		const elsewhere = disc(NOW, [-79.4, 43.7], []);
		const { hotspots } = unionHotspots([stale, elsewhere]);
		expect(hotspots).toHaveLength(1);
	});

	it("keeps a fire the newest fetch DID report", () => {
		// The ordinary case: still burning, still listed.
		const fresh = disc(NOW, HARRISON, [
			{ coordinates: HARRISON, t: NOW - 20 * 60_000, frp: 40 },
		]);
		const { hotspots } = unionHotspots([fresh]);
		expect(hotspots).toHaveLength(1);
	});

	it("does not erase a fire detected just BEFORE the newest fetch", () => {
		// NASA's processing lag: a detection minutes before our fetch cannot yet
		// be in that fetch's data. Without slack we would erase live fires.
		const older = disc(NOW - HOUR, HARRISON, [
			{ coordinates: HARRISON, t: NOW - 10 * 60_000, frp: 30 },
		]);
		const fresh = disc(NOW, HARRISON, []);
		const { hotspots } = unionHotspots([older, fresh]);
		expect(hotspots).toHaveLength(1);
	});

	it("a stale disc cannot erase a fire from a FRESHER disc", () => {
		// Only LATER fetches supersede. Order in the array must not matter.
		const fresh = disc(NOW, HARRISON, [
			{ coordinates: HARRISON, t: NOW - 30 * 60_000, frp: 55 },
		]);
		const stale = disc(NOW - 20 * HOUR, HARRISON, []);
		expect(unionHotspots([fresh, stale]).hotspots).toHaveLength(1);
		expect(unionHotspots([stale, fresh]).hotspots).toHaveLength(1);
	});
});

/**
 * ── THE COVERAGE VIEW IS THE MEMORY FIX. DON'T LET IT ROT BACK. ──
 *
 * Two callers — the map layer's fetch gate and the bake service's containment
 * gate — ask a purely geographic question: "is this view already covered by a
 * fresh disc?" Neither reads a hotspot. They used to call `allFireEntries()`,
 * whose memo then held every detection alive permanently. On a real device
 * cache that was 73,225 hotspots pinned to answer a question about circle
 * centres.
 *
 * `isCoverageFresh` takes the LIGHT shape on purpose: a caller that cannot get
 * a full `FireCacheEntry` cheaply must still be able to ask about freshness,
 * otherwise the temptation is to reach for `allFireEntries()` again and quietly
 * restore the leak.
 */
describe("coverage freshness — the light shape", () => {
	const cov = (fetchedAt: number) => ({
		center: [-75.7, 45.4] as [number, number],
		radiusKm: 500,
		fetchedAt,
	});

	it("matches isFresh's TTL boundary exactly", () => {
		const now = T0;
		// Inside the TTL on both paths, outside it on both. The two must never
		// drift — a coverage gate that disagreed with the entry gate would fetch
		// when the cache says fresh, or skip when it says stale.
		expect(isCoverageFresh(cov(now - FIRE_TTL_MS + 1_000), now)).toBe(true);
		expect(isCoverageFresh(cov(now - FIRE_TTL_MS - 1_000), now)).toBe(false);
	});

	it("needs NO hotspots to answer", () => {
		// The whole point: this object has no `hotspots` key at all and the
		// question is still answerable. If a future change makes this require a
		// full entry, the memory fix is gone.
		expect(isCoverageFresh(cov(T0), T0)).toBe(true);
	});
});

/**
 * ⛔ TWO CACHES COMPOUND — they do not overlap.
 *
 * The phone's TTL was 1 h, the same as the Worker's edge cache, on the
 * reasoning that a shorter one just re-fetches identical bytes. Wrong: the two
 * windows can be OFFSET, so a phone can receive a copy that is already 59 min
 * old and then hold it for another hour. Field result: `Last checked — 5h ago`
 * with the app open, and every cached disc measured at 6+ hours.
 *
 * The edge cache is what protects NASA; this one protects nothing. A phone
 * re-asking every 5 min costs a cache HIT, not a NASA call.
 */
describe("the phone's TTL is SHORT — the edge does the rate-limiting", () => {
	it("is minutes, not an hour", () => {
		expect(FIRE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
		expect(FIRE_TTL_MS).toBeGreaterThanOrEqual(60 * 1000);
	});

	it("is well under the edge cache's hour, so the two cannot compound", () => {
		// If this ever equals or exceeds the edge TTL (3600 s), a phone can hold
		// an already-stale copy for a second full window.
		expect(FIRE_TTL_MS).toBeLessThan(60 * 60 * 1000);
	});

	it("bounds what `Last checked` can read while ONLINE", () => {
		// phone TTL + edge TTL is the worst case a connected user can see. Above
		// that means genuinely offline — which is when the number matters.
		const worstCaseOnlineMs = FIRE_TTL_MS + 60 * 60 * 1000;
		expect(worstCaseOnlineMs).toBeLessThanOrEqual(70 * 60 * 1000);
	});
});

/**
 * ── THE SUPERSEDE TEST IS O(discs × hotspots × discs). DON'T LET IT GO CUBIC. ──
 *
 * MEASURED, 2026-08-10. The app burned **119% CPU sitting completely idle** with
 * nothing on screen moving. A DevTools Performance profile (30 s, untouched page)
 * named it outright:
 *
 *   kmBetween      geo.ts:41              7,982 ms   30.1% self
 *   unionHotspots  v4FireCache.ts         5,474 ms   20.6% self
 *   paintInner     fireLayer.ts:537                  63.6% TOTAL
 *
 * The supersede loop ran `coveredBy` — a `Math.cos` plus a `Math.hypot` — once
 * per (hotspot × newer disc). At the measured cache size, 73,225 hotspots across
 * tens of discs, that is millions of trig calls per union, recomputed on a timer,
 * forever. After the fix: **3.4% CPU**, and the in-app work meter reads a 28 ms
 * fire paint.
 *
 * Two things made it fast, and BOTH are load-bearing:
 *   1. A bounding-box reject before the exact distance test. Outside the box ⇒
 *      outside the circle, so two comparisons replace the trig for nearly every
 *      pair. Discs are far apart relative to their radius, so almost everything
 *      is rejected before `kmBetween` is ever reached.
 *   2. Discs sorted newest-first so the inner loop BREAKS on its first cover —
 *      it wants the NEWEST covering fetch, and sorted descending the first hit
 *      already IS the answer.
 *
 * These tests are a COST budget, not a correctness check — correctness lives in
 * "superseded ground" above, and those tests pass under both the fast and the
 * slow implementation. That is exactly why this block has to exist separately:
 * nothing else in the suite can tell a 28 ms paint from a 7,982 ms one.
 *
 * ── VERIFIED RED ──
 * Re-introducing the old loop (drop the box reject and the break, keep the
 * `fetchedAt > newestCover` scan) fails both budgets, and the numbers are the
 * bug itself:
 *
 *   scales LINEARLY …          expected 4.14 to be less than 2.5
 *   absorbs a realistic cache  expected 1,065,750 to be less than 147,000
 *
 * Over a MILLION distance calls for one union of a realistic cache — recomputed
 * on a timer, forever. Every correctness test in this file still passed while
 * that was true.
 *
 * ⚠️ If one of these fails, do NOT raise the budget. The budget failing means
 * the loop went quadratic-or-worse again. Re-read the two points above.
 */
describe("unionHotspots stays cheap as the cache grows — the 119% CPU bug", () => {
	const NOW = 1_800_000_000_000;
	const HOUR = 3_600_000;

	/** `n` discs scattered across the continent, each with `per` hotspots inside
	 *  it. Every disc gets a UNIQUE centre (a 1°-pitch grid, never a modulo that
	 *  repeats one) and every hotspot a position that survives the union's
	 *  `toFixed(3)` dedupe key — otherwise the fixture silently collapses and the
	 *  test measures a fraction of the data it claims to.
	 *
	 *  1° pitch against a 30 km radius is the real-world shape: discs sit far
	 *  apart relative to their size, so the box reject fires on nearly every
	 *  pair. `spacingExceedsDiameter` below pins that assumption. */
	const scatter = (n: number, per: number): FireCacheEntry[] =>
		Array.from({ length: n }, (_, i) => {
			const centre: [number, number] = [
				-130 + Math.floor(i / 6),
				44 + (i % 6),
			];
			return {
				cacheVersion: 3,
				fetchedAt: NOW - i * HOUR,
				center: centre,
				radiusKm: 30,
				sourcesOk: 3,
				hotspots: Array.from({ length: per }, (_, j) => ({
					// 0.002° apart ⇒ distinct at toFixed(3), and `per` up to ~2,500
					// stays inside the 30 km radius (2,500 × 0.002° ≈ 0.15° ≈ 17 km
					// across the serpentine below).
					coordinates: [
						centre[0] + (j % 64) * 0.002,
						centre[1] + Math.floor(j / 64) * 0.002,
					] as [number, number],
					t: NOW - i * HOUR - 60_000,
					c: "nominal" as const,
					frp: 5 + (j % 20),
				})),
			};
		});

	/** Exact `kmBetween` calls for one cold union.
	 *
	 *  COUNTED, never timed. A wall-clock ratio on a millisecond measurement is
	 *  flaky by construction — it fails on a loaded CI box and passes on a fast
	 *  one, which is worse than no test. The call count is deterministic, it is
	 *  the *actual* quantity the profile indicted (7,982 ms of `kmBetween`), and
	 *  it cannot be gamed by a faster machine.
	 *
	 *  The memo only serves the exact array identity `nearFireEntries` hands out,
	 *  so a locally-built array always computes for real — nothing to defeat. */
	const countDistanceCalls = (entries: FireCacheEntry[]): number => {
		invalidateFireEntries();
		kmBetweenCalls = 0;
		unionHotspots(entries);
		return kmBetweenCalls;
	};

	it("scales LINEARLY in disc count — the cubic term is gone", () => {
		// THE REGRESSION GUARD. Hold hotspots-per-disc fixed and double the DISC
		// count. The old loop tested every hotspot against every newer disc, so
		// doubling the discs roughly QUADRUPLED the distance calls. With the box
		// reject, a far disc costs four comparisons and no trig at all, so the
		// count grows about linearly.
		//
		// 2.5× for a 2× input leaves room for the boundary discs that legitimately
		// do overlap. The bug this catches was ~4× and compounding — it does not
		// squeak past this line.
		const small = countDistanceCalls(scatter(15, 400));
		const large = countDistanceCalls(scatter(30, 400));
		expect(large / Math.max(small, 1)).toBeLessThan(2.5);
	});

	it("absorbs a realistic full cache without millions of trig calls", () => {
		// The measured device cache: ~73,000 hotspots across 30 discs. The old
		// loop ran the distance test on (hotspot × newer disc) — order 10^6 calls
		// per union, on a timer, forever. The box reject must keep it to a small
		// multiple of the hotspot count, never a multiple of hotspots × discs.
		const entries = scatter(30, 2_450);
		const hotspots = 30 * 2_450;
		const calls = countDistanceCalls(entries);
		expect(calls).toBeLessThan(hotspots * 2);
	});

	it("rejects far discs by box rather than by trigonometry", () => {
		// The box only pays off if discs genuinely miss each other. Two adjacent
		// grid discs at 1° pitch with a 30 km radius must not overlap, or the
		// pre-reject never fires and this whole block measures the wrong thing.
		const [a, b] = scatter(2, 1);
		const apart = Math.hypot(
			(b.center[0] - a.center[0]) * 111 * Math.cos((a.center[1] * Math.PI) / 180),
			(b.center[1] - a.center[1]) * 111,
		);
		expect(apart).toBeGreaterThan(a.radiusKm + b.radiusKm);
	});

	it("still supersedes correctly at scale — speed must not cost truth", () => {
		// The optimisation is only legitimate if the ANSWER is unchanged. Same
		// ground, two fetches: the newer one looked and saw nothing, so the older
		// sighting must still be dropped even inside a big scattered cache.
		//
		// The pair sits WELL clear of the scatter grid (which spans about -130..-126
		// lng, 44..49 lat) because these two discs carry a 500 km radius — parked
		// on the grid they would legitimately supersede a chunk of the noise and
		// the count below would be measuring the wrong thing.
		const ground: [number, number] = [-95, 52];
		const noise = scatter(25, 100);
		const stale: FireCacheEntry = {
			cacheVersion: 3,
			fetchedAt: NOW - 20 * HOUR,
			center: ground,
			radiusKm: 500,
			sourcesOk: 3,
			hotspots: [
				{ coordinates: ground, t: NOW - 19 * HOUR, c: "nominal", frp: 12 },
			],
		};
		const fresh: FireCacheEntry = {
			cacheVersion: 3,
			fetchedAt: NOW,
			center: ground,
			radiusKm: 500,
			sourcesOk: 3,
			hotspots: [],
		};
		invalidateFireEntries();
		const { hotspots } = unionHotspots([...noise, stale, fresh]);
		// Every scattered fire survives (nothing newer covers them); the
		// superseded one is gone.
		expect(hotspots).toHaveLength(25 * 100);
	});
});
