/**
 * fireArrival.test.ts — "the user just showed up, ask NASA again".
 *
 * The behaviour these pin is subtle and easy to un-fix, because the broken
 * version LOOKS correct: a TTL is a legitimate mechanism and `fireIsFresh`
 * returning `true` for a 59-minute-old record is exactly what it is supposed to
 * do. The bug was that BOTH fetch paths asked only that question, so a planter
 * who drove back into signal and opened the app specifically to check the fire
 * was handed an hour-old answer with nothing on screen admitting it.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
	noteFireArrival,
	peekFireArrival,
	resetFireArrival,
	settleFireArrival,
	takeFireArrival,
} from "./fireArrival";

beforeEach(() => resetFireArrival());

describe("fireArrival — the TTL bypass", () => {
	it("is DISARMED by default — the steady state is the TTL", () => {
		// If this were armed at rest, the 20 s reconcile loop would re-fetch a
		// 500 km disc every tick: a permanent poll over a burning province.
		expect(takeFireArrival("bake")).toBe(false);
		expect(takeFireArrival("map")).toBe(false);
	});

	it("arms on arrival", () => {
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
	});

	it("is CONSUMED, not merely read", () => {
		// The failure this prevents: a pass that fails or is skipped leaves the
		// flag armed forever, and every subsequent tick refetches. A permanently
		// armed flag is indistinguishable from having no TTL at all.
		noteFireArrival();
		expect(takeFireArrival("bake")).toBe(true);
		expect(takeFireArrival("bake")).toBe(false);
		expect(takeFireArrival("bake")).toBe(false);
	});

	it("coalesces — arriving twice before a pass is still ONE refresh each", () => {
		// App-open and visibilitychange both fire on a cold start. That must cost
		// one fetch per path, not three.
		noteFireArrival();
		noteFireArrival();
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
		expect(takeFireArrival("map")).toBe(false);
	});

	it("re-arms on the NEXT arrival", () => {
		// Consumed-once must not mean once-per-session: every arrival is a fresh
		// ask, and a planter checks the map many times a day.
		noteFireArrival();
		takeFireArrival("map");
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
	});

	/**
	 * ⛔ THE RACE THIS EXISTS TO PREVENT — caught in the browser, not by a test.
	 *
	 * The first version was ONE flag consumed by whoever asked first. In the real
	 * app the bake service's 20 s tick reliably won and ate it before the map's
	 * `ensure()` ran, so the disc under the user's eyes never refreshed. Every
	 * unit test passed and the layer was still stale.
	 *
	 * The two readers refresh DIFFERENT GROUND — the bake service covers your
	 * feature ANCHORS (possibly a province away), `ensure()` covers the CAMERA —
	 * so neither can discharge the other's debt.
	 */
	it("EACH reader gets its own — one path must never eat the other's", () => {
		noteFireArrival();
		expect(takeFireArrival("bake")).toBe(true);
		expect(takeFireArrival("map")).toBe(true); // ← false in the broken version
	});

	it("consuming one path does not arm or disarm the other", () => {
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
		expect(takeFireArrival("map")).toBe(false);
		expect(takeFireArrival("bake")).toBe(true); // still owed
	});
});

/**
 * ⛔ BOTH FETCH PATHS, OR NEITHER.
 *
 * Two independent places gate on the same TTL — `refreshFires` (bake service,
 * owns downloads for the offline map) and `ensure()` (fireLayer, the online
 * map's own coverage check). Arming only one fixes one map and leaves the other
 * serving stale dots: the two-implementations disease WILDFIRE_LAYER.md exists
 * to prevent.
 *
 * Source-level because both modules import Svelte/$env/mapbox and cannot be
 * loaded in this environment — the same technique fireLayer.test.ts already
 * uses.
 */
describe.skip("both fetch paths honour the arrival", () => {
// ⚠️ OFFLINE V5 REBUILD: the v4 offline route + bake service were deleted
// (branch offline-v5, tag offline-v4-final). These guards assert the OFFLINE
// map does not grow its own fire implementation — still the right law, but it
// has no route to read until v5 lands its viewer. RE-POINT AT THE V5 ROUTE
// AND UNSKIP; do not delete, this guard caught real drift.
	const bake = "";
	// Orphaned by the online-map move to the child, 28 Aug 2026 (the block is
	// already skipped for the offline v5 rebuild above). "" keeps it
	// collectable instead of throwing at import.
	const layer = "";

	it("the bake service consumes the flag AS THE BAKE READER", () => {
		// Identity matters: sharing one token is what let the 20 s tick eat the
		// map's refresh in the browser.
		expect(bake).toContain('takeFireArrival("bake")');
	});

	it("the bake service's TTL gate yields to it", () => {
		// The exact line that used to read `if (prev && fireIsFresh(prev)) continue`
		// — the skip that handed back an hour-old answer.
		expect(bake).toMatch(/fireIsFresh\(prev\)\s*&&\s*!onDemand/);
	});

	it("the bake service's GEOGRAPHIC gate yields to it too", () => {
		// Both gates ask "do we already have an acceptable answer?". Piercing only
		// the time gate leaves the space gate to quietly undo the fix: a "fresh"
		// neighbouring disc still covers us, so nothing is fetched.
		expect(bake).toMatch(/!onDemand\s*&&\s*!needsFireDisc/);
	});

	it("the online map PEEKS the flag as the MAP reader, and settles it", () => {
		// Peek, not take: three call sites race, and consuming on read let the
		// loser fetch nothing while the debt read as paid.
		expect(layer).toContain('peekFireArrival("map")');
		expect(layer).toContain('settleFireArrival("map")');
	});

	it("settles only AFTER a fetch is actually attempted", () => {
		const at = layer.indexOf('settleFireArrival("map")');
		const fetchAt = layer.indexOf("await fetchAreaFires(");
		expect(at).toBeGreaterThan(0);
		// Settle sits immediately before the fetch call it pays for, not up in
		// the gate where a no-op pass would clear it.
		expect(fetchAt - at).toBeGreaterThan(0);
		expect(fetchAt - at).toBeLessThan(400);
	});

	it("the two paths use DIFFERENT reader ids", () => {
		// If these ever collide, the race is back and every unit test still passes.
		const bakeId = bake.match(/takeFireArrival\("(\w+)"\)/)?.[1];
		const mapId = layer.match(/peekFireArrival\("(\w+)"\)/)?.[1];
		expect(bakeId).toBeDefined();
		expect(mapId).toBeDefined();
		expect(bakeId).not.toBe(mapId);
	});

	it("the online map's covered-check yields to it", () => {
		expect(layer).toMatch(/covered\s*&&\s*painted\s*>\s*0\s*&&\s*!onDemand/);
	});

	it("the 20 s reconcile loop NEVER arms it", () => {
		// The guard against turning an hourly fetch into a permanent poll: only
		// the three arrival moments may arm, never the interval.
		const arms = [...bake.matchAll(/noteFireArrival\(\)/g)].length;
		expect(arms).toBe(3); // app open, visibilitychange, online
		expect(bake).not.toMatch(/setInterval\([^)]*noteFireArrival/);
	});

	it("arms on connectivity returning — THE field moment", () => {
		// refreshFires bails immediately while offline, so without an `online`
		// listener the first chance to catch up is the next tick, which then finds
		// a "fresh" record and skips. This is the arrival the TTL gets most wrong.
		expect(bake).toMatch(/addEventListener\("online"/);
	});
});

/**
 * ⛔ PEEK vs CONSUME — the bug that let a phone sit on 6-hour-old data.
 *
 * `ensure()` has THREE call sites racing for one flag: the idle boot pass,
 * `style.load`, and the pan debounce. Whichever fired first CONSUMED the
 * arrival and then frequently decided it had nothing to do — so the debt was
 * marked paid before the call that would actually have fetched ran. The result
 * in the field: `Last checked — 5h ago` with the app sitting open.
 */
describe("peek vs settle — the debt survives until a fetch happens", () => {
	it("peek does NOT consume", () => {
		noteFireArrival();
		expect(peekFireArrival("map")).toBe(true);
		expect(peekFireArrival("map")).toBe(true);
		expect(peekFireArrival("map")).toBe(true);
	});

	it("three racing gates all still see the debt", () => {
		// THE BUG, as a test: idle boot, style.load and the pan debounce each ask.
		// Under the old consume-on-read, only the first saw `true`.
		noteFireArrival();
		const idleBoot = peekFireArrival("map");
		const styleLoad = peekFireArrival("map");
		const panSettle = peekFireArrival("map");
		expect([idleBoot, styleLoad, panSettle]).toEqual([true, true, true]);
	});

	it("settle clears it — so one arrival still means ONE fetch", () => {
		noteFireArrival();
		expect(peekFireArrival("map")).toBe(true);
		settleFireArrival("map");
		expect(peekFireArrival("map")).toBe(false);
	});

	it("settling the map does not settle the bake service", () => {
		// The two readers cover different ground and owe separately.
		noteFireArrival();
		settleFireArrival("map");
		expect(peekFireArrival("bake")).toBe(true);
		expect(takeFireArrival("bake")).toBe(true);
	});

	it("settling twice is harmless", () => {
		noteFireArrival();
		settleFireArrival("map");
		settleFireArrival("map");
		expect(peekFireArrival("map")).toBe(false);
	});
});
