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
		expect(takeFireArrival("bake")).toBe(false);
		expect(takeFireArrival("map")).toBe(false);
	});

	it("arms on arrival", () => {
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
	});

	it("is CONSUMED, not merely read", () => {
		noteFireArrival();
		expect(takeFireArrival("bake")).toBe(true);
		expect(takeFireArrival("bake")).toBe(false);
		expect(takeFireArrival("bake")).toBe(false);
	});

	it("coalesces — arriving twice before a pass is still ONE refresh each", () => {
		noteFireArrival();
		noteFireArrival();
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
		expect(takeFireArrival("map")).toBe(false);
	});

	it("re-arms on the NEXT arrival", () => {
		noteFireArrival();
		takeFireArrival("map");
		noteFireArrival();
		expect(takeFireArrival("map")).toBe(true);
	});

	/** ⛔ the two readers must stay separate — one flag consumed by whoever asked first let the bake service's 20s tick eat the map's refresh before ensure() ran, so the disc under the user's eyes never updated. */
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

/** ⛔ both fetch paths must arm from the same TTL — arming only one fixes one map and leaves the other showing stale dots (WILDFIRE_LAYER.md). */
describe.skip("both fetch paths honour the arrival", () => {
	// ⚠️ skipped for the v5 rebuild (v4 offline route/bake service deleted) — re-point at v5's route and unskip; do NOT delete, this guard caught real drift.
	const bake = "";
	const layer = "";

	it("the bake service consumes the flag AS THE BAKE READER", () => {
		expect(bake).toContain('takeFireArrival("bake")');
	});

	it("the bake service's TTL gate yields to it", () => {
		expect(bake).toMatch(/fireIsFresh\(prev\)\s*&&\s*!onDemand/);
	});

	it("the bake service's GEOGRAPHIC gate yields to it too", () => {
		expect(bake).toMatch(/!onDemand\s*&&\s*!needsFireDisc/);
	});

	it("the online map PEEKS the flag as the MAP reader, and settles it", () => {
		expect(layer).toContain('peekFireArrival("map")');
		expect(layer).toContain('settleFireArrival("map")');
	});

	it("settles only AFTER a fetch is actually attempted", () => {
		const at = layer.indexOf('settleFireArrival("map")');
		const fetchAt = layer.indexOf("await fetchAreaFires(");
		expect(at).toBeGreaterThan(0);
		expect(fetchAt - at).toBeGreaterThan(0);
		expect(fetchAt - at).toBeLessThan(400);
	});

	it("the two paths use DIFFERENT reader ids", () => {
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
		// guards against turning an hourly fetch into a permanent poll — only the three arrival moments may arm; never the interval.
		const arms = [...bake.matchAll(/noteFireArrival\(\)/g)].length;
		expect(arms).toBe(3); // app open, visibilitychange, online
		expect(bake).not.toMatch(/setInterval\([^)]*noteFireArrival/);
	});

	it("arms on connectivity returning — THE field moment", () => {
		expect(bake).toMatch(/addEventListener\("online"/);
	});
});

/** ⛔ peek vs consume — ensure() has THREE racing call sites; consuming on first read marked the debt paid before any of them actually fetched, so the phone sat on 6h-old data. */
describe("peek vs settle — the debt survives until a fetch happens", () => {
	it("peek does NOT consume", () => {
		noteFireArrival();
		expect(peekFireArrival("map")).toBe(true);
		expect(peekFireArrival("map")).toBe(true);
		expect(peekFireArrival("map")).toBe(true);
	});

	it("three racing gates all still see the debt", () => {
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
