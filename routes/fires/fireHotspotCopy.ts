/**
 * fireHotspotCopy.ts — the words a planter reads when they tap a fire marker.
 *
 * Editorial rule: facts, not disclaimers — state what the satellite measured and let it stand.
 * ⚠️ Never show confidence (l/n/h) — sensor-internal quality flag, not actionable; reads as noise dressed as rigour.
 * ⚠️ Never show raw FRP in MW — forces the reader to decode units; the intensity BAND is the same info in words they already have.
 * No agency link — a per-region jurisdiction table (BC Wildfire/CIFFC/EFFIS/…) isn't worth maintaining for the whole world; the card stands on the measurement.
 * Pure string/number functions — no map, no DOM, no fetch — so every phrase is testable without a browser.
 */

import {
	type SeverityLevel,
	severityFor,
	TREND_STATUS,
	type TrendBand,
	trendFor,
} from "./fireSeverity";
// CELL_DEG is NOT imported — this module pins its cell size to VIIRS's
// nominal pixel (CELL_KM) instead; see the note on CELL_KM below.
import { cellKey, INDUSTRIAL_LABEL } from "./masks/staticHeatSources";
import type { FireHotspot } from "./fireCache";

/** Intensity bands off FRP (fire radiative power, MW) — coarse on purpose, since FRP swings with viewing angle/cloud; raw MW is computed but never shown (see header). */
export type FireIntensity = "low" | "moderate" | "high" | "extreme";

export function intensityOf(frp: number): FireIntensity {
	if (!Number.isFinite(frp) || frp < 10) return "low";
	if (frp < 50) return "moderate";
	if (frp < 200) return "high";
	return "extreme";
}

/** Plain-English intensity — no editorialising about cause; that belongs to static-source flagging, not a word here. */
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

/** Great-circle km — local copy keeps this module dependency-free so the copy can be tested without pulling in map/worker code. */
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

/** 8-point compass bearing — direction beats degrees in the field: "north-east of you" is actionable, "047°" is not. */
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

/** "336 km NE of you" — or null with no fix, in which case the line is omitted rather than a distance invented. */
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

/** "Seen 21h ago" — when the SATELLITE saw it. Distinct from when we fetched it (the layer-wide stamp); this is the one that matters per marker. */
export function seenLabel(t: number, now: number = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - t) / 60_000));
	if (mins < 60) return `Seen ${mins} min ago`;
	// ⛔ ALWAYS HOURS, never days — 23h/28h/47h all collapsing to "1 day ago"
	// throws away the exact resolution (one missed pass vs four); feed spans
	// ~37h max.
	// ⚠️ FRACTIONAL past 10h — a flat `24h ago` reads as a shrug; NASA stamps
	// to the minute so the precision is real, not invented.
	const hours = mins / 60;
	if (hours < 10) return `Seen ${Math.floor(hours)}h ago`;
	return `Seen ${hours.toFixed(1)}h ago`;
}

/** "4 min ago"/"Just now" — how long since WE pinged NASA. Minute resolution throughout since this value is usually small and meant to build confidence; "Just now" under a minute, never "0 min ago" (reads like a broken counter). */
export function pingAgo(t: number, now: number = Date.now()): string {
	const mins = Math.max(0, Math.floor((now - t) / 60_000));
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = mins / 60;
	if (hours < 10) return `${Math.floor(hours)}h ago`;
	return `${hours.toFixed(1)}h ago`;
}

/** "Covers 375 m" — the detection's pixel footprint; also stops the marker reading as a surveyed fire perimeter. Falls back to VIIRS's nominal 375 m when the feed omits the real one. */
export function footprintLine(px: number | undefined): string {
	const m = Math.round(sideKm(px) * 1000);
	return `Covers ${m} m`;
}

/** VIIRS's nominal pixel side, km — fallback when the feed's real px is missing (real px stretches to ~0.75km at swath edge). One place so the four call sites can't drift. */
export const NOMINAL_PIXEL_KM = 0.375;

/** Ground side of one grid cell, km — the quantum of "distinct burning ground". Pinned to VIIRS's nominal pixel, NOT derived from CELL_DEG × 111.32 (0.417km) — that rounding would let the reported area drift from what it claims to measure; a test pins the two within 15%. */
export const CELL_KM = NOMINAL_PIXEL_KM;

function sideKm(px: number | undefined): number {
	return Number.isFinite(px) && (px as number) > 0
		? (px as number)
		: NOMINAL_PIXEL_KM;
}

/**
 * Ground area burning, km² — the area of the UNIQUE cells, NOT a sum of detections and NOT the area between them.
 * BUG THIS REPLACED: used to sum every detection's footprint — FIRMS reports the same ground per satellite per overpass, so one hectare was counted a dozen times (1,228 detections → naive 373 km² vs 673 unique cells → 94.6 km², 3.9× overstatement).
 * ⚠️ Must NEVER become the area BETWEEN the dots — a convex hull round six flame markers measured 22,328 ha of mostly unburnt hillside; detections are evidence of fire AT a point, gaps between them are not evidence of anything.
 * Cells are snapped on the SAME grid staticHeatSources uses (cellKey, CELL_DEG ≈ 375m) — reused deliberately, a second grid constant is exactly the drift this file has been bitten by before.
 * ⚠️ Each cell contributes ONE CELL of area, never its pixel's footprint — summing px² over-counts since pixels (0.4–0.7km) are bigger than the 0.375km grid and overlap; that produced 280 km² for 712 cells whose real ground is ~100 km².
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
			// Can't be gridded → can't be deduped, so count its own footprint once
			// rather than dropping it; under-reporting burned ground is the worse
			// failure.
			ungridded += sideKm(h.px) ** 2;
			continue;
		}
		cells.add(cellKey(c[0], c[1]));
	}
	return ungridded + cells.size * CELL_KM ** 2;
}

/** "9,464 ha" — fire size in HECTARES, the unit the job already speaks (wildfire agencies report in ha; km² flattered small fires, e.g. "0.14 km²" for 14 ha). Formatting mirrors (not imports — that pulls in turf) `formatArea` in harness/src/lib/getCache_OnlineMap/lib/mapDrawUtils.ts; a test pins the two against each other. */
export function areaLabel(km2: number): string {
	const ha = km2 * 100;
	// Floor at 1 m² — a detection is never "0 m²"; rounding a sliver to zero
	// reads as "nothing here" on a fire card.
	if (ha < 0.1)
		return `${Math.max(1, Math.round(km2 * 1_000_000)).toLocaleString()} m²`;
	if (ha < 10) return `${ha.toFixed(1)} ha`;
	return `${Math.round(ha).toLocaleString()} ha`;
}

/** A card is a TITLE plus LABELLED ROWS, not sentences — prose had to be read in order to find one fact; labelled rows can be scanned. */
export interface CardRow {
	readonly label: string;
	readonly value: string;
	/** 1–5 severity, on the Intensity row only — lets the UI draw a meter. */
	readonly level?: SeverityLevel;
	/** Trend direction, on the Intensity row only, so the UI can draw the trend badge beside the ring — Status still spells it out in words since red-up/green-down is a classic colourblind confusion pair. */
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
	/** When the satellite FIRST reported fire on this ground, if earlier than `seenAt`. Null/absent on a single detection, which has only one sighting. */
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
	// FIRST vs LAST is the one momentum fact the feed can honestly support
	// (NASA's site shows exactly these two rows); shown only when it differs
	// from the last sighting, else it's the card padding itself.
	//
	// ⛔ ONE detection row: FIRST — "Last detected" was removed, it read as a
	// contradiction ("NASA saw it 23h ago, but updated 13 min ago?"); falls
	// back to seenAt for a lone detection.
	const firstSeen = opts.firstAt != null ? opts.firstAt : opts.seenAt;
	rows.push({ label: "First detected", value: seenAgo(firstSeen, opts.now) });
	// ⛔ "Last checked" = OUR clock (when we last asked the feed), distinct
	// from the NASA clock above (when the satellite saw fire) — a planter
	// offline can't otherwise tell if the screen is 30s or 3 days old.
	// ⚠️ An earlier row named `Checked` under `Last seen` read as a
	// contradiction ("how could you SEE it if you hadn't CHECKED?") and was
	// rightly killed; distinguishing DETECTING from UPDATING is the fix.
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
	// A known permanent source is FLAGGED, not hidden — a refinery can
	// genuinely catch fire, so the detection stays reachable and the card
	// explains rather than silently omitting it.
	if (opts.industrial) rows.push({ label: "Source", value: INDUSTRIAL_LABEL });
	return rows;
}

/** "9h ago" — the row's label already says "Last seen", so the value must not repeat it. `seenLabel` keeps its "Seen …" prefix for prose callers. */
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
	/** "46 km W of Merritt · 100 km NNE of Chilliwack" — where the fire IS. Optional: the gazetteer loads lazily, so an early tap omits the row. */
	where: string | null = null,
	/** True when this sits on a known permanent heat source. */
	industrial = false,
	/** When WE last pinged NASA for this ground. Omitted → no row. */
	pingedAt: number | null = null,
): FireCard {
	// One detection is a one-cell cluster, so it goes through the SAME area
	// function — computing it inline here is how the single/cluster cards
	// would drift apart.
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
 * A CLUSTER's card — deliberately the SAME shape as a single detection's card; the only extra row is the spot count.
 * ⚠️ Heat is the MAX, never a sum or average — twenty campfires must never read as one inferno. Area IS summed (footprints are genuinely additive ground).
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
	// Most RECENT sighting — the newest pass is informative for "is this still
	// going?", unlike the layer-wide stamp which reports the oldest.
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
