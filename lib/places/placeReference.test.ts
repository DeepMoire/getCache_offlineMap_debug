/**
 * placeReference.test.ts
 * ⚠️ A reversed bearing is 180° wrong and reads perfectly plausible — direction is asserted in words.
 */
import { describe, expect, it } from "vitest";
import {
	AT_PLACE_KM,
	TIER_MAJOR,

	TIER_TOWN,
	TIER_VILLAGE,
	regionNear,
	bearing16,
	blockReference,
	distanceKm,
	locationLine,
	nearestInTier,
	placeReference,
	roundKm,
	type PlaceRow,
} from "./placeReference";

const WHITECOURT: PlaceRow = ["Whitecourt", -115.6855, 54.1501, TIER_TOWN, "Alberta"];
const EDSON: PlaceRow = ["Edson", -116.4356, 53.5834, TIER_TOWN, "Alberta"];
const EDMONTON: PlaceRow = ["Edmonton", -113.4687, 53.5501, TIER_MAJOR, "Alberta"];
const BLUE_RIDGE: PlaceRow = ["Blue Ridge", -115.4167, 54.15, TIER_VILLAGE, "Alberta"];
const KAMLOOPS: PlaceRow = ["Kamloops", -120.3192, 50.6665, TIER_MAJOR, "British Columbia"];

const AB: PlaceRow[] = [WHITECOURT, EDSON, EDMONTON, BLUE_RIDGE, EDMONTON];

describe("bearing16 — the direction must be from the PLACE to the FIRE", () => {
	it("reads NE when the point is north-east of the place", () => {
		expect(bearing16([-115.68, 54.15], [-115.4, 54.3])).toBe("NE");
	});

	it("reads SW for the reverse — catches a flipped origin", () => {
		expect(bearing16([-115.4, 54.3], [-115.68, 54.15])).toBe("SW");
	});

	it("resolves the 16 points, not just 8", () => {
		expect(bearing16([0, 0], [0, 1])).toBe("N");
		expect(bearing16([0, 0], [1, 0])).toBe("E");
		expect(bearing16([0, 0], [0, -1])).toBe("S");
		expect(bearing16([0, 0], [-1, 0])).toBe("W");
		// A shallow north-north-east must NOT collapse to plain NE.
		expect(bearing16([0, 0], [0.2, 1])).toBe("NNE");
	});

	it("handles the ANTIMERIDIAN without spinning the compass", () => {
		// 179.9°E → 179.9°W is a short hop EAST, not a trip most of the way round.
		expect(bearing16([179.9, 0], [-179.9, 0])).toBe("E");
		expect(bearing16([-179.9, 0], [179.9, 0])).toBe("W");
	});

	it("survives a pole without producing NaN", () => {
		const b = bearing16([0, 89.9], [10, 89.95]);
		expect(typeof b).toBe("string");
		expect(b.length).toBeGreaterThan(0);
	});
});

describe("distanceKm — the antimeridian is a short hop", () => {
	it("measures across 180° the SHORT way", () => {
		// ~22 km at the equator, not ~40,000.
		expect(distanceKm([179.9, 0], [-179.9, 0])).toBeLessThan(30);
	});

	it("agrees with a known distance", () => {
		// Whitecourt → Edmonton ≈ 145 km.
		const km = distanceKm([-115.6855, 54.1501], [-113.4687, 53.5501]);
		expect(km).toBeGreaterThan(130);
		expect(km).toBeLessThan(165);
	});
});

describe("roundKm — precision the data supports", () => {
	it("rounds to 1 km under 100", () => {
		expect(roundKm(18.4)).toBe(18);
		expect(roundKm(99.6)).toBe(100);
	});

	it("rounds to 10 km above 100", () => {
		expect(roundKm(142)).toBe(140);
		expect(roundKm(147)).toBe(150);
	});
});

describe("the cascade — small town first, city as the anchor", () => {
	it("names the SMALL town and anchors on something bigger", () => {
		// ~9 km east of Blue Ridge.
		const r = placeReference([-115.28, 54.15], AB);
		expect(r.primary?.name).toBe("Blue Ridge");
		// Anchor is a TOWN not MAJOR, so the province is appended.
		expect(r.text).toMatch(
			/^\d+ km \w+ of Blue Ridge, \d+ km \w+ of (Whitecourt|Edson), Alberta$/,
		);
	});

	it("falls through to a MID town when no small one is in range", () => {
		// Right beside Whitecourt, with Blue Ridge removed from the dataset.
		const noSmall = AB.filter((p) => p[0] !== "Blue Ridge");
		const r = placeReference([-115.5, 54.28], noSmall);
		expect(r.primary?.name).toBe("Whitecourt");
	});

	it("never names the same place twice", () => {
		const r = placeReference([-115.68, 54.16], AB);
		const names = [r.primary?.name, r.anchor?.name].filter(Boolean);
		expect(new Set(names).size).toBe(names.length);
	});

	it("anchors only on a LARGER tier, never a smaller one", () => {
		const r = placeReference([-115.28, 54.15], AB);
		if (r.anchor && r.primary) {
			expect(r.anchor.tier).toBeLessThan(r.primary.tier);
		}
	});
});

describe("inside a town", () => {
	it("says 'at' rather than '0 km of'", () => {
		const r = placeReference([-120.3192, 50.6665], [KAMLOOPS]);
		expect(r.text).toBe("at Kamloops");
		expect(r.text).not.toContain("0 km");
	});

	it("uses 'at' for anything under the AT_PLACE threshold", () => {
		// ~1 km away.
		const r = placeReference([-120.31, 50.6665], [KAMLOOPS]);
		expect(distanceKm([-120.31, 50.6665], [-120.3192, 50.6665])).toBeLessThan(
			AT_PLACE_KM,
		);
		expect(r.text).toBe("at Kamloops");
	});
});

describe("roadless — nothing within any tier's radius", () => {
	it("falls back to coordinates when even a province is out of reach", () => {
		// Middle of the Pacific — thousands of km from anything in AB.
		const r = placeReference([-150, 30], AB);
		expect(r.primary).toBeNull();
		expect(r.text).toBe("30.0000, -150.0000");
	});

	it("prefers the PROVINCE over coordinates when one is within reach", () => {
		// ~330 km south of Edmonton — past the MAJOR tier's 250 km radius, but inside REGION_ANCHOR_KM.
		const r = placeReference([-113.4687, 50.58], [EDMONTON]);
		expect(r.primary).toBeNull();
		expect(r.text).toBe("Alberta");
	});

	it("does NOT reach past a tier's radius to find something", () => {
		// 400 km from Edmonton — beyond even the LARGE tier's 150 km.
		const r = placeReference([-113.4687, 50.0], [EDMONTON]);
		expect(r.primary).toBeNull();
	});
});

describe("sparse coverage — a lone big city and nothing else", () => {
	it("uses the city when it's the only thing in range", () => {
		const r = placeReference([-120.5, 51.2], [KAMLOOPS]);
		expect(r.primary?.name).toBe("Kamloops");
		expect(r.anchor).toBeNull();
		// No province suffix — Kamloops is MAJOR, so it'd be redundant.
		expect(r.text).toMatch(/^\d+ km \w+ of Kamloops$/);
	});
});

describe("nearestInTier — respects both tier and radius", () => {
	it("ignores places in other tiers", () => {
		const hit = nearestInTier([-115.28, 54.15], AB, TIER_VILLAGE, 25);
		expect(hit?.name).toBe("Blue Ridge");
	});

	it("returns null when the nearest is outside the radius", () => {
		expect(nearestInTier([-115.28, 54.15], AB, TIER_VILLAGE, 1)).toBeNull();
	});
});

describe("the user's own block wins — 'your Sundance block'", () => {
	const blocks = [
		{ name: "Sundance", coordinates: [-115.5, 54.2] as [number, number] },
	];

	it("beats any town name when the detection is near it", () => {
		const line = locationLine([-115.7, 54.35], AB, blocks);
		expect(line).toMatch(/^\d+ km \w+ of your Sundance block$/);
	});

	it("says 'at your … block' when you're standing in it", () => {
		expect(blockReference([-115.5, 54.2], blocks)).toBe("at your Sundance block");
	});

	it("falls back to the world cascade when the block is far away", () => {
		const line = locationLine([-120.3192, 50.6665], [KAMLOOPS], blocks);
		expect(line).toBe("at Kamloops");
	});

	it("returns null with no blocks at all", () => {
		expect(blockReference([-115.5, 54.2], [])).toBeNull();
	});
});

describe("the high-level anchor — 'I don't know what Hamilton means'", () => {
	// Regression guard: neighbourhood names (GeoNames PPLX) and a missing province fallback both read as "named a place nobody recognises".
	const YALE: PlaceRow = ["Yale", -121.4333, 49.5667, TIER_VILLAGE, "British Columbia"];
	const CHILLIWACK: PlaceRow = ["Chilliwack", -121.9526, 49.1664, TIER_MAJOR, "British Columbia"];

	it("appends the province when the biggest name is only a village or town", () => {
		const r = placeReference([-121.43, 49.62], [YALE]);
		expect(r.text).toMatch(/^\d+ km \w+ of Yale, British Columbia$/);
	});

	it("does NOT append the province when a MAJOR city is already named", () => {
		// Redundant — everyone can place Vancouver.
		const r = placeReference([-121.95, 49.4], [CHILLIWACK]);
		expect(r.text).toMatch(/of Chilliwack$/);
		expect(r.text).not.toContain("British Columbia");
	});

	it("always yields at least one recognisable reference", () => {
		// City anchor carries recognition, so no province needed.
		const r = placeReference([-121.5, 49.4], [YALE, CHILLIWACK]);
		expect(r.text).toContain("Chilliwack");
	});
});

describe("regionNear — the province of the nearest known place", () => {
	it("finds it across a wide radius", () => {
		expect(regionNear([-115.0, 54.0], AB)).toBe("Alberta");
	});

	it("returns null when nothing is remotely close", () => {
		expect(regionNear([-150, 30], AB)).toBeNull();
	});
});

describe("distance overrules prominence when the gap is large", () => {
	// Regression: smallest-tier-first ignored distance — a village 20 km away beat a city 3 km away ("20 km SE of Bowen Island" from downtown).
	const VANCOUVER: PlaceRow = ["Vancouver", -123.1193, 49.2497, TIER_MAJOR, "British Columbia"];
	const BOWEN: PlaceRow = ["Bowen Island", -123.3667, 49.3833, TIER_VILLAGE, "British Columbia"];

	it("names the CITY you are standing in, not a distant village", () => {
		const r = placeReference([-123.12, 49.28], [VANCOUVER, BOWEN]);
		expect(r.primary?.name).toBe("Vancouver");
		expect(r.text).not.toContain("Bowen");
	});

	it("still prefers the nearby VILLAGE when it is genuinely the closest", () => {
		// Far from downtown — the small name must still win here.
		const r = placeReference([-123.36, 49.39], [VANCOUVER, BOWEN]);
		expect(r.primary?.name).toBe("Bowen Island");
	});
});

describe("suburb suppression is a DATA rule, not a code rule", () => {
	it("documents why feature codes alone cannot fix it", () => {
		// Feature codes can't separate suburbs from towns (GeoNames tags them all plain PPL) — the build's 12km-of-MAJOR geometric rule does; see placeIndex.ts.
		expect(TIER_MAJOR).toBe(0);
	});
});
