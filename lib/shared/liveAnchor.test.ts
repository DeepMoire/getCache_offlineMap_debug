import { describe, expect, it } from "vitest";
import {
	FIRE_TRIGGER_KM,
	MAP_COVERAGE_KM,
	MAP_TRIGGER_KM,
	isUsableFix,
	kmToNearest,
	needsFireDisc,
	needsMapBlob,
	snapLiveAnchor,
} from "./liveAnchor";
import { BAKE_RADIUS_KM } from "../onPhone/satellite/satelliteImage";
import { FIRE_RADIUS_KM } from "./fireContract";
import type { LngLat } from "./kmGeo";

// A block in the Ottawa valley — the repo's usual test locale.
const BLOCK: LngLat = [-76.3, 45.2];

/** Move km due north; ~111 km/° is exact enough for threshold tests without a projection. */
function north(from: LngLat, km: number): LngLat {
	return [from[0], from[1] + km / 111.32];
}

describe("the trigger radii come from real blob geometry", () => {
	it("triggers a new map blob INSIDE the coverage it already has", () => {
		expect(MAP_TRIGGER_KM).toBeLessThan(MAP_COVERAGE_KM);
	});

	it("triggers a fire refetch INSIDE the disc it already has", () => {
		expect(FIRE_TRIGGER_KM).toBeLessThan(FIRE_RADIUS_KM);
	});

	it("uses a far wider trigger for fires than for maps", () => {
		// if these ever converge, every new map blob drags a 500 km fire fetch behind it.
		expect(FIRE_TRIGGER_KM).toBeGreaterThan(MAP_TRIGGER_KM * 5);
	});
});

describe("needsMapBlob — the anti-thrash rule", () => {
	it("bakes on the FIRST fix, when nothing is covered yet", () => {
		expect(needsMapBlob(BLOCK, [])).toBe(true);
	});

	it("does NOT re-bake for an 11 m step — THE bug this module exists for", () => {
		// 11m = one satImageKey cell; feeding it raw would mint a new area + a fresh photo + fire disc download.
		const elevenMetres = north(BLOCK, 0.011);
		expect(needsMapBlob(elevenMetres, [BLOCK])).toBe(false);
	});

	it("does not re-bake while pacing a block all day", () => {
		for (const km of [0.05, 0.2, 0.5, 1, 1.4]) {
			expect(needsMapBlob(north(BLOCK, km), [BLOCK])).toBe(false);
		}
	});

	it("still does not re-bake just short of the trigger", () => {
		expect(needsMapBlob(north(BLOCK, MAP_TRIGGER_KM - 1), [BLOCK])).toBe(false);
	});

	it("bakes once past the trigger — a move to a new camp", () => {
		expect(needsMapBlob(north(BLOCK, MAP_TRIGGER_KM + 1), [BLOCK])).toBe(true);
	});

	it("counts FEATURE coverage, so standing by your own pin bakes nothing", () => {
		// the planter's own pin already anchors a blob; must not mint a second one metres away.
		const pin: LngLat = north(BLOCK, 0.3);
		expect(needsMapBlob(BLOCK, [pin])).toBe(false);
	});

	it("measures from the NEAREST centre, not the first or the last", () => {
		const faraway: LngLat = north(BLOCK, 500);
		const close: LngLat = north(BLOCK, 0.5);
		expect(needsMapBlob(BLOCK, [faraway, close])).toBe(false);
		expect(needsMapBlob(BLOCK, [close, faraway])).toBe(false);
	});

	it("does not re-bake on a long loop that returns inside coverage", () => {
		// naive distance-MOVED logic would re-fire repeatedly on this ~5km loop; distance-from-COVERAGE does not.
		const walk = [0.4, 1, 1.4, 1, 0.4, 0].map((km) => north(BLOCK, km));
		for (const step of walk) {
			expect(needsMapBlob(step, [BLOCK])).toBe(false);
		}
	});

	it("DOES bake for a slow crawl that leaves coverage", () => {
		// mirror failure: distance-moved logic w/ a 30km threshold never fires on a slow 5km drift; containment does.
		const crawl = north(BLOCK, MAP_TRIGGER_KM + 5);
		expect(needsMapBlob(crawl, [BLOCK])).toBe(true);
	});
});

describe("THE DARKNESS BUG — containment must mean PHOTO, not roads", () => {
	// THE DARKNESS BUG: containment measured against the 40km road ring, not the 2km photo — users 2–30km out were "covered" and blind.
	it("bakes when you are outside the PHOTO, even if roads reach you", () => {
		expect(needsMapBlob(north(BLOCK, 10), [BLOCK])).toBe(true);
	});

	it("bakes for a user near the permanent Ottawa demo blob", () => {
		// demo blob (MAP_HOME_CENTER) is always noted; every Ottawa-region user was silently swallowed by it and never got their own.
		const demo: LngLat = [-76.16797958683314, 45.061348227515055];
		const userNearby = north(demo, 12);
		expect(needsMapBlob(userNearby, [demo])).toBe(true);
	});

	it("keeps the trigger inside the PHOTO radius, not the road radius", () => {
		expect(MAP_TRIGGER_KM).toBeLessThan(BAKE_RADIUS_KM);
	});
});

describe("needsFireDisc — geography only", () => {
	it("pulls a disc on the first fix", () => {
		expect(needsFireDisc(BLOCK, [])).toBe(true);
	});

	it("does NOT refetch for a move that earns a new MAP blob", () => {
		// 30 km is a new map blob but is nothing to a 500 km smoke shed.
		const moved = north(BLOCK, MAP_TRIGGER_KM + 5);
		expect(needsMapBlob(moved, [BLOCK])).toBe(true);
		expect(needsFireDisc(moved, [BLOCK])).toBe(false);
	});

	it("does not refetch across a whole season at one camp", () => {
		for (const km of [1, 10, 50, 100, 200, 300]) {
			expect(needsFireDisc(north(BLOCK, km), [BLOCK])).toBe(false);
		}
	});

	it("refetches after a genuine relocation", () => {
		expect(needsFireDisc(north(BLOCK, FIRE_TRIGGER_KM + 10), [BLOCK])).toBe(
			true,
		);
	});
});

describe("kmToNearest", () => {
	it("is Infinity with no coverage, so the first fix always triggers", () => {
		expect(kmToNearest(BLOCK, [])).toBe(Number.POSITIVE_INFINITY);
	});

	it("is zero at a centre", () => {
		expect(kmToNearest(BLOCK, [BLOCK])).toBeCloseTo(0, 5);
	});
});

describe("snapLiveAnchor — the belt-and-braces key guard", () => {
	it("collapses nearby fixes onto ONE coordinate", () => {
		// belt-and-braces: even if a future edit routes raw fixes past containment, the key space stays bounded.
		const a = snapLiveAnchor(BLOCK);
		const b = snapLiveAnchor(north(BLOCK, 0.011));
		expect(b).toEqual(a);
	});

	it("separates genuinely distant fixes", () => {
		const a = snapLiveAnchor(BLOCK);
		const b = snapLiveAnchor(north(BLOCK, 200));
		expect(b).not.toEqual(a);
	});

	it("never emits -0, which would key differently from 0 as a string", () => {
		const [lng, lat] = snapLiveAnchor([-0.01, -0.01]);
		expect(Object.is(lng, -0)).toBe(false);
		expect(Object.is(lat, -0)).toBe(false);
	});
});

describe("isUsableFix — junk must never reach the bake pass", () => {
	it("accepts a real fix", () => {
		expect(isUsableFix(BLOCK)).toBe(true);
	});

	it("rejects null island — a zeroed struct, not a location", () => {
		expect(isUsableFix([0, 0])).toBe(false);
	});

	it("rejects NaN, out-of-range, and malformed input", () => {
		expect(isUsableFix([Number.NaN, 45])).toBe(false);
		expect(isUsableFix([-76, 91])).toBe(false);
		expect(isUsableFix([-181, 45])).toBe(false);
		expect(isUsableFix([-76])).toBe(false);
		expect(isUsableFix(null)).toBe(false);
		expect(isUsableFix("-76,45")).toBe(false);
	});
});
