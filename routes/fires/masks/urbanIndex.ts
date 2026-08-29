/**
 * urbanIndex.ts — loads the world urban-area polygons, once, off the hot path.
 *
 * LAZY — nothing loads until a fire layer attaches.
 * ONCE — concurrent callers share one in-flight promise.
 * NEVER FATAL — fails toward SHOWING FIRES; a real fire suppressed by a half-loaded asset is the failure this layer exists to prevent.
 */

import { type RegionBox, regionAround, regionChanged } from "../../../lib/shared/assetRegion";
import { prepareUrban, type UrbanPoly } from "./urbanExclusion";

const ASSET_URL = "/mobileAssets/worldBase/base/min/urban.json";

let cache: UrbanPoly[] | null = null;
let inFlight: Promise<UrbanPoly[]> | null = null;
/** Where the retained window is centred. `null` = nothing loaded yet. */
let loadedAround: [number, number] | null = null;

/** Where to centre the retained window. If unset, the whole world is kept — the correct fallback: a WRONGLY windowed asset silently stops excluding city hotspots, and this layer's failure direction is "when in doubt, show the fire". */
let regionCentre: [number, number] | null = null;

/** Point the window at a centre. Call BEFORE `loadUrban`/`warmUrban`. Returns true if this invalidated an existing load (repaint coming); moving inside the region is a no-op. */
export function setUrbanRegion(centre: [number, number]): boolean {
	regionCentre = centre;
	if (cache === null || !regionChanged(loadedAround, centre)) return false;
	// Left the window — drops the parsed polygons; the ONLY path that frees them.
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
			const box: RegionBox | null = centre ? regionAround(centre) : null;
			cache = prepareUrban(
				fc.features as { geometry: { type: string; coordinates: unknown } }[],
				box,
			);
			loadedAround = centre;
			return cache;
		} catch (err) {
			// codestyle-allow-swallow: console.warn below is the visible signal; fails OPEN — fires still show.
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
