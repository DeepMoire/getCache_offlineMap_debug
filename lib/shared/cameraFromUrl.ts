/**
 * THE CAMERA, FROM THE URL. One place, both routes.
 *
 * `/offline` and `/offline/debug` are the same component, so a coordinate in
 * the query string opens BOTH at the same spot — which is the whole point:
 * you see a bug on one, change `/offline` to `/offline/debug` in the address
 * bar, and land on the identical view with the rails up. A debugger that
 * cannot be pointed at the thing you just saw is not a debugger.
 *
 * ⚠️ ORDER IS LAT,LNG — the order a phone's GPS reports, the order Google
 * Maps prints, the order a human reads one off a screen. It is the OPPOSITE
 * of the [lng, lat] order MapLibre and GeoJSON use internally, and that
 * mismatch is the single thing this module exists to get right: the parse
 * takes what a human pastes and returns what the map wants.
 *
 * Accepted, all equivalent:
 *   ?at=58.7986,-122.6761          named, the form to prefer
 *   ?58.7986,-122.6761             bare — a pasted pair with nothing else
 *   ?=58.7986,-122.6761            bare with a stray `=`, which is what you
 *                                  get pasting into an empty query string
 *   ?at=58.7986,-122.6761&z=13     with a zoom
 *
 * The bare forms are supported because they are what actually gets typed. A
 * parser that rejects the spelling a human reaches for first is a parser that
 * sends them back to hardcoding coordinates in the source.
 */

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

/**
 * Read a camera out of a query string. `undefined` means "nothing was asked
 * for" — the caller keeps its own default rather than being handed a
 * fabricated one. [[no-silent-fallbacks]]
 *
 * @param search  `location.search`, with or without the leading `?`.
 */
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
