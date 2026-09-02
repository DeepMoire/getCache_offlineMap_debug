/**
 * rawWallProtocol.ts — serve DOWNLOADED tiles to MapLibre with NO decode.
 * ⚠️ pack holds every zoom in BLOB_ZOOMS with no re-cutting — a downloaded-but-unserved zoom band renders a silent blank map, not an error.
 * ⚠️ `land`, `roadlabels`, `places` are NOT covered — those source-layers are derived on-device and stay on the old (decode) path.
 * ⛔ a z13-z14 blank-map hole is NOT fixed by style-layer maxzoom, source minzoom, or source maxzoom — all three were tried and disproved; don't re-try them. The fix is a real tile in the band (see MID_RING_Z in packBuilder.ts).
 */

import maplibregl from "maplibre-gl";

import { vlog } from "../../shared/verboseLog";

import { BLOB_MAX_Z, BLOB_MIN_Z } from "../../contract/roadBlob";

import { idbGetTileForAddress } from "../../worker/worker-local-dev/roads/packDownload";

/**
 * THE source id — ONE disc, ONE source, every zoom.
 * ⛔ never split into per-zoom-band sources again — that let z12/z13 tiles fall between declared bands and render nothing, silently.
 */
export const RAW_SOURCE = "v4-raw";
export const RAW_SCHEME = "rtraw";

export const RAW_TILE_URL = `${RAW_SCHEME}://disc/{z}/{x}/{y}`;

/** The disc's zoom span, DERIVED from `BLOB_ZOOMS` — never hand-written. `roadBlob.ts` is the only file allowed to name a road zoom or radius. */
/**
 * The render floor EQUALS the shallowest stored level — below it this source is SILENT by design, and the world-base (offlineBaseStyle.ts) draws major roads, lakes, borders and labels instead.
 * ⛔ do NOT lower it to "stretch" the stored tile over a shallower address — a z8-framed tile served at a z6 address paints 4×-off-place geometry (the zoom<8 distortion bug, killed 2026-09-01).
 * (History: minzoom was once set shallow so the blob itself filled the zoomed-out view; that invented the distortion instead of leaving the band to the base style.)
 */
export const RAW_MIN_Z = BLOB_MIN_Z;
export const RAW_MAX_Z = BLOB_MAX_Z;

let installed = false;

/** Registers the raw-tile protocol (idempotent) — reads one tile from IndexedDB per request and returns its bytes untouched, no parse/merge/cut. */
export function installRawWallProtocol(): void {
	if (installed) return;
	installed = true;

	maplibregl.addProtocol(RAW_SCHEME, async (params, abortController) => {
		// ⚠️ reject an aborted request with AbortError rather than resolving — resolving leaves the promise pending forever (same rule as wallProtocol).
		if (abortController.signal.aborted) {
			throw Object.assign(new Error("aborted"), { name: "AbortError" });
		}

		// `rtraw://disc/15/5245/11454` → ["15","5245","11454"]
		const m = /^rtraw:\/\/[a-z]+\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
		if (!m) throw notFound(params.url);

		const [, z, x, y] = m;
		// ⛔ resolve the address to EVERY owning pin, layer-merged into ONE tile — roads are keyed by pin, not bare z/x/y; resolving to a single "nearest" pin serves one pin's roads to another (the 50 km bug, 2026-08-20), and byte-concat keeps only the last same-named layer (the strips bug, 2026-09-01).
		const buf = await idbGetTileForAddress(Number(z), Number(x), Number(y));
		noteTileRead(!!buf && buf.byteLength > 0);
		// ⚠️ a miss is the common path, not an error — fail loud only on returning another pin's bytes, never on a routine 404 for an undownloaded tile.
		if (!buf || buf.byteLength === 0) throw notFound(params.url);

		// ⚠️ fresh copy per request — the buffer is TRANSFERRED to MapLibre's worker and detached, so handing out the cached one would neuter the stored copy on first use.
		return { data: buf.slice(0) };
	});
}

/**
 * Tally tile reads and speak ONLY when the ANSWER CHANGES — prints on the burst where the reading flips (reading tiles ↔ reading nothing), not per burst. Opt in to every burst via `localStorage.rtVerbose = 'wall'`.
 * ⛔ a transition is a flip that STICKS, not a bare flip — must hold for SETTLE_MS before it prints, or panning across a jagged disc edge triggers false alternating ⚠️/✅ noise.
 */
let hits = 0;
let misses = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** ⛔ seeded to `false` (reading fine), NOT null — seeding to null makes the very first burst read as a "recovery" and prints a false "✅ reading tiles again" on every fresh page load. */
let lastBlind: boolean | null = false;
/** Called when the map is confirmed blind (asking, finding nothing) — set by the route, so detection and recovery stay in sync. See onBlind?.() below. */
let onBlind: (() => void) | undefined;

/** Register the recovery to run when a blind reading is confirmed. */
export function setRawWallBlindHandler(fn: () => void): void {
	onBlind = fn;
}
/** A flip seen but not yet announced — cleared the moment the reading flips back, which is what makes a pan across the pack edge silent. */
let pendingBlind: boolean | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
/** How long a changed reading must HOLD before it counts — long enough to outlast a pan/zoom (~1 burst), short enough the user is still looking when a genuinely dead map says so. */
const SETTLE_MS = 2500;
function noteTileRead(found: boolean): void {
	if (found) hits++;
	else misses++;
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		const read = hits + misses;
		const blind = hits === 0;
		// Opt-in firehose: every burst, for when you are actually chasing this.
		vlog("wall", `read ${read} tiles — ${hits} found, ${misses} not on disk`);
		// ⚠️ console.warn, not .log — DevTools' default filter hides info-level output; do not "tidy" this to console.log.
		if (blind === lastBlind) {
			// Back to the announced state — whatever flip was pending was a blip.
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = null;
			pendingBlind = null;
		} else if (blind !== pendingBlind) {
			// A new flip — (re)start the settle clock; it only speaks if the reading still holds when the clock runs out.
			if (settleTimer) clearTimeout(settleTimer);
			pendingBlind = blind;
			settleTimer = setTimeout(() => {
				settleTimer = null;
				lastBlind = blind;
				pendingBlind = null;
				if (blind) {
					console.warn(
						`[roads] ⚠️ map is reading NOTHING from disk (${read} tiles asked, 0 found) — nothing will draw`,
					);
					// ⛔ self-heal, don't just narrate — a blind reading with tiles on disk means MapLibre is stuck on cached 404s from before the download landed and will never retry on its own; call onBlind?.() to force it.
					onBlind?.();
				}
				else console.warn(`[roads] ✅ reading tiles from disk again`);
			}, SETTLE_MS);
		}
		hits = 0;
		misses = 0;
	}, 700);
}

function notFound(url: string): Error {
	// MapLibre treats a 404-shaped rejection as "no tile here" and renders nothing, silently — the correct outcome for a sparse pyramid.
	return Object.assign(new Error(`no tile: ${url}`), { status: 404 });
}

/**
 * THE source spec — one disc, one span, every zoom.
 * ⛔ the span must match BLOB_ZOOMS exactly — wider promises levels that don't exist (404, blank map); narrower hides levels that DO exist on disk (tiles present, nothing paints). `minzoom` is deliberately NOT tied to `maxzoom` — see RAW_MIN_Z.
 */
export function rawSourceSpec(): maplibregl.VectorSourceSpecification {
	return {
		type: "vector",
		tiles: [RAW_TILE_URL],
		// ⛔ minzoom is the SHALLOWEST STORED LEVEL the pack holds, not 0 and not the detail level — source minzoom/maxzoom describe the tile pyramid, not the camera.
		// ⚠️ minzoom: 0 does NOT mean "scale the deepest level to fill any zoom" — it means z0 addresses may be requested, and if the pack doesn't have them: 404, blank map, no error.
		// Below RAW_MIN_Z the camera shows the world-base only — that handover is the design, not a hole.
		minzoom: RAW_MIN_Z,
		maxzoom: RAW_MAX_Z,
	};
}

/**
 * TELL THE MAP THE DISK CHANGED — MapLibre caches a 404 from before the download landed, and a tile that missed once is never requested again.
 * ⛔ do not "fix" a blank map by re-adding the source or layers — that rebuilds the whole stack and drops the per-pin satellite layers. `setTiles` with the same URL is the narrow tool: it only invalidates the tile cache.
 */
export function refreshRawTiles(map: maplibregl.Map): void {
	const src = map.getSource(RAW_SOURCE);
	// Not mounted yet (or torn down mid-flight) — the next mount reads fresh; SILENT on purpose, a routine race at page bring-up, not a fault.
	if (!src || typeof (src as maplibregl.VectorTileSource).setTiles !== "function") {
		vlog("wall", "refresh skipped — source not mounted yet");
		return;
	}
	// ⛔ vlog only, not console — an unprompted console line here would duplicate the outcome that arrives ~200ms later via the [offline] verdict on the next idle.
	vlog("wall", "new tiles on disk → telling the map to re-request");
	(src as maplibregl.VectorTileSource).setTiles([RAW_TILE_URL]);
}
