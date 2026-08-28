/**
 * fireSeverity.test.ts — the severity + trend lookups.
 *
 * These pin a TABLE, so the tests are mostly about the table's edges: every
 * boundary, both open-ended bands, and the inputs that would otherwise fall
 * through a gap. The wording matters as much as the numbers — "Hottest: Very
 * high heat" was replaced precisely because it read as a riddle.
 */
import { describe, expect, it } from "vitest";
import {
	FRP_EXTREME_MW,
	FRP_HIGH_MW,
	FRP_MODERATE_MW,
	PASS_BUCKET_MS,
	SEVERITY_TABLE,
	SIZE_SPOT_MAX_KM2,
	severityFor,
	TREND_GROWING_RATIO,
	TREND_LINES,
	TREND_QUIETER_RATIO,
	trendFor,
} from "./fireSeverity";

describe("the severity table covers every input", () => {
	it("has all 16 size × heat combinations", () => {
		expect(SEVERITY_TABLE).toHaveLength(16);
	});

	it("returns a row for any area/FRP pair, including absurd ones", () => {
		const cases: [number, number][] = [
			[0, 0],
			[0.0001, 0.0001],
			[1e6, 1e6],
			[Number.NaN, Number.NaN],
			[-5, -5],
			[Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
		];
		for (const [a, f] of cases) {
			const r = severityFor(a, f);
			expect(r.headline.length).toBeGreaterThan(0);
			expect(r.level).toBeGreaterThanOrEqual(1);
			expect(r.level).toBeLessThanOrEqual(5);
		}
	});

	it("treats garbage as the GENTLEST band, never the scariest", () => {
		// A card rendering mild wording beats a card that throws — but it must
		// also never invent an emergency out of a NaN.
		expect(severityFor(Number.NaN, Number.NaN).level).toBe(1);
		expect(severityFor(-1, -1).headline).toBe("Small patch of low heat");
	});
});

describe("severityFor — the spec's own rows", () => {
	it("a tiny cool patch is level 1", () => {
		// frp 1 is p10 heat — genuinely faint under the measured cuts.
		const r = severityFor(0.2, 1);
		expect(r.level).toBe(1);
		expect(r.label).toBe("Faint");
		expect(r.headline).toBe("Small patch of low heat");
	});

	it("a tiny but blazing patch caps at level 3, not 5", () => {
		// Intensity alone must not produce the top level — ONE VIIRS pixel
		// (0.375² = 0.14 km² = 14 ha) is not a catastrophe however hot it reads.
		const r = severityFor(0.1406, 5000);
		expect(r.level).toBe(3);
		expect(r.headline).toBe("Small fire burning very hot");
	});

	it("a SINGLE detection can never exceed level 3, at any heat", () => {
		// The load-bearing invariant behind SIZE_SPOT_MAX_KM2: one nominal pixel
		// must land in `spot`. If that ceiling ever drops below 0.1406 a lone
		// detection starts reporting level 4+, which is the layer crying wolf.
		for (const frp of [1, 30, 120, 5000, 999_999]) {
			expect(severityFor(0.1406, frp).level).toBeLessThanOrEqual(3);
		}
		expect(SIZE_SPOT_MAX_KM2).toBeGreaterThan(0.1406);
		expect(SIZE_SPOT_MAX_KM2).toBeLessThan(0.2812); // under TWO pixels
	});

	it("a large hot fire is level 4", () => {
		// frp 20 is HIGH (15..90) under the measured cuts; 120 is now EXTREME.
		const r = severityFor(12, 20);
		expect(r.level).toBe(4);
		expect(r.headline).toBe("Large fire burning hot");
	});

	it("a large very hot fire is level 5", () => {
		expect(severityFor(12, 400).level).toBe(5);
		expect(severityFor(12, 400).headline).toBe("Large fire burning very hot");
	});

	it("a very large area is serious even when it is COOL", () => {
		// Area threatens ground; a big smouldering burn still rates level 3.
		const r = severityFor(200, 2);
		expect(r.level).toBe(3);
		expect(r.headline).toBe("Very large area burning at low heat");
	});

	it("the top-right corner is Extreme", () => {
		const r = severityFor(500, 900);
		expect(r.level).toBe(5);
		expect(r.label).toBe("Extreme");
		expect(r.headline).toBe("Very large fire burning very hot");
	});
});

describe("severityFor — band boundaries are lower-inclusive", () => {
	it("0.25 km² (25 ha) leaves the 'spot' band", () => {
		// frp 8 sits in the MODERATE band under the measured cuts (3..15).
		expect(severityFor(0.24, 8).headline).toBe("Small fire burning");
		expect(severityFor(0.25, 8).headline).toBe("Fire burning");
	});

	it("3 km² (300 ha) enters 'large'", () => {
		expect(severityFor(2.99, 8).headline).toBe("Fire burning");
		expect(severityFor(3, 8).headline).toBe("Large area burning");
	});

	it("15 km² (1,500 ha) enters 'major'", () => {
		expect(severityFor(14.9, 8).headline).toBe("Large area burning");
		expect(severityFor(15, 8).headline).toBe("Very large fire burning");
	});

	it("the bands are contiguous — no gap can swallow a fire", () => {
		// A gap would drop straight through severityFor's .find() to the
		// fallback row, silently reporting "Faint" for anything inside it.
		const bands = [...new Set(SEVERITY_TABLE.map((r) => r.sizeBand))];
		for (const band of bands) {
			const rows = SEVERITY_TABLE.filter((r) => r.sizeBand === band);
			for (const r of rows) {
				expect(r.sizeMinKm2).toBe(rows[0].sizeMinKm2);
				expect(r.sizeMaxKm2).toBe(rows[0].sizeMaxKm2);
			}
		}
		const edges = bands.map((b) => {
			const r = SEVERITY_TABLE.find((x) => x.sizeBand === b);
			return [r?.sizeMinKm2 ?? 0, r?.sizeMaxKm2 ?? 0] as const;
		});
		for (let i = 1; i < edges.length; i++) {
			expect(edges[i][0]).toBe(edges[i - 1][1]);
		}
		expect(edges[0][0]).toBe(0);
		expect(edges[edges.length - 1][1]).toBe(Number.POSITIVE_INFINITY);
	});

	it("the MEASURED southern-BC distribution spreads across the bands", () => {
		// 21,607 detections → 257 clusters, deduped. If these ever bunch into one
		// band the thresholds have drifted away from reality again.
		expect(severityFor(2.08, 30).sizeBand).toBe("small"); // median, 208 ha
		expect(severityFor(6.76, 30).sizeBand).toBe("large"); // p75,   676 ha
		expect(severityFor(13.5, 30).sizeBand).toBe("large"); // p90, 1,351 ha
		expect(severityFor(19.1, 30).sizeBand).toBe("major"); // p95, 1,906 ha
		expect(severityFor(30.5, 30).sizeBand).toBe("major"); // max, 3,049 ha
	});

	it("the FRP cut points are 3 / 15 / 90 MW — measured, not guessed", () => {
		expect(severityFor(1, 2.9).headline).toBe("Fire burning at low heat");
		expect(severityFor(1, FRP_MODERATE_MW).headline).toBe("Fire burning");
		expect(severityFor(1, 14.9).headline).toBe("Fire burning");
		expect(severityFor(1, FRP_HIGH_MW).headline).toBe("Fire burning hot");
		expect(severityFor(1, 89.9).headline).toBe("Fire burning hot");
		expect(severityFor(1, FRP_EXTREME_MW).headline).toBe(
			"Fire burning very hot",
		);
	});

	/**
	 * ⛔ THE MEASURED BUG. The cuts were 10 / 50 / 200 — a stated first guess —
	 * and on live FIRMS (37,138 detections → 302 fires) they put **70% of every
	 * fire in the bottom band**, and 80% of lone detections at level 1 of 5. A
	 * scale where seven fires in ten score lowest teaches the reader nothing.
	 */
	it("spreads the MEASURED distribution instead of bunching at the bottom", () => {
		// The real peak-FRP percentiles, southern BC in fire season.
		expect(severityFor(1, 0.7).frpBand).toBe("low"); // p10
		expect(severityFor(1, 3.3).frpBand).toBe("moderate"); // p50 — was "low"
		expect(severityFor(1, 13).frpBand).toBe("moderate"); // p75 — was "low"
		expect(severityFor(1, 89).frpBand).toBe("high"); // p90 — was "moderate"
		expect(severityFor(1, 266).frpBand).toBe("extreme"); // p95
	});

	it("a LONE detection can still reach the middle of the scale", () => {
		// One VIIRS pixel is always 14 ha, so size cannot move — heat has to. At
		// the old cuts a lone fire essentially only ever read 1 or 2 of 5.
		expect(severityFor(0.14, 1).level).toBe(1); // p10 heat
		expect(severityFor(0.14, 5).level).toBe(2); // around the median
		expect(severityFor(0.14, 20).level).toBe(3); // genuinely hot for one pixel
		// ...and STILL capped at 3: one 14 ha pixel is not a catastrophe however
		// hot it reads. That asymmetry is why this is a table, not a formula.
		expect(severityFor(0.14, 5000).level).toBe(3);
	});
});

describe("the headline never asks 'hottest WHAT?'", () => {
	it("reads as a sentence about the fire, not about a data aggregate", () => {
		// The wording this replaced: "Hottest: Very high heat". A planter sees one
		// marker; they don't know or need to know it's a cluster of pixels.
		for (const row of SEVERITY_TABLE) {
			expect(row.headline.toLowerCase()).not.toContain("hottest");
			expect(row.headline.toLowerCase()).not.toContain("cluster");
			expect(row.headline.toLowerCase()).not.toContain("detection");
			expect(row.headline).not.toContain("MW");
		}
	});
});

describe("trendFor — what it's doing between passes", () => {
	const H = 3_600_000;
	const T0 = Date.UTC(2026, 7, 8, 0, 0);

	it("too few passes is a FIRST DETECTION, never a direction", () => {
		const r = trendFor([
			{ t: T0, frp: 40 },
			{ t: T0 + 60_000, frp: 60 },
		]);
		// Both inside one bucket → one pass.
		expect(r.band).toBe("new");
		expect(r.line).toBe(TREND_LINES.new);
		// TWO passes is also not enough: one comparison of a signal that swings
		// 0.20–3.43× between overpasses is noise, not a trend.
		expect(
			trendFor([
				{ t: T0, frp: 20 },
				{ t: T0 + 6 * H, frp: 200 },
			]).band,
		).toBe("new");
	});

	it("flags GROWING when the LATER half is hotter", () => {
		const r = trendFor([
			{ t: T0, frp: 20 },
			{ t: T0 + 6 * H, frp: 20 },
			{ t: T0 + 12 * H, frp: 20 * TREND_GROWING_RATIO + 5 },
			{ t: T0 + 18 * H, frp: 20 * TREND_GROWING_RATIO + 5 },
		]);
		expect(r.band).toBe("growing");
		expect(r.line).toBe("Growing since last pass");
	});

	it("flags QUIETER when the LATER half is cooler", () => {
		const r = trendFor([
			{ t: T0, frp: 100 },
			{ t: T0 + 6 * H, frp: 100 },
			{ t: T0 + 12 * H, frp: 100 * TREND_QUIETER_RATIO - 10 },
			{ t: T0 + 18 * H, frp: 100 * TREND_QUIETER_RATIO - 10 },
		]);
		expect(r.band).toBe("quieter");
		expect(r.line).toBe("Less heat than last pass");
	});

	it("calls the middle band STEADY", () => {
		const r = trendFor([
			{ t: T0, frp: 100 },
			{ t: T0 + 6 * H, frp: 100 },
			{ t: T0 + 12 * H, frp: 100 },
		]);
		expect(r.band).toBe("steady");
		expect(r.line).toBe("Holding steady");
	});

	/**
	 * ⛔ THE MEASURED BUG. The old rule compared only the LAST TWO passes, and on
	 * live FIRMS data that verdict disagreed with the fire's own full history in
	 * **64% of cases** — which is what produced two adjacent clusters reading
	 * "Dying down" and "Newly spotted" for the same fire.
	 */
	it("ONE noisy pass cannot decide the verdict", () => {
		// A steady fire whose most recent overpass happened to read low — cloud,
		// swath angle, a night retrieval. Last-two would call this "Dying down";
		// averaged halves see a fire that is holding.
		const r = trendFor([
			{ t: T0, frp: 100 },
			{ t: T0 + 6 * H, frp: 100 },
			{ t: T0 + 12 * H, frp: 100 },
			{ t: T0 + 18 * H, frp: 55 },
		]);
		expect(r.band).toBe("steady");
	});

	it("a genuine sustained decline still reads QUIETER", () => {
		// The other half of the promise: damping noise must not make the layer
		// blind to a fire that is actually going out.
		const r = trendFor([
			{ t: T0, frp: 200 },
			{ t: T0 + 6 * H, frp: 180 },
			{ t: T0 + 12 * H, frp: 40 },
			{ t: T0 + 18 * H, frp: 20 },
		]);
		expect(r.band).toBe("quieter");
	});

	it("buckets one overpass spread over minutes as a SINGLE pass", () => {
		const spread = [0, 5, 12, 20].map((m) => ({ t: T0 + m * 60_000, frp: 30 }));
		expect(trendFor(spread).band).toBe("new");
		// ...and genuinely later passes are separate.
		const later = [
			...spread,
			{ t: T0 + PASS_BUCKET_MS * 3, frp: 90 },
			{ t: T0 + PASS_BUCKET_MS * 6, frp: 90 },
		];
		expect(trendFor(later).band).toBe("growing");
	});

	it("uses each pass's PEAK, not its average", () => {
		// Within a pass, many small readings must not drag the peak down.
		const r = trendFor([
			{ t: T0, frp: 10 },
			{ t: T0 + 6 * H, frp: 10 },
			{ t: T0 + 12 * H, frp: 1 },
			{ t: T0 + 12 * H + 60_000, frp: 1 },
			{ t: T0 + 12 * H + 120_000, frp: 100 },
			{ t: T0 + 18 * H, frp: 100 },
		]);
		expect(r.band).toBe("growing");
	});

	it("does not divide by a zero earlier half", () => {
		const r = trendFor([
			{ t: T0, frp: 0 },
			{ t: T0 + 6 * H, frp: 50 },
			{ t: T0 + 12 * H, frp: 50 },
		]);
		expect(r.band).toBe("new");
	});

	it("survives empty and malformed input", () => {
		expect(trendFor([]).band).toBe("new");
		expect(trendFor([{ t: Number.NaN, frp: Number.NaN }]).band).toBe("new");
	});

	it("never claims ABSENT from detections alone", () => {
		// "Nothing detected on last pass" requires knowing a pass happened AND
		// covered this ground. Satellite gaps and cloud make that unsafe to infer,
		// and a false "it's out" is the worst thing this layer could say.
		const many = Array.from({ length: 10 }, (_, i) => ({
			t: T0 + i * 6 * H,
			frp: 50,
		}));
		expect(trendFor(many).band).not.toBe("absent");
	});
});
