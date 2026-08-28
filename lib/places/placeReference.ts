/**
 * placeReference.ts — "18 km NE of Whitecourt".
 *
 * Turns a coordinate into the plain-language location reference wildfire
 * agencies actually use, so a detection reads as somewhere a person knows
 * rather than as two decimals.
 *
 * ── Why not reverse geocoding ──
 * Google/Mapbox reverse geocoding answers a DIFFERENT question: it returns the
 * administrative area CONTAINING the point ("Woodlands County"), not proximity
 * with a bearing. It also costs per request, restricts storage, and needs a
 * network — which is precisely absent at the block. Wrong operation, wrong
 * economics, wrong runtime.
 *
 * ── Why the tiers are in the DATA, not in a scoring function ──
 * The asset (`/mobileAssets/places-world.json`) is pre-tiered by population:
 * 0 = ≥15,000, 1 = ≥5,000, 2 = ≥1,000. So the cascade is a series of "nearest
 * hit within radius R at tier T" lookups rather than a population/distance
 * scoring heuristic nobody can reason about later. First hit wins for the
 * primary; the next LARGER tier supplies the anchor.
 *
 * ── Two tiers of answer, never one "best" place ──
 *     9 km E of Blue Ridge, 62 km SW of Edson
 * The small name locates you; the big name orients someone who has never heard
 * of it. Picking one always loses one of those jobs.
 *
 * This module is PURE — the dataset is injected. Loading/caching lives in
 * `placeIndex.ts`, so every rule here is testable without an asset fetch.
 */

/** One place: [name, lng, lat, tier, region]. `region` is the province/state
 *  ("British Columbia"), the high-level anchor everyone recognises. */
export type PlaceRow = readonly [string, number, number, number, string?];

/**
 * Prominence tiers, baked into the asset by ADMIN STATUS first, population
 * second — a provincial capital or county seat is a landmark whatever its
 * headcount, while a 100k dormitory suburb is no more useful than the city
 * beside it.
 *
 * ⚠️ The asset EXCLUDES GeoNames `PPLX` and friends — "section of populated
 * place", i.e. NEIGHBOURHOODS. That omission is load-bearing. With them in, the
 * card said "2 km SE of East Richmond–Fraser Lands, 4 km SW of Hamilton" for a
 * fire beside Vancouver: three names nobody outside those few blocks knows,
 * while a 4,220-person neighbourhood outranked a 101,491-person city because
 * the tiers were population-only. Naming a neighbourhood is worse than naming
 * nothing — it sounds authoritative and conveys no location.
 */
export const TIER_MAJOR = 0; // capital / admin seat, or ≥ 100,000
export const TIER_NOTABLE = 1; // 2nd-order admin seat, or ≥ 15,000
export const TIER_TOWN = 2; // ≥ 5,000
export const TIER_VILLAGE = 3; // ≥ 1,000

/**
 * Search radius per tier, km. A village only counts when you're nearly on top
 * of it; a major city is worth naming from far away because everyone knows
 * where it is.
 *
 * Deliberately NOT per-region: exceptions rot, and a rule that behaves the same
 * in Alberta and Aotearoa is one you can still reason about in a year.
 */
export const TIER_RADIUS_KM: Readonly<Record<number, number>> = {
	[TIER_VILLAGE]: 25,
	[TIER_TOWN]: 50,
	[TIER_NOTABLE]: 100,
	[TIER_MAJOR]: 250,
};

/** How far a place may be and still lend its PROVINCE as the last-resort
 *  anchor. Generous: "in British Columbia" is true across a wide area and is
 *  strictly better than bare coordinates. */
export const REGION_ANCHOR_KM = 400;

/** Under this, "at"/"near" rather than a bearing — never emit "0 km of X". */
export const AT_PLACE_KM = 2;

const EARTH_R = 6371;
const RAD = Math.PI / 180;

export function distanceKm(
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	const dLat = (b[1] - a[1]) * RAD;
	// Normalise the longitude delta into (-180, 180] so a pair straddling the
	// antimeridian measures the SHORT way round instead of most of the planet.
	let dLng = (b[0] - a[0]) % 360;
	if (dLng > 180) dLng -= 360;
	if (dLng < -180) dLng += 360;
	dLng *= RAD;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const POINTS_16 = [
	"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
	"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/**
 * Great-circle INITIAL bearing, rounded to 16 points.
 *
 * From the PLACE to the DETECTION — "18 km NE of Whitecourt" means the fire is
 * north-east of the town, so the town is the origin. Getting this backwards
 * points every reference 180° wrong and reads perfectly plausible, which is why
 * the tests state the direction in words.
 */
export function bearing16(
	from: readonly [number, number],
	to: readonly [number, number],
): string {
	const y = Math.sin((to[0] - from[0]) * RAD) * Math.cos(to[1] * RAD);
	const x =
		Math.cos(from[1] * RAD) * Math.sin(to[1] * RAD) -
		Math.sin(from[1] * RAD) *
			Math.cos(to[1] * RAD) *
			Math.cos((to[0] - from[0]) * RAD);
	const deg = (Math.atan2(y, x) / RAD + 360) % 360;
	return POINTS_16[Math.round(deg / 22.5) % 16];
}

/** Nearest 1 km under 100, nearest 10 km above — precision the data supports. */
export function roundKm(km: number): number {
	return km < 100 ? Math.round(km) : Math.round(km / 10) * 10;
}

export interface PlaceHit {
	readonly name: string;
	readonly km: number;
	readonly tier: number;
	readonly bearing: string;
	/** Province/state, for the high-level anchor. */
	readonly region: string;
}

/** Nearest place in exactly `tier`, within `maxKm`. */
export function nearestInTier(
	at: readonly [number, number],
	places: readonly PlaceRow[],
	tier: number,
	maxKm: number,
): PlaceHit | null {
	let best: PlaceHit | null = null;
	for (const p of places) {
		if (p[3] !== tier) continue;
		const km = distanceKm(at, [p[1], p[2]]);
		if (km > maxKm) continue;
		if (best === null || km < best.km) {
			best = {
				name: p[0],
				km,
				tier,
				bearing: bearing16([p[1], p[2]], at),
				region: p[4] ?? "",
			};
		}
	}
	return best;
}

/** The province/state of the nearest place of ANY tier within REGION_ANCHOR_KM.
 *  The last-resort orientation: "in British Columbia" beats bare coordinates
 *  and beats naming a village nobody has heard of. */
export function regionNear(
	at: readonly [number, number],
	places: readonly PlaceRow[],
	maxKm: number = REGION_ANCHOR_KM,
): string | null {
	let bestKm = Number.POSITIVE_INFINITY;
	let bestRegion = "";
	for (const p of places) {
		const region = p[4];
		if (!region) continue;
		const km = distanceKm(at, [p[1], p[2]]);
		if (km > maxKm || km >= bestKm) continue;
		bestKm = km;
		bestRegion = region;
	}
	return bestRegion === "" ? null : bestRegion;
}

/** "18 km NE of Whitecourt" / "at Kamloops" / "near Blue Ridge". */
export function phraseFor(hit: PlaceHit): string {
	const km = roundKm(hit.km);
	if (hit.km < AT_PLACE_KM || km === 0) return `at ${hit.name}`;
	return `${km} km ${hit.bearing} of ${hit.name}`;
}

export interface PlaceReference {
	/** The whole line, ready to render. */
	readonly text: string;
	readonly primary: PlaceHit | null;
	readonly anchor: PlaceHit | null;
}

/**
 * The reference line for a coordinate.
 *
 * Cascade from the SMALLEST tier outward: village → town → notable → major.
 * First hit wins the primary; the anchor is the nearest hit from a MORE
 * prominent tier, so the pair reads "here, near there".
 *
 * ── The high-level anchor is not optional ──
 * "24 km NNW of Fairfield Island, 28 km NNE of Cedar Valley" was two names
 * nobody knows stacked on each other. Even with neighbourhoods removed, a pair
 * of villages can do the same thing. So when the anchor is not itself a MAJOR
 * place, the province is appended: someone always gets one reference they
 * recognise.
 *
 *     18 km NE of Whitecourt, Alberta
 *     6 km S of Yale, 44 km NE of Chilliwack, British Columbia
 *     at Kamloops, British Columbia
 *
 * With nothing in range at all, the province alone still beats coordinates;
 * only when even that is missing do we print lat/lon.
 */
export function placeReference(
	at: readonly [number, number],
	places: readonly PlaceRow[],
): PlaceReference {
	const byTier = [TIER_VILLAGE, TIER_TOWN, TIER_NOTABLE, TIER_MAJOR].map((t) =>
		nearestInTier(at, places, t, TIER_RADIUS_KM[t]),
	);
	const hits = byTier.filter((h): h is PlaceHit => h !== null);

	// Smallest tier first — a nearby village locates you better than the city it
	// belongs to. BUT distance overrules prominence when the gap is large:
	// standing downtown, "20 km SE of Bowen Island" is absurd when Vancouver is
	// 2 km away. So a more prominent place wins if it is meaningfully CLOSER.
	// (This surfaced the moment suburb suppression removed the inner-city
	// villages that had been papering over it.)
	const primary =
		hits.length === 0
			? null
			: hits.reduce((best, h) => (h.km < best.km * 0.6 ? h : best), hits[0]);

	if (primary === null) {
		const region = regionNear(at, places);
		return {
			text: region ?? `${at[1].toFixed(4)}, ${at[0].toFixed(4)}`,
			primary: null,
			anchor: null,
		};
	}

	// Anchor: nearest hit from a MORE prominent tier, never the same name twice.
	const anchor =
		hits.find((h) => h.tier < primary.tier && h.name !== primary.name) ?? null;

	const parts = [phraseFor(primary)];
	if (anchor !== null) parts.push(phraseFor(anchor));

	// The recognisable one. Skipped when a MAJOR city is already named — "10 km
	// N of Vancouver, British Columbia" is redundant, everyone knows where
	// Vancouver is.
	const named = anchor ?? primary;
	if (named.tier !== TIER_MAJOR) {
		const region = named.region || regionNear(at, places);
		if (region) parts[parts.length - 1] = `${parts[parts.length - 1]}, ${region}`;
	}

	return { text: parts.join(", "), primary, anchor };
}

/**
 * A ReTreever block beats any town name for someone standing in it.
 *
 * "14 km NW of your Sundance block" is the reference a planter actually holds in
 * their head. Only used when the detection is within `maxKm` of a block the user
 * owns; otherwise the world cascade runs.
 */
export interface UserBlock {
	readonly name: string;
	readonly coordinates: readonly [number, number];
}

export const BLOCK_PREFER_KM = 60;

export function blockReference(
	at: readonly [number, number],
	blocks: readonly UserBlock[],
	maxKm: number = BLOCK_PREFER_KM,
): string | null {
	let best: { name: string; km: number; bearing: string } | null = null;
	for (const b of blocks) {
		const km = distanceKm(at, b.coordinates);
		if (km > maxKm) continue;
		if (best === null || km < best.km) {
			best = { name: b.name, km, bearing: bearing16(b.coordinates, at) };
		}
	}
	if (best === null) return null;
	const km = roundKm(best.km);
	if (best.km < AT_PLACE_KM || km === 0) return `at your ${best.name} block`;
	return `${km} km ${best.bearing} of your ${best.name} block`;
}

/** The full line: the user's own block if it's close, else the world cascade. */
export function locationLine(
	at: readonly [number, number],
	places: readonly PlaceRow[],
	blocks: readonly UserBlock[] = [],
): string {
	return blockReference(at, blocks) ?? placeReference(at, places).text;
}
