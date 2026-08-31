// ⛔ derive the budget from BLOB_DETAIL_LEVEL, never hard-code 13 — a read-level change silently zeroes roadsBytes.
import { describe, expect, it } from "vitest";
import { BLOB_DETAIL_LEVEL } from "./blob";
import { countsTowardBudget, keepSetForZoom } from "./packBuilder";

describe("the roads budget measures the zoom the pack reads", () => {
	it("⛔ counts BLOB_DETAIL_LEVEL — the level buildPack actually reads", () => {
		// packBuilder.ts:546 reads at BLOB_DETAIL_LEVEL — if the budget doesn't count that level, roadsBytes is 0 for every pack.
		expect(
			countsTowardBudget(BLOB_DETAIL_LEVEL),
			`the pack reads z${BLOB_DETAIL_LEVEL} but the budget does not count it — ` +
				"roadsBytes will be 0 for every area on earth",
		).toBe(true);
	});

	it("⛔ SURVIVES A CHANGE TO THE READ LEVEL — no hard-coded zoom", () => {
		// regression shape: read level moves for build speed, budget must follow — fails if "fixed" with z === 13.
		for (const z of [11, 12, 13, 14, 15, 16]) {
			if (z >= BLOB_DETAIL_LEVEL) {
				expect(
					countsTowardBudget(z),
					`z${z} is at/below the read level and must count`,
				).toBe(true);
			}
		}
	});
});

// ⛔ pois is the hospitals feature (mvtFilter.ts keeps ["hospital","camp_site"]) — routing every tile to OUTER_RING drops hospitals from every offline pack.
describe("the layer routing follows the zoom the pack reads", () => {
	it("⛔ the READ level gets the detail layer set, not the outer one", () => {
		const keep = keepSetForZoom(BLOB_DETAIL_LEVEL, false);
		expect(
			keep.has("pois"),
			`z${BLOB_DETAIL_LEVEL} is the level every pack reads — it must carry ` +
				"`pois`, which IS the offline hospitals feature",
		).toBe(true);
	});

	it("a corridor is still roads-only, whatever the read level is", () => {
		// The corridor branch runs before the zoom test and must stay unaffected.
		const keep = keepSetForZoom(BLOB_DETAIL_LEVEL, true);
		expect(keep.has("pois")).toBe(false);
		expect(keep.has("roads")).toBe(true);
	});
});
