/**
 * urbanIndex.ts — loads the world urban-area polygons, once, off the hot path.
 *
 * The asset is ALREADY BUNDLED and already shipping: the offline map uses
 * `/mobileAssets/worldBase/base/min/urban.json` (Natural Earth urban areas, 11,878 polygons,
 * ~4.2 MB) to draw built-up shading. Reusing it costs nothing — no new
 * download, no new build step, and worldwide coverage on day one.
 *
 * That reuse is why the city rule beats the FIRMS-archive approach on every
 * axis: no per-region history pull, no yearly rebuild, and it works in Sweden
 * and Chile the moment it ships.
 *
 * ── Loading rules ──
 *   • LAZY — nothing loads until a fire layer attaches.
 *   • ONCE — concurrent callers share one in-flight promise.
 *   • NEVER FATAL, and it fails toward SHOWING FIRES. No polygons means nothing
 *     is excluded, which means every detection renders. A city hotspot slipping
 *     through is embarrassing; a real fire suppressed by a half-loaded asset is
 *     the failure this layer exists to prevent.
 */

import { type RegionBox, regionAround, regionChanged } from "../../../lib/shared/assetRegion";
import { prepareUrban, type UrbanPoly } from "./urbanExclusion";

const ASSET_URL = "/mobileAssets/worldBase/base/min/urban.json";

let cache: UrbanPoly[] | null = null;
let inFlight: Promise<UrbanPoly[]> | null = null;
/** Where the retained window is centred. `null` = nothing loaded yet. */
let loadedAround: [number, number] | null = null;

/**
 * Where to centre the retained window.
 *
 * Set by the fire layer from the user's anchors before it warms this asset. If
 * nothing sets it, the whole world is kept — the old behaviour, which is the
 * correct fallback: an unwindowed asset is heavy, but a WRONGLY windowed one
 * silently stops excluding city hotspots, and this layer's whole failure
 * direction is "when in doubt, show the fire".
 */
let regionCentre: [number, number] | null = null;

/**
 * Point the window at a centre. Call BEFORE `loadUrban`/`warmUrban`.
 *
 * Returns true if this invalidated an existing load (the user left the region),
 * so the caller knows a repaint is coming. Moving inside the region is a no-op —
 * see `regionChanged` for why the hysteresis band is deliberately wide.
 */
export function setUrbanRegion(centre: [number, number]): boolean {
	regionCentre = centre;
	if (cache === null || !regionChanged(loadedAround, centre)) return false;
	// Left the window — drop the parsed polygons so the next load rebuilds them
	// around the new centre. This is the ONLY path that frees them.
	cache = null;
	inFlight = null;
	loadedAround = null;
	return true;
}

export async function loadUrban(): Promise<UrbanPoly[]> {
	if (cache !== null) return cache;
	if (inFlight !== null) return inFlight;
	const centre = regionCentre;
	inFlight = (async () => {
		try {
			const res = await fetch(ASSET_URL);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const fc = (await res.json()) as { features?: unknown[] };
			if (!Array.isArray(fc?.features)) throw new Error("no features");
			// WINDOW AT PREPARE TIME. `prepareUrban` is where each polygon's ring is
			// retained, so this is the one moment we can decline to keep it — a
			// filter afterwards would already have paid the whole allocation. The
			// parsed `fc` itself is transient and collectable the moment this
			// returns; only the kept rings survive.
			const box: RegionBox | null = centre ? regionAround(centre) : null;
			cache = prepareUrban(
				fc.features as { geometry: { type: string; coordinates: unknown } }[],
				box,
			);
			loadedAround = centre;
			return cache;
		} catch (err) {
			// codestyle-allow-swallow: not a swallow — the console.warn below is the
			// visible signal. No polygons means nothing is excluded, so the layer fails
			// OPEN: fires still show.
			console.warn(
				"[fire] urban polygons unavailable — city hotspots will not be excluded",
				err,
			);
			cache = [];
			return cache;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Already-loaded polygons, or an empty array — which excludes nothing. */
export function peekUrban(): UrbanPoly[] {
	return cache ?? [];
}

/** Start the load without waiting. */
export function warmUrban(): void {
	if (cache === null && inFlight === null) void loadUrban();
}

/** Test seam. */
export function __resetUrbanForTest(): void {
	cache = null;
	inFlight = null;
}
