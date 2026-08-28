/**
 * assetRegion — THE WORLD ASSETS MUST NOT BE HELD WHOLE.
 *
 * places-world.json (6.2 MB, ~100k rows) and urban.json (4.4 MB, 11,878
 * polygons) were parsed whole and retained for the session. JSON.parse boxes
 * every [lng,lat] pair into a V8 array object (~80-100 bytes to carry 16 bytes
 * of numbers), so the two together sat around ~100 MB resident — to answer
 * questions about hotspots that are, by the fire layer's own 500 km relevance
 * wall, near the user.
 *
 * These tests pin the WINDOW: out-of-region data is dropped at parse time, and
 * — the part that actually frees memory — the expensive ring is never retained
 * for a polygon outside it.
 */

import { describe, expect, it } from "vitest";
import {
	bboxInRegion,
	DEFAULT_REGION_KM,
	inRegion,
	regionAround,
	regionChanged,
} from "../../../lib/shared/assetRegion";
import { isUrban, prepareUrban } from "./urbanExclusion";

/** Roughly the Pasayten Wilderness, WA — the user's actual map. */
const PASAYTEN: [number, number] = [-120.6, 48.9];

/** A square urban polygon centred on a point, as prepareUrban expects it. */
function urbanFeatureAt(lng: number, lat: number, deg = 0.05) {
	return {
		geometry: {
			type: "Polygon",
			coordinates: [
				[
					[lng - deg, lat - deg],
					[lng + deg, lat - deg],
					[lng + deg, lat + deg],
					[lng - deg, lat + deg],
					[lng - deg, lat - deg],
				],
			],
		},
	};
}

describe("assetRegion — the window", () => {
	it("keeps the region in play and drops the far side of the planet", () => {
		const box = regionAround(PASAYTEN);
		expect(inRegion(box, -120.6, 48.9)).toBe(true); // home
		expect(inRegion(box, -123.1, 49.3)).toBe(true); // Vancouver — same window
		expect(inRegion(box, 72.9, 19.1)).toBe(false); // Mumbai
		expect(inRegion(box, 2.35, 48.86)).toBe(false); // Paris — same LATITUDE, must still go
	});

	it("keeps a window wide enough that distant fires still get place names", () => {
		// The whole point of a 1,500 km window rather than a 500 km one: a place
		// name matters MOST for the fire you cannot see out the window.
		const box = regionAround(PASAYTEN);
		expect(inRegion(box, -114.07, 51.05)).toBe(true); // Calgary, ~700 km
		expect(inRegion(box, -122.7, 45.5)).toBe(true); // Portland, ~380 km
	});

	it("widens the longitude span at high latitude to stay a constant km", () => {
		// Degrees of longitude shrink toward the poles; a fixed degree box would
		// silently narrow to a sliver in the north, where planting happens.
		const south = regionAround([-120, 20]);
		const north = regionAround([-120, 65]);
		expect(north.e - north.w).toBeGreaterThan(south.e - south.w);
	});
});

describe("regionChanged — hysteresis, not jitter", () => {
	it("treats a never-loaded window as changed", () => {
		expect(regionChanged(null, PASAYTEN)).toBe(true);
	});

	it("does NOT reload for movement inside the region", () => {
		// A reload re-parses ~6 MB. Driving across the block, or GPS jitter, must
		// never trigger it — that would be worse than not windowing at all.
		expect(regionChanged(PASAYTEN, [-120.61, 48.91])).toBe(false);
		expect(regionChanged(PASAYTEN, [-122.0, 49.5])).toBe(false);
	});

	it("DOES reload once the user has genuinely left the region", () => {
		// Washington → Ontario. Different continent-half; the retained gazetteer
		// no longer covers where they are.
		expect(regionChanged(PASAYTEN, [-76.3, 45.25])).toBe(true);
	});

	it("reloads only past half the window's half-width", () => {
		const box = DEFAULT_REGION_KM;
		expect(regionChanged(PASAYTEN, PASAYTEN, box)).toBe(false);
	});
});

describe("prepareUrban — the ring is never retained out of region", () => {
	it("drops out-of-region polygons entirely", () => {
		const feats = [
			urbanFeatureAt(-120.5, 48.8), // near home
			urbanFeatureAt(72.9, 19.1), // Mumbai
			urbanFeatureAt(2.35, 48.86), // Paris
		];
		const kept = prepareUrban(feats, regionAround(PASAYTEN));
		expect(kept).toHaveLength(1);
		// THE MEMORY ASSERTION: the survivor is the local one, and the two dropped
		// polygons left no ring behind. Retaining a ring is the entire cost.
		expect(kept[0].minX).toBeLessThan(-119);
	});

	it("keeps the whole world when no region is given (the safe fallback)", () => {
		// A wrongly-windowed asset silently stops excluding city hotspots, so the
		// no-region path must stay lossless.
		const feats = [urbanFeatureAt(-120.5, 48.8), urbanFeatureAt(72.9, 19.1)];
		expect(prepareUrban(feats)).toHaveLength(2);
		expect(prepareUrban(feats, null)).toHaveLength(2);
	});

	it("still excludes a city hotspot after windowing — same verdict, less memory", () => {
		// The whole justification for the window is that it changes NOTHING about
		// the answers in region. A dot in the local city is still urban.
		const feats = [urbanFeatureAt(-120.5, 48.8), urbanFeatureAt(72.9, 19.1)];
		const windowed = prepareUrban(feats, regionAround(PASAYTEN));
		const whole = prepareUrban(feats);
		expect(isUrban(-120.5, 48.8, windowed)).toBe(true);
		expect(isUrban(-120.5, 48.8, whole)).toBe(true);
		// And open country is still not urban, either way.
		expect(isUrban(-120.0, 48.0, windowed)).toBe(isUrban(-120.0, 48.0, whole));
	});

	it("keeps a polygon straddling the window edge", () => {
		// bbox OVERLAP, not centre-containment: a city on the boundary must not be
		// half-dropped, or hotspots on its far side stop being excluded.
		const box = regionAround(PASAYTEN);
		expect(bboxInRegion(box, box.e - 0.1, PASAYTEN[1], box.e + 5, PASAYTEN[1]))
			.toBe(true);
		expect(bboxInRegion(box, box.e + 1, PASAYTEN[1], box.e + 5, PASAYTEN[1]))
			.toBe(false);
	});
});
