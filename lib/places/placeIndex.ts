/**
 * placeIndex.ts — loads the bundled world gazetteer, once, off the critical path.
 *
 * The asset (`/mobileAssets/places-world.json`, ~5.9 MB raw / 2.35 MB gzipped) is
 * GeoNames `cities1000`, filtered and tiered (see the rebuild recipe below) into
 * `[name, lng, lat, tier, region]` and pre-sorted by tier. It ships INSIDE the app, so a location reference works with no signal —
 * which is the only condition that matters, since the planter is at the block.
 *
 * ── Why not reverse geocoding ──
 * See placeReference.ts: a reverse geocoder answers "what area contains this
 * point", not "what is this near, and in which direction". Different question,
 * plus per-request cost and no offline path.
 *
 * ── Loading rules ──
 *   • LAZY. Nothing loads until something actually asks for a place name, so
 *     the map's first paint never waits on 5 MB.
 *   • ONCE. Concurrent callers share one in-flight promise.
 *   • NEVER FATAL. A failed load means location lines fall back to coordinates;
 *     it must not break the fire layer, let alone the map.
 *
 * ── Rebuilding the asset ──
 * GeoNames refreshes daily; a yearly rebuild is plenty. Verify the column layout
 * against https://download.geonames.org/export/dump/ first — this parser reads
 * BY INDEX because the dump's layout is documented and stable, unlike the FIRMS
 * CSV next door.
 *
 *   curl -O https://download.geonames.org/export/dump/cities1000.zip
 *   unzip cities1000.zip
 *   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *
 * Columns used: 1 = name, 4 = lat, 5 = lng, 7 = feature code, 8 = country,
 * 10 = admin1, 14 = population. Everything else is dropped — that trim is what
 * gets 30 MB down to ~6.
 *
 * The build applies THREE rules, all of which exist because of a real bad
 * reading on screen. Row shape is `[name, lng, lat, tier, region]`.
 *
 * 1. **Drop sub-city feature codes** — `PPLX` (section of populated place),
 *    `PPLA4`, `PPLA5`, `PPLH`, `PPLQ`, `PPLW`, `PPLR`, `PPLCH`. These are
 *    NEIGHBOURHOODS: Fairfield Island, Cedar Valley, Pudong, Marseille 13.
 *    The card once read "24 km NNW of Fairfield Island, 28 km NNE of Cedar
 *    Valley" — two names nobody outside those blocks knows.
 *
 * 2. **Tier by ADMIN STATUS first, population second.**
 *      0 major   = PPLC / PPLA (capital, 1st-order seat) or pop ≥ 100,000
 *      1 notable = PPLA2 (2nd-order seat)                or pop ≥ 15,000
 *      2 town    = pop ≥ 5,000
 *      3 village = pop ≥ 1,000
 *    Population alone let a 4,220-person neighbourhood outrank a 101,491-person
 *    city.
 *
 * 3. **Suppress suburbs geometrically** — drop any sub-MAJOR place within 12 km
 *    of a MAJOR city. ⚠️ This CANNOT be done with feature codes: GeoNames tags
 *    Burquitlam as plain `PPL`, indistinguishable from a standalone town.
 *    Geometry separates them cleanly — suburbs sit ≤10 km out (West End 8,
 *    Burquitlam 5), real towns further (Agassiz 15, Whitecourt 160). Drops
 *    ~22,000 rows and makes the asset SMALLER.
 *
 * ⚠️ The natural-feature tier (`H.LK` lakes, `T.MT` mountains, for "near Juith
 * Lake") is NOT in this asset. It needs the 400 MB `allCountries` dump filtered
 * by feature class, which is a separate build step — see docs/TODO.md.
 */

import { inRegion, regionAround, regionChanged } from "../shared/assetRegion";
import type { PlaceRow } from "./placeReference";

const ASSET_URL = "/mobileAssets/places-world.json";

let cache: PlaceRow[] | null = null;
let inFlight: Promise<PlaceRow[]> | null = null;
/** Where the retained window is centred. `null` = nothing loaded yet. */
let loadedAround: [number, number] | null = null;

/**
 * Where to centre the retained window (see assetRegion.ts).
 *
 * `null` keeps every row — the original behaviour, and the right fallback: a
 * gazetteer with no window is heavy, but one windowed on a WRONG centre gives
 * confidently incorrect place names, which is worse than falling back to
 * coordinates.
 */
let regionCentre: [number, number] | null = null;

/**
 * Point the window at a centre. Call BEFORE `loadPlaces`/`warmPlaces`.
 *
 * Returns true if this invalidated an existing load, so the caller knows the
 * next read re-parses. Moving inside the region is a no-op.
 */
export function setPlacesRegion(centre: [number, number]): boolean {
	regionCentre = centre;
	if (cache === null || !regionChanged(loadedAround, centre)) return false;
	cache = null;
	inFlight = null;
	loadedAround = null;
	return true;
}

/**
 * The gazetteer, loaded on first use. Returns an EMPTY array on failure rather
 * than throwing — callers degrade to coordinates, which is a worse label but a
 * working screen.
 */
export async function loadPlaces(): Promise<PlaceRow[]> {
	if (cache !== null) return cache;
	if (inFlight !== null) return inFlight;
	const centre = regionCentre;
	inFlight = (async () => {
		try {
			const res = await fetch(ASSET_URL);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const rows = (await res.json()) as PlaceRow[];
			if (!Array.isArray(rows)) throw new Error("gazetteer is not an array");
			// WINDOW. `rows` is ~100k boxed arrays; keeping the whole thing pinned
			// ~50 MB for the life of the session so that a fire tap in Washington
			// could have named a suburb of Mumbai. Row shape is
			// [name, lng, lat, tier, region] — indices 1 and 2.
			//
			// The filtered array is a NEW array holding only the surviving rows, so
			// the other ~99% become collectable as soon as `rows` goes out of scope
			// at the end of this function. (The row objects are shared, not copied —
			// we drop references, we do not clone.)
			cache =
				centre === null
					? rows
					: (() => {
							const box = regionAround(centre);
							return rows.filter((r) =>
								inRegion(box, Number(r[1]), Number(r[2])),
							);
						})();
			loadedAround = centre;
			return cache;
		} catch (err) {
			// codestyle-allow-swallow: not a swallow — the console.warn below is the
			// visible signal. A missing gazetteer degrades the wording of a fire label
			// to raw coordinates; there is no user action to report.
			console.warn("[fire] place gazetteer unavailable — using coordinates", err);
			cache = [];
			return cache;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Already-loaded rows, or null. Lets a synchronous render use the gazetteer
 *  when it happens to be warm without forcing an await. */
export function peekPlaces(): PlaceRow[] | null {
	return cache;
}

/** Start the load without waiting — call when a fire layer attaches so the
 *  first tap already has names ready. */
export function warmPlaces(): void {
	if (cache === null && inFlight === null) void loadPlaces();
}

/** Test seam. */
export function __resetPlacesForTest(): void {
	cache = null;
	inFlight = null;
}
