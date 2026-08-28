/**
 * fireHotspotCopy.ts — the words a planter reads when they tap a fire marker.
 *
 * ── The editorial rule: facts, not disclaimers ──
 * An earlier version hedged — "not a confirmed fire", "may be a false reading",
 * "industrial sites and flares all show up here". The user cut all of it, and
 * they were right: a screen that spends more words apologising for its data than
 * reporting it teaches people to distrust the layer, and a planter deciding
 * something real does not need to be talked out of the map they opened.
 *
 * So we state what the satellite measured and let it stand:
 *
 *     336 km NE of you
 *     Seen 21h ago
 *     Moderate heat
 *     Covers 375 m
 *
 * The honesty now lives in WHAT we report rather than in caveats around it.
 * "Covers 375 m" is a fact that happens to prevent the pixel being read as a
 * mapped perimeter. Two things are deliberately NOT shown:
 *
 *   • **Confidence** (`l`/`n`/`h`) — a sensor-internal quality flag, not
 *     something a planter can act on. "Normal confidence detection" on every
 *     marker was noise wearing the costume of rigour.
 *   • **The raw FRP number in MW.** The user's reaction on seeing it was
 *     "what's MW?" — which is the whole argument. A field tool must not make
 *     someone decode units to learn whether a fire is big. The intensity BAND
 *     ("Moderate heat") is the same information in words they already have, and
 *     the megawatt figure implied a precision FRP doesn't carry anyway.
 *
 * ── No agency link ──
 * Also cut. A per-region link (BC Wildfire / CIFFC / EFFIS / …) means owning a
 * jurisdiction table for the whole world and maintaining every one of those URLs
 * forever, to hand someone a site that is useless in most of it. Not worth the
 * maintenance; the card stands on the measurement.
 *
 * Pure string/number functions, no map and no DOM, so every phrase is testable
 * without driving a browser. Nothing here fetches anything: it all comes from
 * data already on the phone.
 */

import {
	type SeverityLevel,
	severityFor,
	TREND_STATUS,
	type TrendBand,
	trendFor,
} from "./fireSeverity";
// `CELL_DEG` is NOT imported: this module pins its cell size to VIIRS's nominal
// pixel (`CELL_KM`) rather than deriving it from the grid constant — see the
// note on `CELL_KM` below. The comments here still name `CELL_DEG` because a
// test pins the two within 15%, but nothing in this file reads it.
import { cellKey, INDUSTRIAL_LABEL } from "./masks/staticHeatSources";
import type { FireHotspot } from "./fireCache";

/** Intensity bands off FRP (fire radiative power, MW) — a physical measurement
 *  of radiated energy, which is the one number that says "how big is this".
 *
 *  Bands stay coarse on purpose: FRP swings with viewing angle and cloud, so a
 *  precise-sounding figure would imply precision the sensor doesn't have. The
 *  raw megawatt value is computed but never SHOWN — see the header. */
export type FireIntensity = "low" | "moderate" | "high" | "extreme";

export function intensityOf(frp: number): FireIntensity {
	if (!Number.isFinite(frp) || frp < 10) return "low";
	if (frp < 50) return "moderate";
	if (frp < 200) return "high";
	return "extreme";
}

/** Plain-English intensity. No editorialising about what might have caused it —
 *  that judgement belongs to static-source flagging, not to a word here. */
export function intensityLabel(frp: number): string {
	switch (intensityOf(frp)) {
		case "low":
			return "Low heat";
		case "moderate":
			return "Moderate heat";
		case "high":
			return "High heat";
		case "extreme":
			return "Very high heat";
	}
}

/** Great-circle km. Local copy keeps this module dependency-free so the copy
 *  can be tested without pulling map or worker code into the environment. */
export function kmApart(
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	const R = 6371;
	const toRad = Math.PI / 180;
	const dLat = (b[1] - a[1]) * toRad;
	const dLng = (b[0] - a[0]) * toRad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 8-point compass bearing. Direction beats degrees in the field: "north-east of
 *  you" is actionable and smoke arrives on a wind from somewhere; "047°" is not. */
export function bearingLabel(
	from: readonly [number, number],
	to: readonly [number, number],
): string {
	const toRad = Math.PI / 180;
	const y = Math.sin((to[0] - from[0]) * toRad) * Math.cos(to[1] * toRad);
	const x =
		Math.cos(from[1] * toRad) * Math.sin(to[1] * toRad) -
		Math.sin(from[1] * toRad) *
			Math.cos(to[1] * toRad) *
			Math.cos((to[0] - from[0]) * toRad);
	const deg = (Math.atan2(y, x) / toRad + 360) % 360;
	const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
	return points[Math.round(deg / 45) % 8];
}

/** "336 km NE of you" — or null with no fix, in which case the line is omitted
 *  rather than a distance invented. */
export function distanceLine(
	hotspot: readonly [number, number],
	you: readonly [number, number] | null,
): string | null {
	if (you === null) return null;
	const km = kmApart(you, hotspot);
	const dir = bearingLabel(you, hotspot);
	// Sub-km precision would be false — the pixel itself is ~0.4 km across.
	if (km < 1) return `Less than 1 km ${dir} of you`;
	return `${Math.round(km)} km ${dir} of you`;
}

/** "Seen 21h ago" — when the SATELLITE saw it. Distinct from when we fetched it
 *  (that's the layer-wide stamp); this is the one that matters per marker. */
export function seenLabel(t: number, now: number = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - t) / 60_000));
	if (mins < 60) return `Seen ${mins} min ago`;
	// ⛔ ALWAYS HOURS. Never "1 day ago", never "2 days ago".
	//
	// This row is the answer to "when did NASA last see fire there?", and it is
	// read by someone deciding whether to drive toward it. Rounding to days
	// throws away the exact resolution they are straining for — 23 h, 28 h and
	// 47 h all collapsed to "1 day ago", and the difference between them is the
	// difference between one missed satellite pass and four.
	//
	// It also read as indifference: a screen counting in days, about a fire,
	// looks like a screen that is not really trying. The feed only ever spans
	// ~37 h (FIRMS ships two calendar days), so hours never grow unwieldy —
	// "35h ago" is the largest honest number this row can print.
	//
	// ⚠️ FRACTIONAL past 10 h, and that is not fussiness. A flat `24h ago` reads
	// as a shrug — a suspiciously round number that sounds like the app rounded
	// because it could not be bothered. `23.7h ago` is visibly a MEASUREMENT, and
	// it is one: NASA stamps every detection to the minute (their own site shows
	// `2026-08-09 03:36:00`), so the precision is real, not invented.
	const hours = mins / 60;
	if (hours < 10) return `Seen ${Math.floor(hours)}h ago`;
	return `Seen ${hours.toFixed(1)}h ago`;
}

/**
 * "4 min ago" / "Just now" — how long since WE pinged the NASA feed.
 *
 * Minute resolution all the way up, because this is the number a person is
 * actively curious about and it is usually SMALL: the app refetches on app
 * open, on regaining focus, and the moment signal returns. "Just now" under a
 * minute rather than "0 min ago", which reads like a broken counter on the one
 * value meant to build confidence.
 */
export function pingAgo(t: number, now: number = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - t) / 60_000));
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = mins / 60;
	if (hours < 10) return `${Math.floor(hours)}h ago`;
	return `${hours.toFixed(1)}h ago`;
}

/** "Covers 375 m" — the detection's pixel footprint. A plain fact that also
 *  happens to stop the marker reading as a surveyed fire perimeter. Falls back
 *  to VIIRS's nominal 375 m when the feed omits the real one. */
export function footprintLine(px: number | undefined): string {
	const m = Math.round(sideKm(px) * 1000);
	return `Covers ${m} m`;
}

/** VIIRS's nominal pixel side, km. The feed supplies a real `px` per detection
 *  (pixels stretch toward the swath edge, up to ~0.75 km); this is the fallback
 *  when it doesn't. One place, so the four call sites can't drift. */
export const NOMINAL_PIXEL_KM = 0.375;

/**
 * Ground side of one grid cell, km — the quantum of "distinct burning ground".
 *
 * Pinned to VIIRS's nominal pixel rather than derived from `CELL_DEG × 111.32`
 * (which would give 0.417 km). The grid exists to represent one pixel of
 * detection; letting a degree-conversion rounding decide the answer would make
 * the reported area drift from the thing it claims to measure. `CELL_DEG` is
 * chosen to approximate exactly this, and a test pins the two within 15%.
 */
export const CELL_KM = NOMINAL_PIXEL_KM;

function sideKm(px: number | undefined): number {
	return Number.isFinite(px) && (px as number) > 0
		? (px as number)
		: NOMINAL_PIXEL_KM;
}

/**
 * Ground area burning, km² — the area of the UNIQUE cells, NOT a sum of
 * detections and NOT the area between them.
 *
 * ── The bug this replaced ──
 * This used to sum every detection's footprint. But FIRMS reports the SAME
 * GROUND once per satellite per overpass — three VIIRS birds × two calendar
 * days × several passes each — so one burning hectare was counted a dozen
 * times. A card read "Size — 239 km²" for a fire that was really ~95.
 *
 * Measured against live FIRMS for that exact cluster (one satellite, 2 days):
 *
 *     1,228 detections      naive sum      373 km²
 *       673 unique cells    deduped       94.6 km²  (9,464 ha)
 *         8 pass timestamps  overstatement    3.9×
 *
 * ── ⚠️ And it must NEVER become the area BETWEEN the dots ──
 * A convex hull round a cluster is the opposite error and a far worse one: the
 * user drew a polygon over six flame markers and it measured 22,328 ha, nearly
 * all of it unburnt hillside. Detections are evidence of fire AT a point; the
 * gaps between them are not evidence of anything.
 *
 * Cells are snapped on the SAME grid `staticHeatSources` uses (`cellKey`,
 * `CELL_DEG` ≈ 375 m = one VIIRS pixel). Reused deliberately — a second grid
 * constant is exactly the drift this file has been bitten by before.
 *
 * ── ⚠️ Each cell contributes ONE CELL of area, not its pixel's footprint ──
 * Tempting alternative, and it was tried: keep the largest `px` per cell and sum
 * `px²`. It over-counts, because pixels are BIGGER than the grid — measured on a
 * live cluster, px runs 0.4–0.7 km while cells sit 0.375 km apart, so adjacent
 * pixels overlap each other's ground. That produced 280 km² for 712 cells whose
 * distinct ground is ~100 km².
 *
 * The cell IS the unit of distinct ground. Overlapping evidence about the same
 * cell tells you the cell is burning; it does not make the cell bigger.
 */
export function clusterAreaKm2(
	hotspots: readonly {
		coordinates?: readonly [number, number];
		px?: number;
	}[],
): number {
	const cells = new Set<string>();
	let ungridded = 0;
	for (const h of hotspots) {
		const c = h.coordinates;
		if (c === undefined || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
			// Can't be gridded, so it can't be deduped — count its own footprint
			// once rather than dropping it. Only malformed input reaches here, and
			// under-reporting burned ground is the worse failure.
			ungridded += sideKm(h.px) ** 2;
			continue;
		}
		cells.add(cellKey(c[0], c[1]));
	}
	return ungridded + cells.size * CELL_KM ** 2;
}

/**
 * "9,464 ha" — fire size in HECTARES, the unit the job already speaks.
 *
 * Wildfire agencies (BC Wildfire, CIFFC) report fire size in hectares, and a
 * planter already thinks in them: blocks are measured in ha and they are paid
 * by the block. km² required a conversion nobody makes in their head — and it
 * flattered small fires badly, showing one detection as "0.14 km²", which reads
 * as nothing when it is 14 hectares of ground.
 *
 * Formatting mirrors `formatArea` in
 * harness/src/lib/getCache_OnlineMap/lib/mapDrawUtils.ts — the function that
 * renders "22,328 ha" on the user's own drawn polygons, so a fire and a block
 * are described the same way. It is MIRRORED rather than imported because that
 * module pulls in turf, and this one is deliberately pure (no map, DOM or
 * fetch). A test pins the two against each other so the duplication can't rot.
 */
export function areaLabel(km2: number): string {
	const ha = km2 * 100;
	// Floor at 1 m²: a detection with area is never "0 m²", and rounding a
	// sliver to zero would read as "nothing here" on a card about a fire.
	if (ha < 0.1)
		return `${Math.max(1, Math.round(km2 * 1_000_000)).toLocaleString()} m²`;
	if (ha < 10) return `${ha.toFixed(1)} ha`;
	return `${Math.round(ha).toLocaleString()} ha`;
}

/**
 * A card is a TITLE plus LABELLED ROWS — not sentences.
 *
 * Prose was tried and cut. Six full lines of "46 km W of Merritt, 100 km NNE of
 * Chilliwack" stacked on "14 fire spots detected over 2 km²" had to be READ, in
 * order, to find any one fact. Labelled rows can be SCANNED: someone who only
 * wants "how far is it" jumps straight to `From you`. The label also does the
 * qualifying work that used to clutter the value — `Size — 2 km²` needs no
 * explaining, where a bare "2 km²" did.
 */
export interface CardRow {
	readonly label: string;
	readonly value: string;
	/** 1–5 severity, on the Intensity row only — lets the UI draw a meter. */
	readonly level?: SeverityLevel;
	/**
	 * Trend direction, on the Intensity row only, so the UI can draw the trend
	 * badge beside the ring.
	 *
	 * The Status row STILL spells it out in words. The badge is a supplement, not
	 * a replacement — red-up/green-down is the classic colourblind confusion
	 * pair, so the words are what actually carry the meaning and the glyph is the
	 * at-a-glance echo (design handoff, "Interactions & Behavior").
	 */
	readonly trend?: TrendBand;
}

export interface FireCard {
	readonly title: string;
	readonly rows: readonly CardRow[];
}

/** Rows shared by both card kinds, in one place so the two cannot drift. */
function commonRows(opts: {
	level: SeverityLevel;
	status: string;
	trend: TrendBand;
	areaKm2: number;
	seenAt: number;
	/** When the satellite FIRST reported fire on this ground, if earlier than
	 *  `seenAt`. Null/absent on a single detection, which has only one sighting. */
	firstAt?: number | null;
	/** When WE last pinged NASA for this ground (`fetchedAt`). */
	pingedAt?: number | null;
	now: number;
	where: string | null;
	fromYou: string | null;
	industrial?: boolean;
}): CardRow[] {
	const rows: CardRow[] = [
		{
			label: "Intensity",
			value: `${opts.level} of 5`,
			level: opts.level,
			trend: opts.trend,
		},
		{ label: "Status", value: opts.status },
		{ label: "Size", value: areaLabel(opts.areaKm2) },
	];
	// FIRST vs LAST — the span, which is the one momentum fact the feed can
	// honestly support. NASA's own site shows exactly these two rows for a fire
	// (`2026-08-08 13:42` first, `2026-08-09 03:36` last), and the gap between
	// them is what says "burning for 14 hours" rather than "flared once".
	//
	// Shown ONLY when it differs from the last sighting: on a single detection
	// the two are the same instant, and printing the identical value twice is
	// the card padding itself.
	// ⛔ ONE detection row: FIRST. "Last detected" was removed — it was the row
	// that kept reading as a contradiction ("NASA last saw it 23h ago, but you
	// updated 13 min ago?"), because a person cannot be expected to hold the
	// difference between "a satellite last observed fire here" and "our copy of
	// the feed refreshed" while worrying about a fire.
	//
	// What survives is the pair that is unambiguous BY VERB:
	//   First detected — when NASA first saw fire here (how long it has burned)
	//   Last updated   — when we last pulled the feed (how current this screen is)
	//
	// Falls back to `seenAt` when there is only one sighting, so a lone detection
	// still says when it was seen.
	const firstSeen = opts.firstAt != null ? opts.firstAt : opts.seenAt;
	rows.push({ label: "First detected", value: seenAgo(firstSeen, opts.now) });
	// ⛔ "Last checked" — the row that answers the question people cannot help
	// asking, and asked here four separate times before it was built.
	//
	// The two rows above are NASA'S clock: when a satellite saw fire. This one is
	// OURS: when we last went and looked at the feed. A planter who has been out
	// of signal genuinely cannot tell, from any other row, whether the screen in
	// front of them is thirty seconds or three days old — and offline is exactly
	// when they most need to know.
	//
	// ⚠️ An earlier attempt at this was a row labelled `Checked`, and it was
	// rightly killed: sat under `Last seen` with no subject, it read as a
	// contradiction ("how could you SEE it if you hadn't CHECKED?"). The fix is
	// not to hide the fact — it is to distinguish DETECTING from UPDATING.
	// "First detected" is NASA seeing fire; "Last checked" is when we last asked
	// feed refreshing. Different verbs and different actors, so the pair cannot
	// read as two contradictory sightings.
	if (opts.pingedAt != null) {
		rows.push({
			label: "Last checked",
			value: pingAgo(opts.pingedAt, opts.now),
		});
	}
	// Omitted, never faked: with no gazetteer loaded or no GPS fix, the row
	// simply isn't there.
	if (opts.where) rows.push({ label: "Nearest", value: opts.where });
	if (opts.fromYou) rows.push({ label: "From you", value: opts.fromYou });
	// A known permanent source says so plainly. It is FLAGGED, not hidden — a
	// refinery genuinely can catch fire, so the detection stays reachable and
	// the card explains what it is rather than the map quietly lying by
	// omission.
	if (opts.industrial) rows.push({ label: "Source", value: INDUSTRIAL_LABEL });
	return rows;
}

/** "9h ago" — the row's label already says "Last seen", so the value must not
 *  repeat it. `seenLabel` keeps its "Seen …" prefix for prose callers. */
export function seenAgo(t: number, now: number = Date.now()): string {
	return seenLabel(t, now).replace(/^Seen /, "");
}

/** "146 km NE" — direction without "of you", which the label already says. */
export function fromYouValue(
	at: readonly [number, number],
	you: readonly [number, number] | null,
): string | null {
	const line = distanceLine(at, you);
	return line === null ? null : line.replace(/ of you$/, "");
}

export function buildHotspotCard(
	h: Pick<FireHotspot, "coordinates" | "t" | "frp"> & { px?: number },
	you: readonly [number, number] | null,
	now: number = Date.now(),
	/** "46 km W of Merritt · 100 km NNE of Chilliwack" — where the fire IS.
	 *  Optional: the gazetteer loads lazily, so an early tap omits the row. */
	where: string | null = null,
	/** True when this sits on a known permanent heat source. */
	industrial = false,
	/** When WE last pinged NASA for this ground. Omitted → no row. */
	pingedAt: number | null = null,
): FireCard {
	// One detection is a one-cell cluster, so it goes through the SAME area
	// function. Computing it inline here is how the single card and the cluster
	// card drift apart.
	const area = clusterAreaKm2([h]);
	const sev = severityFor(area, h.frp);
	return {
		title: "Fire detected",
		rows: commonRows({
			level: sev.level,
			// A single detection has one pass by definition — no trend to claim.
			status: TREND_STATUS.new,
			trend: "new",
			areaKm2: area,
			seenAt: h.t,
			pingedAt,
			now,
			where,
			fromYou: fromYouValue(h.coordinates, you),
			industrial,
		}),
	};
}

/**
 * A CLUSTER's card — what you get for tapping a group instead of zooming in.
 *
 * Deliberately the SAME shape as a single detection's card. A planter sees one
 * fire marker; whether it happens to be one satellite pixel or two thousand is
 * our plumbing, not their problem. The only extra row is the spot count, which
 * is what makes the area figure meaningful.
 *
 * ⚠️ Heat is the MAX, never a sum or average — twenty campfires must never read
 * as one inferno. Area IS summed: footprints are genuinely additive ground.
 */
export function buildClusterCard(
	hotspots: readonly (Pick<FireHotspot, "coordinates" | "t" | "frp"> & {
		px?: number;
	})[],
	centre: readonly [number, number],
	you: readonly [number, number] | null,
	now: number = Date.now(),
	where: string | null = null,
	industrial = false,
	/** When WE last pinged NASA for this ground. Omitted → no row. */
	pingedAt: number | null = null,
): FireCard {
	const n = hotspots.length;
	const area = clusterAreaKm2(hotspots);
	const peakFrp = hotspots.reduce((m, h) => Math.max(m, h.frp || 0), 0);
	// Most RECENT sighting: for "is this still going?", the newest pass is the
	// informative one, unlike the layer-wide stamp which reports the oldest.
	const newest = hotspots.reduce((m, h) => Math.max(m, h.t || 0), 0);
	// The EARLIEST sighting in this cluster — pairs with `newest` to show the
	// span the fire has been burning across, the way FIRMS' own table does.
	const oldest = hotspots.reduce(
		(m, h) => (h.t && (m === 0 || h.t < m) ? h.t : m),
		0,
	);
	const sev = severityFor(area, peakFrp);
	const trend = trendFor(hotspots);

	const rows = commonRows({
		level: sev.level,
		status: trend.status,
		trend: trend.band,
		areaKm2: area,
		seenAt: newest > 0 ? newest : now,
		firstAt: oldest > 0 ? oldest : null,
		pingedAt,
		now,
		where,
		fromYou: fromYouValue(centre, you),
		industrial,
	});
	// After Size: the count is what gives the area its meaning.
	const sizeAt = rows.findIndex((r) => r.label === "Size");
	rows.splice(sizeAt + 1, 0, {
		label: "Hot spots",
		value: `${n} detected`,
	});
	return { title: "Fire detected", rows };
}
