/**
 * placeReference.ts — "18 km NE of Whitecourt".
 * Pure — dataset is injected; loading/caching lives in placeIndex.ts.
 */

/** One place: [name, lng, lat, tier, region]. region = province/state, the high-level anchor. */
export type PlaceRow = readonly [string, number, number, number, string?];

/** ⚠️ Asset EXCLUDES GeoNames PPLX/neighbourhoods — load-bearing: naming a neighbourhood sounds authoritative but conveys no real location. Tiered by ADMIN STATUS first, population second. */
export const TIER_MAJOR = 0; // capital / admin seat, or ≥ 100,000
export const TIER_NOTABLE = 1; // 2nd-order admin seat, or ≥ 15,000
export const TIER_TOWN = 2; // ≥ 5,000
export const TIER_VILLAGE = 3; // ≥ 1,000

/** Search radius per tier, km — deliberately NOT per-region. */
export const TIER_RADIUS_KM: Readonly<Record<number, number>> = {
	[TIER_VILLAGE]: 25,
	[TIER_TOWN]: 50,
	[TIER_NOTABLE]: 100,
	[TIER_MAJOR]: 250,
};

/** How far a place may be and still lend its PROVINCE as the last-resort anchor. */
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
	// Normalise lng delta into (-180, 180] — antimeridian pairs must measure the SHORT way.
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

/** ⚠️ Great-circle initial bearing, PLACE→DETECTION not reversed — a flipped origin is 180° wrong and looks plausible. */
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

/** Province/state of the nearest place within REGION_ANCHOR_KM — last-resort orientation, beats bare coordinates. */
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

/** Cascade village→town→notable→major; first hit = primary, nearest MORE prominent tier = anchor. When the anchor isn't MAJOR, the province is appended so there's always one recognisable name. */
export function placeReference(
	at: readonly [number, number],
	places: readonly PlaceRow[],
): PlaceReference {
	const byTier = [TIER_VILLAGE, TIER_TOWN, TIER_NOTABLE, TIER_MAJOR].map((t) =>
		nearestInTier(at, places, t, TIER_RADIUS_KM[t]),
	);
	const hits = byTier.filter((h): h is PlaceHit => h !== null);

	// Smallest tier wins, but a more prominent tier overrides if genuinely closer (< 0.6× distance) — else "near a village" beats "in the city" from 2 km away.
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

	// Skip province suffix when a MAJOR city is already named — redundant.
	const named = anchor ?? primary;
	if (named.tier !== TIER_MAJOR) {
		const region = named.region || regionNear(at, places);
		if (region) parts[parts.length - 1] = `${parts[parts.length - 1]}, ${region}`;
	}

	return { text: parts.join(", "), primary, anchor };
}

/** A user's own block beats any town name when within maxKm; otherwise the world cascade runs. */
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
