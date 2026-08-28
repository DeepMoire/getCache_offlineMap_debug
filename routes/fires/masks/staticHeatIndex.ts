/**
 * staticHeatIndex.ts — loads the persistent-heat-source mask.
 *
 * The asset (`/mobileAssets/static-heat-sources.json`) is a flat array of
 * ~375 m cell keys, derived from a YEAR of FIRMS archive history. See
 * `staticHeatSources.ts` for the rule and why it beats an urban-polygon filter.
 *
 * ── Loading rules (same shape as placeIndex) ──
 *   • LAZY — nothing loads until a fire layer attaches.
 *   • ONCE — concurrent callers share one in-flight promise.
 *   • NEVER FATAL, and it fails toward SHOWING FIRES. A missing mask means an
 *     empty set, which means nothing is flagged industrial, which means every
 *     detection renders as a wildfire. That is the correct direction to fail:
 *     a refinery briefly mislabelled as a fire is an annoyance, whereas a real
 *     fire suppressed because the mask half-loaded is the failure this whole
 *     layer exists to prevent.
 *
 * ── Rebuilding ──
 * `scripts/buildStaticHeatMask.py` pulls the archive and writes the asset.
 * Rerun it yearly — industry changes, and the rule re-derives rather than
 * needing a hand-maintained list.
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
			// codestyle-allow-swallow: not a swallow — the console.warn below is the
			// visible signal. An empty mask fails OPEN (shows every detection), which is
			// the safe direction for a wildfire layer.
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

/** Already-loaded mask, or an empty set. Lets a synchronous render use the mask
 *  when warm without forcing an await — and fail toward showing fires when not. */
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
