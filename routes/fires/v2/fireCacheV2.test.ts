/**
 * fireCacheV2.test.ts — the safety surface and the cost ceiling.
 */

import { describe, expect, it } from "vitest";
import {
	FIRE_V2_RADIUS_KM,
	FIRE_V2_TTL_MS,
	FIRE_V2_VERSION,
	type FireDiscV2,
	fireAgeLabelV2,
	fireDiscKey,
	isFreshV2,
} from "./fireCacheV2";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const disc = (over: Partial<FireDiscV2> = {}): FireDiscV2 => ({
	version: FIRE_V2_VERSION,
	fetchedAt: NOW,
	center: [-121.78, 49.3],
	radiusKm: FIRE_V2_RADIUS_KM,
	sourcesOk: 3,
	pointsJson: '{"type":"FeatureCollection","features":[]}',
	clustersJson: '{"type":"FeatureCollection","features":[]}',
	outlinesJson: '{"type":"FeatureCollection","features":[]}',
	pointCount: 0,
	...over,
});

describe("the stored shape is STRINGS, not objects — the whole v2 premise", () => {
	it("keeps render payloads as serialized strings", () => {
		const d = disc();
		expect(typeof d.pointsJson).toBe("string");
		expect(typeof d.clustersJson).toBe("string");
		expect(typeof d.outlinesJson).toBe("string");
	});

	it("carries the point COUNT as a scalar so the UI never parses the payload", () => {
		// "0 fires here" must be answerable without deserializing anything — the one fact about contents the phone needs.
		const d = disc({ pointCount: 412 });
		expect(d.pointCount).toBe(412);
	});

	it("parses to something Mapbox can consume directly", () => {
		// The stored string must BE a FeatureCollection — paint hands the parse result straight to setData().
		const parsed = JSON.parse(disc().pointsJson) as GeoJSON.FeatureCollection;
		expect(parsed.type).toBe("FeatureCollection");
		expect(Array.isArray(parsed.features)).toBe(true);
	});

	it("holds ONE heap object per collection regardless of detection count", () => {
		const many = JSON.stringify({
			type: "FeatureCollection",
			features: Array.from({ length: 40_000 }, (_, i) => ({
				type: "Feature",
				geometry: { type: "Point", coordinates: [-121 + i * 1e-5, 49] },
				properties: { frp: 5 },
			})),
		});
		const d = disc({ pointsJson: many, pointCount: 40_000 });
		expect(typeof d.pointsJson).toBe("string");
		expect(d.pointCount).toBe(40_000);
	});
});

describe("freshness — the phone TTL is SHORT on purpose", () => {
	it("is fresh inside the TTL", () => {
		expect(isFreshV2({ fetchedAt: NOW - MIN }, NOW)).toBe(true);
	});

	it("is stale past the TTL", () => {
		// Derived from FIRE_V2_TTL_MS, not hardcoded — guards the stale/fresh BOUNDARY without needing edits when the TTL is tuned.
		expect(isFreshV2({ fetchedAt: NOW - FIRE_V2_TTL_MS - MIN }, NOW)).toBe(
			false,
		);
	});

	it("is minutes, not an hour", () => {
		// Two one-hour caches COMPOUND, not overlap ("Last checked — 5h ago" bug) — what must NOT drift is the gap to the edge hour.
		expect(FIRE_V2_TTL_MS).toBeLessThanOrEqual(30 * MIN);
		expect(FIRE_V2_TTL_MS).toBeGreaterThanOrEqual(MIN);
	});

	it("leaves room for an arrival-driven refresh well before the edge expires", () => {
		// TTL only governs an app held continuously foregrounded; the three ARRIVAL moments (open, visible again, back online) bypass it.
		expect(FIRE_V2_TTL_MS).toBeLessThanOrEqual(HOUR / 2);
	});

	it("is well under the edge cache's hour, so the two cannot compound", () => {
		expect(FIRE_V2_TTL_MS).toBeLessThan(HOUR);
	});
});

describe("fireAgeLabelV2 — safety copy, not a debug string", () => {
	it("says 'no fire data' for a null stamp rather than implying freshness", () => {
		// The dangerous failure is a blank map reading as "no fires near you".
		expect(fireAgeLabelV2(null, NOW)).toBe("no fire data");
	});

	it("reads in plain English across the ranges", () => {
		expect(fireAgeLabelV2(NOW - 30_000, NOW)).toBe("just now");
		expect(fireAgeLabelV2(NOW - 20 * MIN, NOW)).toBe("20 min ago");
		expect(fireAgeLabelV2(NOW - 3 * HOUR, NOW)).toBe("3h ago");
		expect(fireAgeLabelV2(NOW - 26 * HOUR, NOW)).toBe("yesterday");
		expect(fireAgeLabelV2(NOW - 72 * HOUR, NOW)).toBe("3 days ago");
	});

	it("never reports a negative age from clock skew", () => {
		// A phone behind the server's clock would otherwise render "in 3 minutes" at exactly the moment it matters most.
		expect(fireAgeLabelV2(NOW + 5 * MIN, NOW)).toBe("just now");
	});
});

describe("the disc key — stable under GPS jitter", () => {
	it("rounds to the same ~11 m cell the rest of the offline system uses", () => {
		// A moving user must not mint a new disc every few paces — that was how v1 accumulated discs faster than it could evict them.
		expect(fireDiscKey([-121.78001, 49.30001])).toBe(
			fireDiscKey([-121.78002, 49.30002]),
		);
	});

	it("distinguishes genuinely different centres", () => {
		expect(fireDiscKey([-121.78, 49.3])).not.toBe(fireDiscKey([-121.79, 49.3]));
	});
});

describe("the radius stays at 500 km", () => {
	it("is the smoke shed, not the block", () => {
		// Cut to 300 in v1 to stop the layer dominating the map — that failed, like shrinking circles/filtering to the screen box: all three threw away downloaded info for a RENDER problem.
		expect(FIRE_V2_RADIUS_KM).toBe(500);
	});
});
