// Remembers WHICH MAP the user was last using, so the bottom bar's MAP tab
// returns them to it instead of always to the online map.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// There are two map routes — `/map` (online, Mapbox) and
// `/offline` (offline, MapLibre) — and the crow switch navigates
// between them (a real `goto`, not a style swap; see mapViewport.ts).
//
// The bottom bar's MAP tab used to carry the literal string "/map".
// That made the choice UNOWNED: it lived only in whatever URL you happened
// to be on, so leaving the map for CACHE/STATS and tapping MAP again threw
// it away and dumped you back on the online map every time. Persisting the
// camera (mapViewport.ts) had already fixed "same place"; this fixes
// "same map".
//
// ── WHY MOUNT, NOT THE TOGGLE ────────────────────────────────────────────
//
// Each route records itself when it MOUNTS, rather than the crow switch
// recording on the way out. The toggle is not the only way to arrive: the
// admin blob inspector deep-links straight into `/offline?lng=…&lat=…`,
// share links land on either route, and a cold boot restores one of them.
// Recording at the destination catches every path with one line each;
// recording at the toggle would catch exactly one and silently miss the
// rest.
//
// ── WHY NOT A URL RENAME ─────────────────────────────────────────────────
//
// The obvious-looking fix is to nest the routes (`/map/offline`)
// or rename the online one (`/online`). Both are worse: the offline
// route shares NONE of `/map`'s 30 files of Mapbox machinery
// (fireLayer, PlotLayer, MapDrawControls), so nesting implies a parent-child
// relationship that does not exist, and renaming `/map` breaks every
// deep link, share URL and `seeOnMapRouter` target pointing at it. The URLs
// are fine. The tab bar hardcoding one of them was the bug.

/** The two map routes. Exported so callers compare against a constant rather
 *  than re-typing the path — a typo'd literal would silently never match. */
export const ONLINE_MAP_ROUTE = "/map";
export const OFFLINE_MAP_ROUTE = "/offline";

export type MapRoute = typeof ONLINE_MAP_ROUTE | typeof OFFLINE_MAP_ROUTE;

const KEY = "retreever-last-map-route";

/** TRUE when this page load is the SANDBOX world (?sandbox=1). Same rule and
 *  the same reason as mapViewport.ts's camera keys: localStorage is shared
 *  between the real app and the sandbox, so the practice world must not
 *  decide which map the real app's MAP tab opens. */
function sandboxPage(): boolean {
	if (typeof location === "undefined") return false;
	return new URLSearchParams(location.search).get("sandbox") === "1";
}

function storageKey(): string {
	return sandboxPage() ? `${KEY}-sandbox` : KEY;
}

/** Narrow an arbitrary string to a known map route. Anything else — a stale
 *  value from a renamed route, a corrupt write — is rejected rather than
 *  handed to `goto`, which would 404 the MAP tab. */
function isMapRoute(v: unknown): v is MapRoute {
	return v === ONLINE_MAP_ROUTE || v === OFFLINE_MAP_ROUTE;
}

/**
 * THE REACTIVE CELL — the source of truth the UI reads.
 *
 * ⚠️ localStorage IS NOT REACTIVE, and depending on it directly was the bug.
 * The tab bar had `$derived((page.url, loadLastMapRoute()))`, leaning on the
 * URL changing to re-trigger a re-read. It cannot work: the destination route
 * writes the new value in its `onMount`, which runs AFTER the derived has
 * already recomputed for that navigation. So the tab kept the value from
 * whichever map was visited FIRST and never updated again — MEASURED in the
 * browser: on `/map` with the preference correctly saved as
 * `/map`, the MAP tab's href was still the offline route's.
 *
 * A `$state` cell fixes it at the layer the problem actually lives at:
 * anything reading `lastMapRoute()` re-runs when the value CHANGES, whatever
 * caused the change and whenever it happens. No URL proxy, no ordering
 * assumption. localStorage stays, but only as PERSISTENCE behind this cell —
 * read once to seed it, written on every change.
 */
/**
 * ⚠️ SEEDED EAGERLY, NOT LAZILY ON FIRST READ. The obvious shape — seed inside
 * `loadLastMapRoute()` the first time it is called — CRASHES the app:
 * `state_unsafe_mutation`, "Updating state inside `$derived(...)` … is
 * forbidden". The tab bar calls this from a `$derived`, so the first read
 * happens mid-derivation and the lazy write is a mutation inside it.
 *
 * Reading storage at module scope is safe here because `readStored()` guards
 * `typeof localStorage === "undefined"`, so SSR/node simply gets the default.
 */
let current = $state<MapRoute>(readStored());
/** The storage key the cell currently holds a value FOR — not a boolean.
 *  The sandbox suffixes the key (`storageKey()`), so crossing that boundary
 *  must re-seed: a plain "have I seeded?" flag would let the practice world's
 *  choice serve the real app for the rest of the session, which is the exact
 *  leak the per-world key exists to prevent. */
let seededFor: string | null = storageKey();

/** Read the persisted value once per page load, to seed the cell. */
function readStored(): MapRoute {
	if (typeof localStorage === "undefined") return ONLINE_MAP_ROUTE;
	try {
		const raw = localStorage.getItem(storageKey());
		if (isMapRoute(raw)) return raw;
	} catch {
		// codestyle-allow-swallow: cosmetic tab-target preference; an unreadable
		// value just means the MAP tab opens the online map, which is the default
	}
	return ONLINE_MAP_ROUTE;
}

/**
 * The route the MAP tab should point at. Falls back to the ONLINE map when
 * nothing is stored (first run) or the stored value is unrecognised — the
 * online map is the safe default because it works without a downloaded pack.
 *
 * REACTIVE: call this inside a `$derived`/template and it re-runs whenever the
 * route changes. Seeds itself from localStorage on first call.
 */
export function loadLastMapRoute(): MapRoute {
	// PURE READ — never writes. This is called from inside a `$derived` (the MAP
	// tab's href), and Svelte 5 throws `state_unsafe_mutation` if a derivation
	// mutates state. The cell is seeded at module load; the only other writer is
	// `saveLastMapRoute`, called from route mounts (outside any derivation).
	//
	// The sandbox boundary is handled WITHOUT a write: if the current world's key
	// is not the one the cell holds, read straight through to storage rather than
	// re-seeding the cell here.
	if (seededFor !== storageKey()) return readStored();
	return current;
}

/**
 * Drop the in-memory cell so the next read re-seeds from storage.
 *
 * Needed because the cell is module-level and therefore outlives any single
 * page/sandbox context: switching into or out of the sandbox swaps the storage
 * KEY underneath it (`storageKey()`), so without this the practice world would
 * keep serving the real app's value for the rest of the session. Also what lets
 * a test start from a clean slate — the cell is deliberately NOT re-read on
 * every call, so clearing localStorage alone can no longer change the answer.
 */
export function resetLastMapRouteCache(): void {
	seededFor = null;
	current = ONLINE_MAP_ROUTE;
}

/**
 * Record the map route the user is on. Called from each map route's mount.
 * Ignores anything that is not one of the two known routes, so a future
 * third caller cannot poison the tab target.
 */
export function saveLastMapRoute(route: MapRoute): void {
	if (!isMapRoute(route)) return;
	// THE CELL FIRST, storage second. Updating the reactive value is what makes
	// the MAP tab repoint immediately; persisting is just so it survives a
	// reload. Order matters: a storage failure must not cost the live update,
	// which is the part the user sees.
	seededFor = storageKey();
	current = route;
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(storageKey(), route);
	} catch {
		// codestyle-allow-swallow: cosmetic tab-target preference; a failed write
		// just means the MAP tab keeps its previous target
	}
}

/**
 * Build a "See on map" URL pointing at the user's CURRENT map.
 *
 * Every "See on map" eye — inbox rows, the inbox detail sheet, the quality
 * history, quality704's plot jumps, the PDF-import hand-off — used to spell
 * `/map?...` as a literal. That is the same unowned-choice bug the MAP
 * tab had, just repeated seven times: tapping an eye on the offline map threw
 * you onto the ONLINE map, silently, mid-task.
 *
 * Callers pass only their params; this supplies the route. `params` may be a
 * `URLSearchParams` or anything its constructor accepts.
 *
 * NOTE the destination-side contract is unchanged: both map routes read
 * `?map=` / `?feature=` / `?plots=` through the same `applyMapRoute`
 * (seeOnMapRouter.ts), so switching which route receives them needs no change
 * there.
 */
export function seeOnMapUrl(
	params?: URLSearchParams | Record<string, string> | string,
): string {
	const route = loadLastMapRoute();
	if (!params) return route;
	const qs =
		params instanceof URLSearchParams
			? params.toString()
			: new URLSearchParams(params).toString();
	return qs ? `${route}?${qs}` : route;
}

/**
 * TRUE when `pathname` is either map route — what the bottom bar needs to
 * decide whether the MAP tab is lit.
 *
 * The tab bar's generic `startsWith(href)` test cannot answer this: the two
 * routes are SIBLINGS, so `/offline`.startsWith(`/map`) is
 * false and the tab would go dark on the offline map even though MAP is
 * exactly where the user is.
 */
export function isMapPath(pathname: string): boolean {
	return (
		pathname.startsWith(ONLINE_MAP_ROUTE) ||
		pathname.startsWith(OFFLINE_MAP_ROUTE)
	);
}
