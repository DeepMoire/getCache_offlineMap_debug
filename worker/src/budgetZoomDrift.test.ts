/**
 * THE BUDGET MUST MEASURE THE ZOOM THE PACK ACTUALLY READS.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────
 *
 * MEASURED on the LIVE Worker 2026-08-21, three cities, all three identical:
 *
 *   Wyoming    disc=324 reads=357 rbytes=3835797  ... roadsBytes=0
 *   Washington disc=380 reads=413 rbytes=4956795  ... roadsBytes=0
 *   Toronto    disc=324 reads=356 rbytes=10501773 ... roadsBytes=0
 *
 * Toronto read 10.5 MB out of R2 and reported ZERO road bytes. Not a
 * geography problem — a counting problem.
 *
 * `countsTowardBudget(z)` is `z >= BLOB_DETAIL_Z || z === BUDGET_OUTER_Z`
 * — i.e. z15 or z12. But `buildPack` reads its tiles at `BLOB_DETAIL_LEVEL`,
 * which moved to 13 for build speed. 13 is neither, so the accumulator at
 * packBuilder.ts:428 never runs and `roadsBytes` is 0 BY CONSTRUCTION.
 *
 * ⚠️ THE SAME DRIFT ALREADY BIT THE KIND FILTER, IN THIS FILE. The comment
 * above the call site says it outright: "`BLOB_DETAIL_Z` is 15 but the read
 * level moved to 13, so `13 < 15` was ALWAYS true and the filter applied to
 * every tile." That one was found and fixed. The budget comparison, three
 * lines below it, was left pointing at the old constants.
 *
 * The budget decides `dropPaths` and the pack's reach. Reading a constant 0
 * means it always sees "sparse" — so it never strips paths and always ships
 * the WIDE reach, on every area on earth, including downtown Toronto.
 *
 * ⛔ DO NOT "FIX" THIS BY HARD-CODING 13. That is the same bug with a newer
 * number: the next build-speed change moves the read level again and the
 * budget silently zeroes again. The budget must be DERIVED from the level the
 * pack reads, so the two cannot drift apart.
 */
import { describe, expect, it } from "vitest";
import { BLOB_DETAIL_LEVEL } from "./blob";
import { countsTowardBudget, keepSetForZoom } from "./packBuilder";

describe("the roads budget measures the zoom the pack reads", () => {
	it("⛔ counts BLOB_DETAIL_LEVEL — the level buildPack actually reads", () => {
		// packBuilder.ts:546 → tilesForBox(box, BLOB_DETAIL_LEVEL). If the budget
		// does not count this exact level, roadsBytes is 0 for every pack ever
		// built, which is what the live Worker was returning.
		expect(
			countsTowardBudget(BLOB_DETAIL_LEVEL),
			`the pack reads z${BLOB_DETAIL_LEVEL} but the budget does not count it — ` +
				"roadsBytes will be 0 for every area on earth",
		).toBe(true);
	});

	it("⛔ SURVIVES A CHANGE TO THE READ LEVEL — no hard-coded zoom", () => {
		// The regression shape: someone moves the read level for build speed and
		// the budget keeps pointing at the old number. Whatever BLOB_DETAIL_LEVEL
		// becomes, the budget has to follow it. This fails if the fix is `z === 13`.
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

/**
 * THE SAME DRIFT, A SECOND TIME, TWENTY LINES UP.
 *
 * `keepSetForZoom` routed on `z >= BLOB_DETAIL_Z` (15) while the pack reads at
 * `BLOB_DETAIL_LEVEL` (13). So EVERY tile fell through to OUTER_RING — roads +
 * places — and the INNER_RING layers (`pois`) never shipped in any pack.
 *
 * ⛔ `pois` IS THE HOSPITALS FEATURE. `mvtFilter.ts` keeps exactly
 * `["hospital", "camp_site"]` from that layer; it is the whole of offline
 * hospitals. Routing every tile to OUTER_RING dropped hospitals from every
 * offline pack on earth.
 *
 * The function's OWN docstring warns about this exact failure: "the z13 ring
 * initially fell through to OUTER_RING and lost all its water." It fell
 * through again, for the same reason, against the same constant.
 */
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
