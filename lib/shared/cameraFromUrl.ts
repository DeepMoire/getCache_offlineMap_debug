/** ⚠️ ORDER IS LAT,LNG here — OPPOSITE of MapLibre/GeoJSON's [lng, lat]; the parse flips it once for the map. */

/** What the map needs: MapLibre's own [lng, lat] order, plus optional zoom. */
export interface UrlCamera {
	center: [number, number];
	zoom?: number;
}

/** Rough sanity — a swapped pair usually lands outside these. */
function validLatLng(lat: number, lng: number): boolean {
	return (
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		lat >= -90 &&
		lat <= 90 &&
		lng >= -180 &&
		lng <= 180
	);
}

/** "58.7986,-122.6761" → [lng, lat], or undefined if it isn't a pair. */
function parsePair(raw: string): [number, number] | undefined {
	const parts = raw.split(",");
	if (parts.length !== 2) return undefined;
	const lat = Number(parts[0].trim());
	const lng = Number(parts[1].trim());
	if (!validLatLng(lat, lng)) return undefined;
	// FLIPPED HERE, ONCE. Everything downstream is [lng, lat].
	return [lng, lat];
}

/** undefined means "nothing was asked for" — the caller keeps its own default, never a fabricated one. */
export function cameraFromUrl(search: string): UrlCamera | undefined {
	const q = search.startsWith("?") ? search.slice(1) : search;
	if (!q) return undefined;

	let center: [number, number] | undefined;
	let zoom: number | undefined;

	for (const seg of q.split("&")) {
		if (!seg) continue;
		const eq = seg.indexOf("=");
		const key = eq === -1 ? "" : decodeURIComponent(seg.slice(0, eq));
		const val = decodeURIComponent(eq === -1 ? seg : seg.slice(eq + 1));

		if (key === "z" || key === "zoom") {
			const z = Number(val);
			// MapLibre's own range. Out of range is a typo, not an intent.
			if (Number.isFinite(z) && z >= 0 && z <= 24) zoom = z;
			continue;
		}
		// `at=…`, bare `…`, and `=…` all mean the same thing.
		if (!center && (key === "at" || key === "")) center = parsePair(val);
	}

	return center ? { center, zoom } : undefined;
}
