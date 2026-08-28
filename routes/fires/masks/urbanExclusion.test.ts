/**
 * urbanExclusion.test.ts — no wildfires inside the city.
 *
 * Pinned against the REAL polygons that ship (`worldBase/base/min/urban.json`)
 * and the REAL coordinates that kept appearing on the map beside Vancouver.
 *
 * The convention this enforces is not ours: BC Wildfire's own public map shows
 * fires in the mountains north-east of Chilliwack and leaves the entire
 * Vancouver / Richmond / Delta / Surrey basin empty, even though FIRMS reports
 * hotspots there every day. Every serious wildfire map does the same.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	URBAN_BUFFER_KM,
	isUrban,
	kmToRing,
	pointInRing,
	prepareUrban,
} from "./urbanExclusion";

// This child's own static/, populated by ./fetchAssets.sh (see ASSETS.md).
// Absent in a bare clone → the suite SKIPS, visibly, rather than passing on
// nothing or naming a parent's static/ as a location.
const URBAN = fileURLToPath(
	new URL("../../../static/mobileAssets/worldBase/base/min/urban.json", import.meta.url),
);
const HAVE_ASSETS = existsSync(URBAN);
const fc = (
	HAVE_ASSETS ? JSON.parse(readFileSync(URBAN, "utf8")) : { features: [] }
) as { features: { geometry: { type: string; coordinates: unknown } }[] };

const polys = prepareUrban(fc.features);
const describeAssets = describe.skipIf(!HAVE_ASSETS);

describeAssets("the shipped urban polygons load", () => {
	it("has world coverage, not a stub", () => {
		expect(polys.length).toBeGreaterThan(5000);
	});
});

describeAssets("the four Vancouver false alarms — the reported case", () => {
	// Every one of these appeared as a "fire" on the map. Two are the tank farm
	// (14 and 8 detection-days over a year); two are the marker the user tapped
	// last, at 9 and 8 days — real industrial persistence that sat UNDER the
	// archive rule's 12-day threshold, which is exactly why geography had to
	// become the primary filter.
	const cases: [string, number, number][] = [
		["tank farm A", -123.015, 49.0987],
		["tank farm B", -123.0187, 49.0987],
		["marker cell A", -123.0037, 49.1587],
		["marker cell B", -123.0225, 49.1437],
	];

	for (const [name, lng, lat] of cases) {
		it(`excludes ${name}`, () => {
			expect(isUrban(lng, lat, polys)).toBe(true);
		});
	}
});

describeAssets("real wildfires are NOT excluded", () => {
	it("keeps a fire in deep BC bush", () => {
		expect(isUrban(-125.5, 54.0, polys)).toBe(false);
	});

	it("keeps a fire in the mountains NE of Chilliwack", () => {
		// Where BC Wildfire's own map DOES plot fires, in the user's screenshot.
		expect(isUrban(-121.5, 49.6, polys)).toBe(false);
	});

	it("keeps a fire beside a small town like Whitecourt", () => {
		// Small towns are not mapped as urban areas, so planting country beside
		// them stays visible. This is the case that would hurt most if lost.
		expect(isUrban(-115.68, 54.15, polys)).toBe(false);
	});

	it("keeps a fire in the middle of nowhere", () => {
		expect(isUrban(-130, 57, polys)).toBe(false);
	});
});

describeAssets("it works OUTSIDE North America — this is a world rule", () => {
	// The archive-persistence approach needed a year of history per region and
	// only ever covered western Canada. Geography ships everywhere at once.
	const cities: [string, number, number][] = [
		["London", -0.1276, 51.5074],
		["Tokyo", 139.6917, 35.6895],
		["São Paulo", -46.6333, -23.5505],
		["Sydney", 151.2093, -33.8688],
		["Lagos", 3.3792, 6.5244],
	];
	for (const [name, lng, lat] of cities) {
		it(`excludes ${name}`, () => {
			expect(isUrban(lng, lat, polys)).toBe(true);
		});
	}

	it("keeps the Amazon", () => {
		expect(isUrban(-60, -5, polys)).toBe(false);
	});

	it("keeps the Australian outback", () => {
		expect(isUrban(133, -25, polys)).toBe(false);
	});
});

describeAssets("the buffer", () => {
	it("is 5 km — measured, not guessed", () => {
		// At 0 km only ONE of the four Vancouver false alarms was caught; the
		// urban polygons hug the built-up core and industrial land sits in the
		// fringe just outside. At 5 km all four were caught with no wanted fire
		// lost. Don't raise it casually: every extra km eats real bush.
		expect(URBAN_BUFFER_KM).toBe(5);
	});

	it("a zero buffer misses the tank farm — proving the buffer is load-bearing", () => {
		expect(isUrban(-123.015, 49.0987, polys, 0)).toBe(false);
		expect(isUrban(-123.015, 49.0987, polys, 5)).toBe(true);
	});
});

describe("fails toward SHOWING fires", () => {
	it("excludes nothing when the asset failed to load", () => {
		// A half-loaded asset must never suppress a real fire.
		expect(isUrban(-123.12, 49.28, [], 5)).toBe(false);
	});
});

describe("geometry primitives", () => {
	const square: number[][] = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	];

	it("pointInRing is inclusive of the interior", () => {
		expect(pointInRing(0.5, 0.5, square)).toBe(true);
		expect(pointInRing(1.5, 0.5, square)).toBe(false);
	});

	it("kmToRing measures a sane distance", () => {
		// ~1 degree of latitude north of the top edge ≈ 110 km.
		const d = kmToRing(0, 2, square);
		expect(d).toBeGreaterThan(100);
		expect(d).toBeLessThan(120);
	});

	it("prepareUrban skips non-polygons rather than throwing", () => {
		const prepared = prepareUrban([
			{ geometry: { type: "LineString", coordinates: [] } },
			{ geometry: { type: "Polygon", coordinates: [square] } },
		]);
		expect(prepared).toHaveLength(1);
	});
});
