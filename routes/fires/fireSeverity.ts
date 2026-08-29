/**
 * ⚠️ FRP cut points are the user's starting guess, not measured — tune against real clusters; kept in one named table, not scattered through render code.
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
 * ⚠️ Size bands are MEASURED, not guessed — a southern BC fire-season sample tops out at 30.5 km², so the old 50 km² "major" cut was unreachable.
 * ⚠️ LOAD-BEARING: SPOT_MAX must stay above one VIIRS pixel (0.1406 km²) and below two, so a single detection is always "spot" — a test depends on it.
 */
/**
 * ⚠️ FRP cut points are MEASURED (p50/p75/p90 of live FIRMS data), not the original 10/50/200 guess, which dumped 70% of fires into "low".
 * ⚠️ These are cut points on a distribution — re-measure against a fire-season sample before moving them; changing them changes what every card says.
 */
export const FRP_MODERATE_MW = 3;
export const FRP_HIGH_MW = 15;
export const FRP_EXTREME_MW = 90;

export const SIZE_SPOT_MAX_KM2 = 0.25; //   25 ha — one pixel, up to two
export const SIZE_SMALL_MAX_KM2 = 3; //    300 ha — around the median
export const SIZE_LARGE_MAX_KM2 = 15; // 1,500 ha — p90..p95

/** The severity matrix, verbatim from the spec. */
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

/** Look up severity for area (km²) and peak FRP (MW). Always returns a row — NaN/negative input maps to the gentlest band rather than throwing. */
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
	// Unreachable while the table covers 0..∞ on both axes; kept as a fallback since a table is data that gets edited.
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

/** Two-or-three word status for a labelled row (distinct from TREND_LINES' full sentences). */
export const TREND_STATUS: Readonly<Record<TrendBand, string>> = {
	new: "Newly spotted",
	growing: "Growing",
	steady: "Holding steady",
	quieter: "Dying down",
	absent: "Not seen last pass",
};

/** Fewest satellite passes before a direction is claimed at all. */
export const TREND_MIN_PASSES = 3;

/** Ratio cut points between the EARLIER and LATER halves' mean peak FRP. */
export const TREND_GROWING_RATIO = 1.5;
export const TREND_QUIETER_RATIO = 0.67;

/** Groups detections within this window into one satellite pass (one overpass writes many rows across a few minutes). */
export const PASS_BUCKET_MS = 30 * 60 * 1000;

/**
 * Trend from a cluster's own detections: groups by satellite pass (peak FRP per pass), compares the EARLIER half of passes against the LATER half.
 * ⚠️ Not the last two passes — measured to disagree with a fire's full history 64% of the time (FRP swings 0.20–3.43× pass-to-pass for reasons unrelated to the fire).
 * ⚠️ `absent` is deliberately NOT inferred here — claiming "nothing detected on last pass" without knowing the satellite covered this ground would be false comfort.
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

	// Odd count gives the later half the extra pass — recent end weighted more.
	const mid = Math.floor(passes.length / 2);
	const mean = (xs: readonly [number, number][]): number =>
		xs.reduce((a, p) => a + p[1], 0) / xs.length;
	const earlyFrp = mean(passes.slice(0, mid));
	const lateFrp = mean(passes.slice(mid));
	// Earlier half with no measurable heat can't anchor a ratio — treat as the first reading.
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
