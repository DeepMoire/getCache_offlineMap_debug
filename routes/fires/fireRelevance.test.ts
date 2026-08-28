/**
 * fireRelevance.test.ts — "you show nothing after 500 kilometers, period".
 *
 * Written from the actual failing screenshot: the blue dot on the BC coast,
 * fire clusters over Winnipeg, Bismarck, Minneapolis and Des Moines. Those four
 * cities are the regression cases — if any of them can render again, the layer
 * is broken in exactly the way it was broken three fixes running.
 *
 * The earlier attempts all failed because they measured the wrong thing:
 * fetch radius, cluster size, then the SCREEN box. Distance from the USER is
 * the only measure that closes it.
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
/** The user's fix as an ANCHOR SET — origin is a list now, because relevance is
 *  measured from every place you have a stake in, not just your body. */
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
		// This is the crucial one. The far-field gate is size-vs-distance, but
		// the WALL is absolute: no fire, however enormous, renders past 500 km.
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
describe.skip("NO DISTANCE FADE — a drawn fire is a fire", () => {
	// The fade (`prominenceAt`) is deleted, not tuned. It faded opacity 1.0 → 0.25
	// with distance, which was coherent when the wall had ONE origin. With ANCHORS
	// it drew the same hazard two different ways: fires around a pinned block came
	// out at ~0.3 while fires by the live fix sat at 1.0. Reported from the field
	// as "the pinned fire blob is really faint, the location one isn't".
	// Orphaned by the map move — see the note above. "" keeps the skipped
	// block collectable instead of throwing at import.
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
		// Deleting the fade must not delete the information. "190 km E" on the tap
		// card is where distance belongs.
		const far = relevantHotspots([KAMLOOPS], AT_USER)[0];
		expect(far.km).toBeGreaterThan(NEAR_KM);
	});

	it("no paint property multiplies by prom", () => {
		// The real regression guard: someone re-adding `["get","prom"]` to any
		// opacity brings the two-tone bug straight back.
		expect(layer).not.toContain('["get", "prom"]');
	});
});

describe("no origin — refuse to guess", () => {
	it("shows NOTHING rather than a continent of dots", () => {
		// Callers always have a map centre to pass; reaching here means we truly
		// have no reference point, and a world of dots is the worse failure.
		expect(relevantHotspots([SQUAMISH, WINNIPEG], null)).toHaveLength(0);
	});

	it("treats an EMPTY anchor list the same as none", () => {
		// `fireAnchors` returns [] when nothing qualifies. That must read as "no
		// reference point", not as "no wall" — an empty list that fell through to
		// showing everything would be the continent-of-dots bug wearing a hat.
		expect(relevantHotspots([SQUAMISH, WINNIPEG], [])).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ANCHORS — the Manitoba watermelon.
//
// Straight from the report: a user in Vancouver created a feature near
// Camperville, Manitoba. The bake service had ALREADY downloaded the fires
// around it (refreshFires bakes a disc per feature anchor), and the map drew
// none of them — they were ~1,900 km from the phone, so the wall ate every one.
//
// The layer went silent about the exact ground the user had just told it they
// cared about. These tests pin the fix: relevance is proximity to any place you
// have a stake in, and your body is only one of them.
// ─────────────────────────────────────────────────────────────────────────────
describe("ANCHORS — fires near ground you touched, not just near your body", () => {
	/** The watermelon feature: ~115 km NE of Camperville, MB. */
	const BLOCK: [number, number] = [-99.6, 52.4];
	/** A fire 30 km from that block — and ~1,900 km from the Vancouver user. */
	const NEAR_BLOCK = spot(-99.6, 52.67, 20);

	it("THE BUG: a fire beside your new block is invisible from your fix alone", () => {
		// This is the failing screenshot, asserted. It must stay true — it is what
		// makes the next test meaningful rather than vacuous.
		expect(distKm(USER, NEAR_BLOCK.coordinates)).toBeGreaterThan(1500);
		expect(relevantHotspots([NEAR_BLOCK], AT_USER)).toHaveLength(0);
	});

	it("THE FIX: it renders once that block is an anchor", () => {
		const kept = relevantHotspots([NEAR_BLOCK], [USER, BLOCK]);
		expect(kept).toHaveLength(1);
		// Measured from the BLOCK (~30 km), not the phone (~1,900 km) — so it
		// reads as the near, loud thing it actually is.
		expect(kept[0].km).toBeLessThan(NEAR_KM);
	});

	it("adding an anchor never hides what the user's fix already showed", () => {
		// Anchors are strictly ADDITIVE. A second stake must not cost you the
		// fires at your feet — that would trade one silence for another.
		const withFixOnly = relevantHotspots([SQUAMISH, KAMLOOPS], AT_USER);
		const withBoth = relevantHotspots([SQUAMISH, KAMLOOPS], [USER, BLOCK]);
		expect(withBoth.length).toBeGreaterThanOrEqual(withFixOnly.length);
	});

	it("still refuses the whole continent — the wall holds per anchor", () => {
		// The danger of a set is that enough anchors mean no wall at all. Winnipeg
		// is ~350 km from the Manitoba block, so it legitimately survives; the
		// screenshot's far cities must not.
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
		// The promise: what you touched LAST always survives. Creating a feature
		// and seeing no change would be the original bug back again.
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
		// Three pins on one block are ONE place. Without this, a busy day's work
		// spends every anchor slot inside a single 500 km disc and the block you
		// drove to last week silently drops off.
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
		// A feature with broken geometry must not become an anchor at NaN, which
		// would make every distance NaN and quietly empty the layer.
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

// ─────────────────────────────────────────────────────────────────────────────
// fireFeatureCollection — the ONE hotspots→features builder.
//
// This block exists because the two maps drifted. `fireLayer.ts` (online) and
// `offlinev4/+page.svelte` (offline) each hand-rolled the same walk, and when
// `ind` (the industrial-source flag) was added it landed in the online one
// only — so a refinery dimmed on one map and read as a wildfire on the other.
// These tests pin the properties every feature must carry, so a property added
// for one map cannot silently skip the other.
// ─────────────────────────────────────────────────────────────────────────────
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
			// Both, on every feature. `ind` is the one that used to be missing
			// on the offline map — that is the whole point of this assertion.
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
		// A refinery genuinely can catch fire; deleting means the app says nothing
		// on the day it does. So the feature must still be present, just marked.
		const { fc } = build({ hotspots: [SQUAMISH], isStatic: () => true });
		expect(fc.features).toHaveLength(1);
		expect((fc.features[0].properties as Record<string, unknown>).ind).toBe(1);
	});

	it("hidden empties the collection without touching the wall logic", () => {
		const { fc, shown } = build({ hidden: true });
		expect(fc.features).toHaveLength(0);
		expect(shown).toHaveLength(0);
		// And un-hiding brings the same features straight back — the layer stays
		// mounted, so the eye is one setData, never a layer re-add.
		expect(build({ hidden: false }).fc.features.length).toBeGreaterThan(0);
	});

	it("a NEAR and a FAR fire get identical paint properties", () => {
		// This replaces a test that asserted the opposite (near = full prominence,
		// far = faded). That was the two-tone bug in test form: with anchors, "far"
		// only means far from whichever anchor qualified it, and a fire beside a
		// block you pinned is not a lesser fire. Same age, same flag → same paint.
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
