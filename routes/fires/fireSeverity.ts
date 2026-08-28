/**
 * fireSeverity.ts — "Large fire burning hot · Growing since last pass".
 *
 * ── Why a lookup table and not prose ──
 * The card used to say `Hottest: Very high heat`, which invited the obvious
 * question: hottest WHAT? A planter sees one fire marker; they neither know nor
 * need to know that it is an aggregate of satellite pixels. Qualifying the
 * number re-exposed the plumbing.
 *
 * So severity is TWO independent lookups, both driven by data already on the
 * phone:
 *
 *   1. **How bad** — area × peak FRP → a level 1–5 and a headline sentence.
 *   2. **What it's doing** — the FRP ratio between the last two satellite
 *      passes → a trend line.
 *
 * They are deliberately separate. A large fire that is dying and a small one
 * flaring up are different situations, and a single blended score would hide
 * both. Size is the area of the UNIQUE ~375 m ground cells burning (see
 * `clusterAreaKm2`); heat is the MAX (the worst pixel), never a sum — twenty
 * campfires must never add up to an inferno.
 *
 * ── Where the trend data comes from ──
 * No new storage and no schema change. Every hotspot already carries its own
 * acquisition time `t`, and the Worker fetches TWO calendar days, so a single
 * cached record contains dozens of satellite passes (measured: 67 distinct pass
 * times spanning 37 h). Grouping a cluster's own detections by pass and
 * comparing the last two is enough.
 *
 * ⚠️ The FRP cut points (10 / 50 / 200 MW) are the user's stated starting guess,
 * to be tuned against real clusters. They are here, named, in one table — not
 * scattered through render code — precisely so tuning is a one-line edit.
 *
 * Pure functions. No map, no DOM, no fetch.
 */

/** Level 1–5. Drives wording, and later could drive colour. */
export type SeverityLevel = 1 | 2 | 3 | 4 | 5;

export interface SeverityRow {
	readonly sizeBand: "spot" | "small" | "large" | "major";
	readonly sizeMinKm2: number;
	/** Exclusive upper bound; Infinity for the open-ended top band. */
	readonly sizeMaxKm2: number;
	readonly frpBand: "low" | "moderate" | "high" | "extreme";
	readonly frpMinMw: number;
	readonly frpMaxMw: number;
	readonly level: SeverityLevel;
	readonly label: string;
	readonly headline: string;
}

/**
 * Size band boundaries, km².
 *
 * ⚠️ MEASURED, not guessed — and they MOVED once the area bug was fixed.
 *
 * The original bands (0.5 / 5 / 50 km²) were calibrated against a
 * `clusterAreaKm2` that summed every detection's footprint, counting the same
 * ground once per satellite per overpass — a measured 3.9× overstatement. With
 * the dedupe in place those thresholds were far too high: southern BC across a
 * full fire-season sample (21,607 detections → 257 clusters) tops out at
 * 30.5 km², so NOTHING would ever have reached the old 50 km² "major".
 *
 * The distribution that set these numbers:
 *
 *     median  2.08 km²   (208 ha)   →  small
 *     p75     6.76 km²   (676 ha)   →  large
 *     p90    13.5  km² (1,351 ha)   →  large
 *     p95    19.1  km² (1,906 ha)   →  major
 *     max    30.5  km² (3,049 ha)   →  major
 *
 * ⚠️ LOAD-BEARING: SPOT_MAX must sit above ONE nominal VIIRS pixel
 * (0.375² = 0.1406 km²) and below two, so a single detection is always a
 * "spot" whatever its heat. The "tiny but blazing patch caps at level 3" test
 * depends on it.
 */
/**
 * FRP cut points, MW — MEASURED, not guessed.
 *
 * ⚠️ These were 10 / 50 / 200 (a stated first guess) and they were far too
 * high. Measured on live FIRMS over southern BC — 37,138 detections flood-filled
 * into 302 fires — the peak-FRP distribution is:
 *
 *     p10 0.7   p25 1.2   p50 3.3   p75 13   p90 89   p95 266   p99 865
 *
 * so the old cuts dumped **70% of every fire into "low"** and 80% of lone
 * detections at level 1 of 5. A scale where seven fires in ten score the bottom
 * band is not a scale; the reader learns nothing from it.
 *
 * Set to the measured p50 / p75 / p90, which spreads real fires 49 / 27 / 14 /
 * 10 % across the four bands.
 *
 * ⚠️ They are CUT POINTS ON A DISTRIBUTION, so re-measure before moving them —
 * and re-measure against a fire-season sample, not a quiet week. Changing them
 * changes what every card says.
 */
export const FRP_MODERATE_MW = 3;
export const FRP_HIGH_MW = 15;
export const FRP_EXTREME_MW = 90;

export const SIZE_SPOT_MAX_KM2 = 0.25; //   25 ha — one pixel, up to two
export const SIZE_SMALL_MAX_KM2 = 3; //    300 ha — around the median
export const SIZE_LARGE_MAX_KM2 = 15; // 1,500 ha — p90..p95

/**
 * The severity matrix, verbatim from the spec.
 *
 * Read it as a grid: size bands down, heat bands across. Note it is NOT
 * symmetric — a big cool area (level 3) outranks a small very hot one (level 3
 * as well, but with a different headline), because area threatens more ground
 * while intensity threatens it faster. That asymmetry is the point of a table.
 */
export const SEVERITY_TABLE: readonly SeverityRow[] = [
	{
		sizeBand: "spot",
		sizeMinKm2: 0,
		sizeMaxKm2: SIZE_SPOT_MAX_KM2,
		frpBand: "low",
		frpMinMw: 0,
		frpMaxMw: FRP_MODERATE_MW,
		level: 1,
		label: "Faint",
		headline: "Small patch of low heat",
	},
	{
		sizeBand: "spot",
		sizeMinKm2: 0,
		sizeMaxKm2: SIZE_SPOT_MAX_KM2,
		frpBand: "moderate",
		frpMinMw: FRP_MODERATE_MW,
		frpMaxMw: FRP_HIGH_MW,
		level: 2,
		label: "Active",
		headline: "Small fire burning",
	},
	{
		sizeBand: "spot",
		sizeMinKm2: 0,
		sizeMaxKm2: SIZE_SPOT_MAX_KM2,
		frpBand: "high",
		frpMinMw: FRP_HIGH_MW,
		frpMaxMw: FRP_EXTREME_MW,
		level: 3,
		label: "Strong",
		headline: "Small fire burning hot",
	},
	{
		sizeBand: "spot",
		sizeMinKm2: 0,
		sizeMaxKm2: SIZE_SPOT_MAX_KM2,
		frpBand: "extreme",
		frpMinMw: FRP_EXTREME_MW,
		frpMaxMw: Number.POSITIVE_INFINITY,
		level: 3,
		label: "Strong",
		headline: "Small fire burning very hot",
	},

	{
		sizeBand: "small",
		sizeMinKm2: SIZE_SPOT_MAX_KM2,
		sizeMaxKm2: SIZE_SMALL_MAX_KM2,
		frpBand: "low",
		frpMinMw: 0,
		frpMaxMw: FRP_MODERATE_MW,
		level: 2,
		label: "Active",
		headline: "Fire burning at low heat",
	},
	{
		sizeBand: "small",
		sizeMinKm2: SIZE_SPOT_MAX_KM2,
		sizeMaxKm2: SIZE_SMALL_MAX_KM2,
		frpBand: "moderate",
		frpMinMw: FRP_MODERATE_MW,
		frpMaxMw: FRP_HIGH_MW,
		level: 2,
		label: "Active",
		headline: "Fire burning",
	},
	{
		sizeBand: "small",
		sizeMinKm2: SIZE_SPOT_MAX_KM2,
		sizeMaxKm2: SIZE_SMALL_MAX_KM2,
		frpBand: "high",
		frpMinMw: FRP_HIGH_MW,
		frpMaxMw: FRP_EXTREME_MW,
		level: 3,
		label: "Strong",
		headline: "Fire burning hot",
	},
	{
		sizeBand: "small",
		sizeMinKm2: SIZE_SPOT_MAX_KM2,
		sizeMaxKm2: SIZE_SMALL_MAX_KM2,
		frpBand: "extreme",
		frpMinMw: FRP_EXTREME_MW,
		frpMaxMw: Number.POSITIVE_INFINITY,
		level: 4,
		label: "Intense",
		headline: "Fire burning very hot",
	},

	{
		sizeBand: "large",
		sizeMinKm2: SIZE_SMALL_MAX_KM2,
		sizeMaxKm2: SIZE_LARGE_MAX_KM2,
		frpBand: "low",
		frpMinMw: 0,
		frpMaxMw: FRP_MODERATE_MW,
		level: 3,
		label: "Strong",
		headline: "Large area burning at low heat",
	},
	{
		sizeBand: "large",
		sizeMinKm2: SIZE_SMALL_MAX_KM2,
		sizeMaxKm2: SIZE_LARGE_MAX_KM2,
		frpBand: "moderate",
		frpMinMw: FRP_MODERATE_MW,
		frpMaxMw: FRP_HIGH_MW,
		level: 3,
		label: "Strong",
		headline: "Large area burning",
	},
	{
		sizeBand: "large",
		sizeMinKm2: SIZE_SMALL_MAX_KM2,
		sizeMaxKm2: SIZE_LARGE_MAX_KM2,
		frpBand: "high",
		frpMinMw: FRP_HIGH_MW,
		frpMaxMw: FRP_EXTREME_MW,
		level: 4,
		label: "Intense",
		headline: "Large fire burning hot",
	},
	{
		sizeBand: "large",
		sizeMinKm2: SIZE_SMALL_MAX_KM2,
		sizeMaxKm2: SIZE_LARGE_MAX_KM2,
		frpBand: "extreme",
		frpMinMw: FRP_EXTREME_MW,
		frpMaxMw: Number.POSITIVE_INFINITY,
		level: 5,
		label: "Extreme",
		headline: "Large fire burning very hot",
	},

	{
		sizeBand: "major",
		sizeMinKm2: SIZE_LARGE_MAX_KM2,
		sizeMaxKm2: Number.POSITIVE_INFINITY,
		frpBand: "low",
		frpMinMw: 0,
		frpMaxMw: FRP_MODERATE_MW,
		level: 3,
		label: "Strong",
		headline: "Very large area burning at low heat",
	},
	{
		sizeBand: "major",
		sizeMinKm2: SIZE_LARGE_MAX_KM2,
		sizeMaxKm2: Number.POSITIVE_INFINITY,
		frpBand: "moderate",
		frpMinMw: FRP_MODERATE_MW,
		frpMaxMw: FRP_HIGH_MW,
		level: 4,
		label: "Intense",
		headline: "Very large fire burning",
	},
	{
		sizeBand: "major",
		sizeMinKm2: SIZE_LARGE_MAX_KM2,
		sizeMaxKm2: Number.POSITIVE_INFINITY,
		frpBand: "high",
		frpMinMw: FRP_HIGH_MW,
		frpMaxMw: FRP_EXTREME_MW,
		level: 5,
		label: "Extreme",
		headline: "Very large fire burning hot",
	},
	{
		sizeBand: "major",
		sizeMinKm2: SIZE_LARGE_MAX_KM2,
		sizeMaxKm2: Number.POSITIVE_INFINITY,
		frpBand: "extreme",
		frpMinMw: FRP_EXTREME_MW,
		frpMaxMw: Number.POSITIVE_INFINITY,
		level: 5,
		label: "Extreme",
		headline: "Very large fire burning very hot",
	},
];

/**
 * Look up severity for an area (km²) and a PEAK FRP (MW).
 *
 * Always returns a row: a NaN or negative input lands in the gentlest band
 * rather than throwing, because a card that renders the mildest wording is a
 * far better failure than a card that renders nothing at all.
 */
export function severityFor(areaKm2: number, peakFrpMw: number): SeverityRow {
	const a = Number.isFinite(areaKm2) && areaKm2 > 0 ? areaKm2 : 0;
	const f = Number.isFinite(peakFrpMw) && peakFrpMw > 0 ? peakFrpMw : 0;
	const hit = SEVERITY_TABLE.find(
		(r) =>
			a >= r.sizeMinKm2 &&
			a < r.sizeMaxKm2 &&
			f >= r.frpMinMw &&
			f < r.frpMaxMw,
	);
	// Unreachable while the table covers 0..∞ on both axes, but a table is data
	// and data gets edited — fall back rather than return undefined.
	return hit ?? SEVERITY_TABLE[0];
}

/** What the fire is doing between passes. Independent of how bad it is. */
export type TrendBand = "new" | "growing" | "steady" | "quieter" | "absent";

export interface TrendResult {
	readonly band: TrendBand;
	/** Full sentence, for prose. */
	readonly line: string;
	/** Two-or-three words, for a labelled row. */
	readonly status: string;
}

export const TREND_LINES: Readonly<Record<TrendBand, string>> = {
	new: "First detection",
	growing: "Growing since last pass",
	steady: "Holding steady",
	quieter: "Less heat than last pass",
	absent: "Nothing detected on last pass",
};

/**
 * Two-or-three word status for a LABELLED row ("Status — Dying down").
 *
 * Distinct from TREND_LINES, which are full sentences for a prose card. A row
 * already carries its label, so repeating "since last pass" in the value would
 * be saying the same thing twice.
 */
export const TREND_STATUS: Readonly<Record<TrendBand, string>> = {
	new: "Newly spotted",
	growing: "Growing",
	steady: "Holding steady",
	quieter: "Dying down",
	absent: "Not seen last pass",
};

/**
 * Fewest satellite passes before a direction is claimed at all.
 *
 * Two passes is one comparison of a signal that swings 0.20–3.43× for reasons
 * unrelated to the fire, so it is not enough. Three gives the halves something
 * to average over.
 */
export const TREND_MIN_PASSES = 3;

/** Ratio cut points between the EARLIER and LATER halves' mean peak FRP. */
export const TREND_GROWING_RATIO = 1.5;
export const TREND_QUIETER_RATIO = 0.67;

/**
 * Detections are stamped to the minute, but one satellite overpass writes many
 * rows across a few minutes. Bucket by this window so a single pass isn't read
 * as several.
 */
export const PASS_BUCKET_MS = 30 * 60 * 1000;

/**
 * Trend from a cluster's own detections.
 *
 * Groups by satellite pass, takes each pass's PEAK FRP, then compares the
 * EARLIER HALF of the passes against the LATER HALF.
 *
 * ⚠️ **Not the last two passes.** That is what it did, and it was measured to
 * be a coin flip: on live FIRMS data (37,138 detections, 596 fires with 3+
 * passes) the last-two verdict **disagreed with the fire's own full history in
 * 64% of cases**, and the pass-to-pass FRP ratio spanned **0.20 → 3.43**
 * (p10 → p90). FRP swings that hard between overpasses for reasons that have
 * nothing to do with the fire — viewing angle across the swath, cloud, and the
 * day/night difference in the retrieval. Two samples of a noisy signal is not a
 * trend, and printing "Dying down" off it is the map inventing a fact.
 *
 * It also produced the visible symptom: two adjacent clusters reading "Dying
 * down" and "Newly spotted" — same fire, different luck in which passes each
 * cluster happened to contain.
 *
 * Halving averages over every pass available, so a single wild reading moves
 * the verdict a little instead of deciding it. Fewer than `TREND_MIN_PASSES`
 * → "Newly spotted": with too little to compare, claiming a direction would be
 * invention.
 *
 * `absent` is deliberately NOT inferred here. It means "this fire was seen
 * before and was NOT in the most recent pass", which requires knowing the pass
 * happened and covered this ground — a claim satellite gaps and cloud make
 * unsafe from detections alone. Saying "nothing detected on last pass" when the
 * satellite simply didn't look would be the worst kind of false comfort.
 */
export function trendFor(
	detections: readonly { t: number; frp: number }[],
): TrendResult {
	const byPass = new Map<number, number>();
	for (const d of detections) {
		if (!Number.isFinite(d.t)) continue;
		const bucket = Math.floor(d.t / PASS_BUCKET_MS);
		const frp = Number.isFinite(d.frp) ? d.frp : 0;
		const prev = byPass.get(bucket);
		if (prev === undefined || frp > prev) byPass.set(bucket, frp);
	}
	const passes = [...byPass.entries()].sort((a, b) => a[0] - b[0]);
	if (passes.length < TREND_MIN_PASSES)
		return { band: "new", line: TREND_LINES.new, status: TREND_STATUS.new };

	// Split into halves. An odd count gives the LATER half the extra pass — the
	// recent end is what the reader cares about, and it keeps a 3-pass fire from
	// resting its whole verdict on one early reading.
	const mid = Math.floor(passes.length / 2);
	const mean = (xs: readonly [number, number][]): number =>
		xs.reduce((a, p) => a + p[1], 0) / xs.length;
	const earlyFrp = mean(passes.slice(0, mid));
	const lateFrp = mean(passes.slice(mid));
	// An earlier half with no measurable heat can't anchor a ratio; treat the
	// current reading as the first meaningful one.
	if (earlyFrp <= 0)
		return { band: "new", line: TREND_LINES.new, status: TREND_STATUS.new };

	const ratio = lateFrp / earlyFrp;
	const band: TrendBand =
		ratio >= TREND_GROWING_RATIO
			? "growing"
			: ratio < TREND_QUIETER_RATIO
				? "quieter"
				: "steady";
	return { band, line: TREND_LINES[band], status: TREND_STATUS[band] };
}
