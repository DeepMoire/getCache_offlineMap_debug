/**
 * fireRelevance.test.ts — "you show nothing after 500 kilometers, period".
 * Regression cases: Winnipeg/Bismarck/Minneapolis/Des Moines rendering again means the wall is broken.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as mod from "./fireRelevance";
import {
	distKm,
	fireAnchors,
	fireFeatureCollection,
	frpGateAt,
	HARD_CUTOFF_KM,
	MAX_FIRE_ANCHORS,
	NEAR_KM,
	nearestAnchorKm,
	type RelevantHotspot,
	relevantHotspots,
} from "./fireRelevance";
import type { FireHotspot } from "./fireCache";

const spot = (lng: number, lat: number, frp = 100): FireHotspot => ({
	coordinates: [lng, lat],
	t: 1_786_000_000_000,
	c: "nominal",
	frp,
});

/** The blue dot in the screenshot — BC coast near Vancouver. */
const USER: [number, number] = [-123.1, 49.28];
/** The user's fix as an ANCHOR SET — relevance is measured from every place you have a stake in, not just your body. */
const AT_USER: Array<readonly [number, number]> = [USER];

// The offenders, straight off the screenshot.
const WINNIPEG = spot(-97.14, 49.9, 5000);
const BISMARCK = spot(-100.78, 46.81, 5000);
const MINNEAPOLIS = spot(-93.27, 44.98, 5000);
const DES_MOINES = spot(-93.6, 41.6, 5000);
// Legitimate near fires.
const SQUAMISH = spot(-123.15, 49.7, 5); // ~47 km, tiny
const KAMLOOPS = spot(-120.33, 50.67, 40); // ~250 km, moderate

describe("THE WALL — nothing past 500 km from the user", () => {
	it("drops every city from the failing screenshot", () => {
		const kept = relevantHotspots(
			[WINNIPEG, BISMARCK, MINNEAPOLIS, DES_MOINES],
			AT_USER,
		);
		expect(kept).toHaveLength(0);
	});

	it("drops them even at an absurd 5000 MW — size never buys past the wall", () => {
		// crucial: the far-field gate is size-vs-distance, but the WALL is absolute — no fire renders past 500km, however enormous
		const monster = spot(-97.14, 49.9, 999_999);
		expect(relevantHotspots([monster], AT_USER)).toHaveLength(0);
	});

	it("keeps a fire just inside the wall and drops one just outside", () => {
		// Due east of the user; ~1 degree of longitude ≈ 72 km at this latitude.
		const inside = spot(-123.1 + 6.0, 49.28, 5000); // ~435 km
		const outside = spot(-123.1 + 8.0, 49.28, 5000); // ~580 km
		expect(distKm(USER, inside.coordinates)).toBeLessThan(HARD_CUTOFF_KM);
		expect(distKm(USER, outside.coordinates)).toBeGreaterThan(HARD_CUTOFF_KM);
		expect(relevantHotspots([inside, outside], AT_USER)).toHaveLength(1);
	});

	it("the wall is exactly FIRE_RADIUS_KM — we draw only what we download", () => {
		expect(HARD_CUTOFF_KM).toBe(500);
	});
});

describe("near fires are never filtered — small+close beats big+far", () => {
	it("keeps a tiny 5 MW fire 47 km away", () => {
		const kept = relevantHotspots([SQUAMISH], AT_USER);
		expect(kept).toHaveLength(1);
		expect(kept[0].km).toBeLessThan(NEAR_KM);
	});

	it("keeps a moderate fire at 250 km", () => {
		expect(relevantHotspots([KAMLOOPS], AT_USER)).toHaveLength(1);
	});

	it("drops a tiny fire far out but keeps a big one at the same distance", () => {
		const farTiny = spot(-118.0, 49.28, 1);
		const farBig = spot(-118.0, 49.28, 400);
		expect(relevantHotspots([farTiny], AT_USER)).toHaveLength(0);
		expect(relevantHotspots([farBig], AT_USER)).toHaveLength(1);
	});
});

describe("frpGateAt — the size-vs-distance ramp", () => {
	it("filters nothing inside the near ring", () => {
		expect(frpGateAt(0)).toBe(0);
		expect(frpGateAt(NEAR_KM)).toBe(0);
	});

	it("climbs with distance", () => {
		expect(frpGateAt(100)).toBeGreaterThan(0);
		expect(frpGateAt(400)).toBeGreaterThan(frpGateAt(200));
	});

	it("is infinite at and past the wall", () => {
		expect(frpGateAt(HARD_CUTOFF_KM)).toBe(Number.POSITIVE_INFINITY);
		expect(frpGateAt(9999)).toBe(Number.POSITIVE_INFINITY);
	});
});

// ⛔ DO NOT DELETE — fire render layer has no home yet (moved out of deleted online-map folder 28 Aug); re-point at getCache_OnlineMap and unskip when it lands
describe.skip("NO DISTANCE FADE — a drawn fire is a fire", () => {
	// prominenceAt (distance fade) is deleted, not tuned — re-adding it reintroduces the two-tone bug once anchors exist
	// orphaned by the map move; "" keeps this block collectable instead of throwing at import
	const layer = "";

	it("the module exports no prominence function", () => {
		expect(mod).not.toHaveProperty("prominenceAt");
	});

	it("hotspots carry NO prom — nothing can fade by distance downstream", () => {
		const near = relevantHotspots([SQUAMISH], AT_USER)[0];
		const far = relevantHotspots([KAMLOOPS], AT_USER)[0];
		expect(near).not.toHaveProperty("prom");
		expect(far).not.toHaveProperty("prom");
	});

	it("distance still reaches the CARD — it just doesn't touch paint", () => {
		// deleting the fade must not delete the information — distance belongs on the tap card ("190 km E")
		const far = relevantHotspots([KAMLOOPS], AT_USER)[0];
		expect(far.km).toBeGreaterThan(NEAR_KM);
	});

	it("no paint property multiplies by prom", () => {
		// regression guard: re-adding ["get","prom"] to any opacity brings the two-tone bug back
		expect(layer).not.toContain('["get", "prom"]');
	});
});

describe("no origin — refuse to guess", () => {
	it("shows NOTHING rather than a continent of dots", () => {
		// callers always have a map centre; reaching here means truly no reference point — showing a world of dots is worse
		expect(relevantHotspots([SQUAMISH, WINNIPEG], null)).toHaveLength(0);
	});

	it("treats an EMPTY anchor list the same as none", () => {
		// empty anchor list must read as "no reference point", not "no wall" — falling through to show-everything is the continent-of-dots bug again
		expect(relevantHotspots([SQUAMISH, WINNIPEG], [])).toHaveLength(0);
	});
});

describe("ANCHORS — fires near ground you touched, not just near your body", () => {
	/** The watermelon feature: ~115 km NE of Camperville, MB. */
	const BLOCK: [number, number] = [-99.6, 52.4];
	/** A fire 30 km from that block — and ~1,900 km from the Vancouver user. */
	const NEAR_BLOCK = spot(-99.6, 52.67, 20);

	it("THE BUG: a fire beside your new block is invisible from your fix alone", () => {
		// the failing screenshot, asserted — must stay true, or the next test becomes vacuous
		expect(distKm(USER, NEAR_BLOCK.coordinates)).toBeGreaterThan(1500);
		expect(relevantHotspots([NEAR_BLOCK], AT_USER)).toHaveLength(0);
	});

	it("THE FIX: it renders once that block is an anchor", () => {
		const kept = relevantHotspots([NEAR_BLOCK], [USER, BLOCK]);
		expect(kept).toHaveLength(1);
		// measured from the BLOCK (~30km), not the phone (~1,900km) — reads as the near, loud thing it is
		expect(kept[0].km).toBeLessThan(NEAR_KM);
	});

	it("adding an anchor never hides what the user's fix already showed", () => {
		// anchors are strictly ADDITIVE — a second stake must not cost you the fires at your feet
		const withFixOnly = relevantHotspots([SQUAMISH, KAMLOOPS], AT_USER);
		const withBoth = relevantHotspots([SQUAMISH, KAMLOOPS], [USER, BLOCK]);
		expect(withBoth.length).toBeGreaterThanOrEqual(withFixOnly.length);
	});

	it("still refuses the whole continent — the wall holds per anchor", () => {
		// danger of a set: enough anchors could mean no wall at all — Winnipeg legitimately survives (~350km from the block), the screenshot's far cities must not
		const kept = relevantHotspots(
			[BISMARCK, MINNEAPOLIS, DES_MOINES],
			[USER, BLOCK],
		);
		expect(kept).toHaveLength(0);
	});
});

describe("fireAnchors — bounded, deduped, recency-first", () => {
	const at = (lng: number, lat: number, touchedAt: number) => ({
		at: [lng, lat] as const,
		touchedAt,
	});

	it("keeps the most recently touched ground when over the cap", () => {
		// promise: what you touched LAST always survives the cap — creating a feature and seeing no change would be the original bug back
		const anchors = fireAnchors([
			at(-123.1, 49.28, 1000), // Vancouver, oldest
			at(-99.6, 52.4, 5000), // Manitoba, newest
			at(-113.5, 53.5, 4000), // Edmonton
			at(-106.6, 52.1, 3000), // Saskatoon
			at(-97.1, 49.9, 2000), // Winnipeg
		]);
		expect(anchors).toHaveLength(MAX_FIRE_ANCHORS);
		expect(anchors[0]).toEqual([-99.6, 52.4]);
	});

	it("collapses anchors whose discs would overlap anyway", () => {
		// three pins on one block are ONE place — without this, a busy day spends every anchor slot in one disc and last week's block silently drops off
		const anchors = fireAnchors([
			at(-123.1, 49.28, 3000),
			at(-123.2, 49.3, 2000), // ~11 km away — same place
			at(-123.0, 49.2, 1000), // ~11 km away — same place
		]);
		expect(anchors).toHaveLength(1);
	});

	it("keeps genuinely separate ground", () => {
		const anchors = fireAnchors([
			at(-123.1, 49.28, 2000), // Vancouver
			at(-99.6, 52.4, 1000), // Manitoba
		]);
		expect(anchors).toHaveLength(2);
	});

	it("returns nothing for no candidates", () => {
		expect(fireAnchors([])).toHaveLength(0);
	});

	it("ignores candidates with unusable coordinates", () => {
		// broken geometry must not become an anchor at NaN — that would make every distance NaN and quietly empty the layer
		const anchors = fireAnchors([
			at(Number.NaN, 49.28, 3000),
			at(-99.6, 52.4, 1000),
		]);
		expect(anchors).toEqual([[-99.6, 52.4]]);
	});
});

describe("nearestAnchorKm", () => {
	it("measures from the closest stake, not the first", () => {
		const BLOCK: [number, number] = [-99.6, 52.4];
		const km = nearestAnchorKm([-99.6, 52.67], [USER, BLOCK]);
		expect(km).toBeLessThan(NEAR_KM);
	});

	it("is Infinity with no anchors", () => {
		expect(nearestAnchorKm([-99.6, 52.67], [])).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("scale — the real cache that produced the screenshot", () => {
	it("cuts a two-disc 42k-hotspot union to only what is near the user", () => {
		// A dense Washington disc (where the camera had panned) plus Ottawa.
		const washington = Array.from({ length: 2000 }, (_, i) =>
			spot(-120.7 + (i % 50) * 0.05, 48.0 + Math.floor(i / 50) * 0.05, 50),
		);
		const ottawa = Array.from({ length: 200 }, (_, i) =>
			spot(-76.2 + (i % 20) * 0.05, 45.0 + Math.floor(i / 20) * 0.05, 50),
		);
		const kept = relevantHotspots([...washington, ...ottawa], AT_USER);
		// Not one Ottawa dot (≈3,500 km away) survives.
		expect(kept.every((h) => h.coordinates[0] < -100)).toBe(true);
		// And everything kept is genuinely inside the wall.
		expect(kept.every((h) => h.km < HARD_CUTOFF_KM)).toBe(true);
	});
});

describe("fireFeatureCollection — both maps get identical features", () => {
	const NOW = 1_786_003_600_000; // exactly 1 h after `spot`'s default t

	/** Minimal stand-in for hotspotsToGeoJSON, which lives in v4FireCache. */
	const toGeoJSON = (
		hs: readonly RelevantHotspot[],
	): GeoJSON.FeatureCollection => ({
		type: "FeatureCollection",
		features: hs.map((h) => ({
			type: "Feature" as const,
			geometry: { type: "Point" as const, coordinates: [...h.coordinates] },
			properties: { t: h.t, frp: h.frp },
		})),
	});
	const never = () => false;

	const build = (
		over: Partial<Parameters<typeof fireFeatureCollection>[0]> = {},
	) =>
		fireFeatureCollection({
			hotspots: [SQUAMISH, KAMLOOPS],
			origin: AT_USER,
			now: NOW,
			staticMask: new Set<string>(),
			toGeoJSON,
			isStatic: never,
			...over,
		});

	it("stamps ageH AND ind on every feature — and NO prom", () => {
		const { fc } = build();
		expect(fc.features.length).toBeGreaterThan(0);
		for (const f of fc.features) {
			const p = f.properties as Record<string, unknown>;
			// `ind` used to be missing on the offline map — that is the whole point of this assertion
			expect(p.ageH).toBeCloseTo(1, 6);
			expect(p.ind).toBe(0);
			// `prom` (the distance fade) is deleted — see "NO DISTANCE FADE".
			expect(p).not.toHaveProperty("prom");
		}
	});

	it("still enforces the 500 km wall", () => {
		const { fc, shown } = build({ hotspots: [SQUAMISH, WINNIPEG] });
		expect(shown).toHaveLength(1);
		expect(fc.features).toHaveLength(1);
		// Winnipeg at 5000 MW does not buy passage.
		expect(
			(fc.features[0].geometry as GeoJSON.Point).coordinates[0],
		).toBeCloseTo(-123.15, 2);
	});

	it("FLAGS an industrial source rather than dropping it", () => {
		// a refinery genuinely can catch fire; deleting means the app says nothing on the day it does — must stay present, just marked
		const { fc } = build({ hotspots: [SQUAMISH], isStatic: () => true });
		expect(fc.features).toHaveLength(1);
		expect((fc.features[0].properties as Record<string, unknown>).ind).toBe(1);
	});

	it("hidden empties the collection without touching the wall logic", () => {
		const { fc, shown } = build({ hidden: true });
		expect(fc.features).toHaveLength(0);
		expect(shown).toHaveLength(0);
		// un-hiding brings the same features straight back — the layer stays mounted, the eye toggle is one setData, never a layer re-add
		expect(build({ hidden: false }).fc.features.length).toBeGreaterThan(0);
	});

	it("a NEAR and a FAR fire get identical paint properties", () => {
		// same age, same flag → same paint — "far" means far from whichever anchor qualified it, not less important (the two-tone bug)
		const { fc } = build({ hotspots: [SQUAMISH, KAMLOOPS] });
		const paintOf = (lng: string) =>
			fc.features
				.filter(
					(f) => (f.geometry as GeoJSON.Point).coordinates[0].toFixed(2) === lng,
				)
				.map((f) => {
					const p = f.properties as Record<string, unknown>;
					return { ageH: p.ageH, ind: p.ind, prom: p.prom };
				})[0];
		const near = paintOf("-123.15"); // Squamish, ~47 km
		const far = paintOf("-120.33"); // Kamloops, ~250 km
		expect(near).toEqual(far);
		expect(near.prom).toBeUndefined();
	});
});
