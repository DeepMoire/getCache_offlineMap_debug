/**
 * staticHeatSources.test.ts — the refinery problem.
 *
 * The reported failure: a bulk tank farm on the Fraser River read as a wildfire
 * beside Vancouver, every day, forever. These tests pin the rule that fixes it
 * and — just as importantly — the rule that a flagged detection is never
 * DELETED, because a refinery genuinely can catch fire.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CELL_DEG,
	INDUSTRIAL_LABEL,
	PERSIST_DAYS,
	buildMask,
	cellKey,
	isStaticSource,
	partitionStatic,
} from "./staticHeatSources";

/** The measured real case: a Richmond BC cell detected on 14 distinct days
 *  between April and August 2026, while genuine fires nearby showed 1–4. */
const TANK_FARM: [number, number] = [-123.015, 49.0987];
const WILDFIRE: [number, number] = [-121.5, 50.3];

const day = (n: number) => `2026-0${1 + Math.floor(n / 28)}-${String((n % 28) + 1).padStart(2, "0")}`;

describe("buildMask — persistence is what separates a flare from a fire", () => {
	it("flags a cell seen on many distinct days", () => {
		const detections = Array.from({ length: PERSIST_DAYS }, (_, i) => ({
			lng: TANK_FARM[0],
			lat: TANK_FARM[1],
			day: day(i),
		}));
		const mask = buildMask(detections);
		expect(mask.has(cellKey(...TANK_FARM))).toBe(true);
	});

	it("does NOT flag a real fire that burned hard for a few days", () => {
		// A genuine wildfire can hammer the same cell for a week. That must stay
		// a fire — this is the false-positive that would matter most.
		const detections = Array.from({ length: PERSIST_DAYS - 1 }, (_, i) => ({
			lng: WILDFIRE[0],
			lat: WILDFIRE[1],
			day: day(i),
		}));
		expect(buildMask(detections).size).toBe(0);
	});

	it("counts DISTINCT DAYS, not detections", () => {
		// One day, 200 passes over the same cell (multiple satellites, edge of
		// swath) is still ONE day. Counting rows instead of days would flag every
		// large fire on its first afternoon.
		const detections = Array.from({ length: 200 }, () => ({
			lng: WILDFIRE[0],
			lat: WILDFIRE[1],
			day: "2026-07-04",
		}));
		expect(buildMask(detections).size).toBe(0);
	});

	it("keeps unrelated cells independent", () => {
		const detections = [
			...Array.from({ length: PERSIST_DAYS }, (_, i) => ({
				lng: TANK_FARM[0], lat: TANK_FARM[1], day: day(i),
			})),
			...Array.from({ length: 3 }, (_, i) => ({
				lng: WILDFIRE[0], lat: WILDFIRE[1], day: day(i),
			})),
		];
		const mask = buildMask(detections);
		expect(mask.has(cellKey(...TANK_FARM))).toBe(true);
		expect(mask.has(cellKey(...WILDFIRE))).toBe(false);
	});

	it("handles an empty archive without flagging the world", () => {
		expect(buildMask([]).size).toBe(0);
	});
});

describe("isStaticSource — a pixel wanders between passes", () => {
	const mask = new Set([cellKey(...TANK_FARM)]);

	it("matches the exact cell", () => {
		expect(isStaticSource(TANK_FARM[0], TANK_FARM[1], mask)).toBe(true);
	});

	it("matches a NEIGHBOURING cell — the same flare, seen slightly off", () => {
		// Viewing angle and swath position move a detection a few hundred metres
		// between passes. Exact-cell matching alone would let the same stack
		// through about half the time.
		expect(
			isStaticSource(TANK_FARM[0] + CELL_DEG, TANK_FARM[1] + CELL_DEG, mask),
		).toBe(true);
	});

	it("does NOT match two cells away", () => {
		expect(
			isStaticSource(TANK_FARM[0] + CELL_DEG * 4, TANK_FARM[1], mask),
		).toBe(false);
	});

	it("does not match a genuine fire elsewhere", () => {
		expect(isStaticSource(WILDFIRE[0], WILDFIRE[1], mask)).toBe(false);
	});

	it("flags NOTHING when the mask failed to load", () => {
		// A missing asset must never silently hide real fires. Empty mask =
		// everything is a fire, which is the safe direction.
		expect(isStaticSource(TANK_FARM[0], TANK_FARM[1], new Set())).toBe(false);
	});
});

describe("partitionStatic — FLAG, never DELETE", () => {
	const mask = new Set([cellKey(...TANK_FARM)]);
	const detections = [
		{ coordinates: TANK_FARM },
		{ coordinates: WILDFIRE },
		{ coordinates: [-120.0, 51.0] as [number, number] },
	];

	it("separates industrial from wildfire", () => {
		const { wildfire, industrial } = partitionStatic(detections, mask);
		expect(industrial).toHaveLength(1);
		expect(wildfire).toHaveLength(2);
	});

	it("KEEPS the flagged detection — a refinery can genuinely catch fire", () => {
		// This is the rule that matters most. Hard-deleting would mean the app
		// says nothing on the day Burnaby's refinery actually goes up.
		const { wildfire, industrial } = partitionStatic(detections, mask);
		expect(wildfire.length + industrial.length).toBe(detections.length);
		expect(industrial[0].coordinates).toEqual(TANK_FARM);
	});

	it("treats everything as wildfire when the mask is empty", () => {
		const { wildfire, industrial } = partitionStatic(detections, new Set());
		expect(wildfire).toHaveLength(3);
		expect(industrial).toHaveLength(0);
	});
});

describe("the label states a fact, it does not apologise", () => {
	it("names what the source IS", () => {
		expect(INDUSTRIAL_LABEL).toBe("Industrial heat source");
		expect(INDUSTRIAL_LABEL.toLowerCase()).not.toContain("maybe");
		expect(INDUSTRIAL_LABEL.toLowerCase()).not.toContain("not a");
	});
});

// ⚠️ ONLINE MAP MOVED TO THE CHILD, 28 Aug 2026. This block read
// src/routes/(getcache)/map/fireLayer.ts as TEXT. That whole folder — 32 files,
// 10,873 lines — was a SECOND online map beside getCache_OnlineMap's, and it was
// deleted; /map is now a two-line address rendering the child's component, the
// same operation /offline had on 27 Aug.
//
// The law this asserts (ONE fire layer, no per-route re-implementation) is now
// enforced STRUCTURALLY: a route that is an import and a tag has nowhere to put
// a second copy. That is the deeper wall this grep was standing in for.
//
// ⛔ DO NOT DELETE. The fire RENDER layer has no home yet — it is in neither
// child (verified 28 Aug: no ids.outline / attachFireLayer outside the deleted
// folder). When it lands in getCache_OnlineMap, RE-POINT AT IT AND UNSKIP.
describe.skip("ONE fire layer, ONE feature builder — no second implementation", () => {
	// The drift this catches, which actually happened twice: the online and
	// offline routes each hand-rolled the same walk (wall, age stamp,
	// prominence). When `ind` (the industrial flag) was added it went into ONE
	// of them; later the city rule nearly did the same. It was invisible in the
	// field only because the mask asset hadn't shipped yet.
	//
	// Both maps now share `attachFireLayer`, which is the structural fix — but
	// "shared" is only true until someone re-adds a local copy. These assertions
	// make that regression fail loudly rather than silently.
	// Orphaned by the map move — see the note above. "" keeps the skipped
	// block collectable instead of throwing at import.
	const layer = "";
// ⚠️ OFFLINE V5 REBUILD: the v4 offline route + bake service were deleted
// (branch offline-v5, tag offline-v4-final). These guards assert the OFFLINE
// map does not grow its own fire implementation — still the right law, but it
// has no route to read until v5 lands its viewer. RE-POINT AT THE V5 ROUTE
// AND UNSKIP; do not delete, this guard caught real drift.
	const offline = "";

	it("the shared layer builds features through fireFeatureCollection", () => {
		expect(layer).toContain("fireFeatureCollection(");
	});

	it("the shared layer applies BOTH the industrial flag and the city rule", () => {
		// One place, so both maps get them by construction.
		expect(layer).toContain("isStatic:");
		expect(layer).toContain("isUrban:");
	});

	// ⚠️ OFFLINE V5: no offline route to read until v5 lands its viewer. Unskip then.
	it.skip("the offline route DELEGATES the painting rather than re-implementing it", () => {
		expect(offline).toContain("attachFireLayer");
		// The tell of a hand-rolled copy coming back: stamping feature properties
		// itself. (The route MAY call fireFeatureCollection for its stamp count —
		// that is the shared builder, which is the point.)
		expect(offline).not.toMatch(/properties\s*as[^;]*\)\.ageH\s*=/);
		expect(offline).not.toContain("props.ageH =");
	});

	it("the offline route has NO hotspot-count stamp of its own", () => {
		// Stronger than the rule this replaced. There used to be a
		// "11156 hotspots · 3h ago" caption on the offline map and NOT on
		// /mobile/map — a one-map-only extra, which is exactly what "use the same
		// component" is meant to make impossible. The count of satellite pixels
		// is not a fact anyone acts on, and a caption on one map and not the
		// other IS the two maps disagreeing, just in a new costume.
		//
		// The old test allowed the stamp so long as it counted via the shared
		// builder. Deleting it removes the whole class of drift instead.
		expect(offline).not.toContain("fire-stamp");
		expect(offline).not.toContain("hotspot{");
		expect(offline).not.toContain("fireAgeLabel");
		// And with no stamp, the route derives nothing about fires at all.
		expect(offline).not.toContain("relevantHotspots(");
		expect(offline).not.toContain("fireFeatureCollection(");
	});

	it("nothing repaints without waiting for the exclusion assets", () => {
		// A first paint that beats the urban polygons renders city hotspots and
		// then leaves them there — exactly the bug the city rule exists to kill.
		expect(layer).toContain("loadUrban()");
	});
});
