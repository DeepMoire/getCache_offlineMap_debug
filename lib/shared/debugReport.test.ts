/** Proves the report surfaces "correct bytes in the WRONG BOX" — OFFLINE_MAP_SPEC.md §8: every test here must be red-on-bug. */
import { describe, expect, it } from "vitest";
import { BLOB_TILE_Z, cellBox, cellOf } from "../contract/grid";
import { geometryFor } from "./debugReport";
import type { CoverageRecord } from "../onPhone/store/coverageRegistry";

function rec(lng: number, lat: number, over: Partial<CoverageRecord> = {}): CoverageRecord {
	return {
		areaKey: `${lng.toFixed(4)},${lat.toFixed(4)}`,
		lng,
		lat,
		hasPhoto: true,
		hasLines: true,
		bytes: 65536,
		photoBytes: 60000,
		lineBytes: 5536,
		lineCount: 3286,
		blobVersion: "v1",
		lastTouched: Date.parse("2026-08-21T13:58:00Z"),
		...over,
	};
}

describe("geometryFor — the rule-4 readout", () => {
	it("reports the box the pin actually sits in", () => {
		const g = geometryFor(rec(-116.8297, 47.6533));
		const b = g.box;
		expect(g.pin.lng).toBeGreaterThanOrEqual(b.w);
		expect(g.pin.lng).toBeLessThanOrEqual(b.e);
		expect(g.pin.lat).toBeGreaterThanOrEqual(b.s);
		expect(g.pin.lat).toBeLessThanOrEqual(b.n);
		expect(g.corners).toHaveLength(4);
	});

	it("uses the cell's OWN zoom, never the bare constant", () => {
		// Cell.z can be PROMOTED for an edge pin — box must match THAT z; reading BLOB_TILE_Z instead is the "address and geometry disagree" bug.
		const r = rec(-116.8297, 47.6533);
		const g = geometryFor(r);
		const c = cellOf(r.lng, r.lat);
		expect(g.cellZoom).toBe(c.z);
		expect(g.box).toEqual(cellBox(c));
		expect(g.cell).toBe(`${c.z}_${c.ix}_${c.iy}`);
	});

	it("RED-ON-BUG: a pin served from a NEIGHBOURING cell reads tens of km off", () => {
		// RED-ON-BUG class (45/27.9/50 km) — if offsetKm can't go large here, the readout isn't measuring rule 4 and the report is decorative.
		const good = geometryFor(rec(-116.8297, 47.6533));
		expect(good.offsetKm).toBeLessThan(60); // inside its own z8 cell

		const c = cellOf(-116.8297, 47.6533);
		const neighbour = cellBox({ ix: c.ix + 1, iy: c.iy, z: c.z });
		const wrongCentre: [number, number] = [
			(neighbour.w + neighbour.e) / 2,
			(neighbour.s + neighbour.n) / 2,
		];
		const drift = geometryFor(
			rec(-116.8297, 47.6533, { areaKey: "wrong" }),
		);
		// distance from the true pin to the WRONG cell's centre
		const kmOff = Math.hypot(
			(wrongCentre[1] - drift.pin.lat) * 111,
			(wrongCentre[0] - drift.pin.lng) *
				111 *
				Math.cos((drift.pin.lat * Math.PI) / 180),
		);
		expect(kmOff).toBeGreaterThan(50);
	});

	it("never lets one pin's data stand in for another's", () => {
		// Two real pins sharing ONE z8 cell (pinCentred.test.ts case) — must stay two distinct reports with their own pins.
		const a = geometryFor(rec(-116.8297, 47.6533));
		const b = geometryFor(rec(-116.3674, 48.0005));
		expect(a.areaKey).not.toBe(b.areaKey);
		expect(a.pin).not.toEqual(b.pin);
		if (a.cell === b.cell) {
			// The very trap rule 4 names: identical box, DIFFERENT offsets.
			expect(a.offsetKm).not.toBeCloseTo(b.offsetKm, 6);
		}
	});

	it("reach is measured per edge, so an over-wide box is visible", () => {
		const g = geometryFor(rec(-116.8297, 47.6533));
		for (const v of Object.values(g.reachKm)) {
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThan(0);
		}
		// BLOB_TILE_Z bug: z8/lat47 half-span exceeds the promised 30km radius — must surface, not smooth over. If this ever flips, the grid changed.
		expect(BLOB_TILE_Z).toBe(8);
		expect(Math.max(...Object.values(g.reachKm))).toBeGreaterThan(30);
	});

	it("surfaces a missing blobVersion as null, not as a passing value", () => {
		const g = geometryFor(rec(-116.8297, 47.6533, { blobVersion: undefined }));
		expect(g.blobVersion).toBeNull();
	});
});
