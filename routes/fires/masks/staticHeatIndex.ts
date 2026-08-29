/**
 * Loads the persistent-heat-source mask (see staticHeatSources.ts for the rule).
 * LAZY (loads on first fire-layer attach), ONCE (concurrent callers share one in-flight promise).
 * ⚠️ NEVER FATAL — fails toward SHOWING FIRES: a missing mask flags nothing as industrial rather than risk suppressing a real fire.
 * Rebuild yearly via scripts/buildStaticHeatMask.py as industry changes.
 */

const ASSET_URL = "/mobileAssets/static-heat-sources.json";

let cache: Set<string> | null = null;
let inFlight: Promise<Set<string>> | null = null;

export async function loadStaticMask(): Promise<Set<string>> {
	if (cache !== null) return cache;
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		try {
			const res = await fetch(ASSET_URL);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const keys = (await res.json()) as string[];
			if (!Array.isArray(keys)) throw new Error("mask is not an array");
			cache = new Set(keys);
			return cache;
		} catch (err) {
			// codestyle-allow-swallow: not a swallow — console.warn below is the visible signal; empty mask fails OPEN (safe for a wildfire layer).
			console.warn(
				"[fire] industrial-source mask unavailable — showing all detections",
				err,
			);
			cache = new Set();
			return cache;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

/** Already-loaded mask, or empty set — lets a synchronous render use it when warm without an await, and fail toward showing fires when not. */
export function peekStaticMask(): Set<string> {
	return cache ?? new Set();
}

/** Start the load without waiting. */
export function warmStaticMask(): void {
	if (cache === null && inFlight === null) void loadStaticMask();
}

/** Test seam. */
export function __resetStaticMaskForTest(): void {
	cache = null;
	inFlight = null;
}
