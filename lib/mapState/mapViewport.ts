// Persists the last map camera (center / zoom / bearing / pitch) and the
// last auto-framed map key across mounts. Both matter because the
// online (/mobile/map) and offline (/mobile/offlinev4) routes each
// mount a FRESH Mapbox instance at a hardcoded Ontario default center,
// then auto-frame the active map's features.
//
// The online↔offline "crow" toggle is a full route navigation (goto), not
// an in-place style swap — so a toggle, a leave-and-return, a hot reload,
// and a cold boot all remount the map from scratch. With nothing
// persisted, every remount snapped to the default center and then flew to
// the site. Persisting the camera lets each mount RESUME the exact
// viewport the user was looking at (toggle = same place, different
// baselayer); persisting the framed-map key lets the auto-frame fire ONLY
// when a genuinely different map becomes active — never on a remount of
// the same one. The single shared localStorage key means online + offline
// read/write the same camera, so the toggle is seamless.

/**
 * The slice of a map the camera helpers need — structural, not `mapboxgl.Map`.
 *
 * BOTH renderers are live: the online map is Mapbox, the offline map
 * (/mobile/offlinev4) is MapLibre. Every method below exists in both with an
 * identical signature (verified against both `.d.ts` files), but the two `Map`
 * classes are nominally distinct, so a Mapbox-typed parameter rejects a MapLibre
 * map for reasons that are purely about declaration identity.
 *
 * Deliberately structural rather than a `MapboxMap | MaplibreMap` union: a call
 * against a union needs one signature valid for every member, and `on`/`off` are
 * overloaded differently in each, which makes the union unusable at the call site.
 *
 * ⚠️ One real behavioural difference, not a typing one: MapLibre's default
 * maxPitch is 60 where Mapbox 3.x allows 85. A pitch persisted from the online
 * map above 60 is CLAMPED (not thrown) when replayed on the offline map.
 */
type CameraMap = {
	getCenter(): { lng: number; lat: number };
	getZoom(): number;
	getBearing(): number;
	getPitch(): number;
	setBearing(bearing: number): unknown;
	setPitch(pitch: number): unknown;
	on(type: "moveend", listener: () => void): unknown;
	off(type: "moveend", listener: () => void): unknown;
};

const CAMERA_KEY = "retreever-map-camera";
const FRAMED_KEY = "retreever-map-framed-key";

/** TRUE when this page load is the SANDBOX world (?sandbox=1 — the flag is
 *  fixed per page life; the layout's beforeNavigate guard re-appends it on
 *  every soft nav). localStorage is otherwise SHARED between the real app and
 *  sandbox, so the camera keys are suffixed per world — roaming the practice
 *  map must never move the real app's camera, and vice versa. */
function sandboxPage(): boolean {
	if (typeof location === "undefined") return false;
	return new URLSearchParams(location.search).get("sandbox") === "1";
}
function cameraKey(): string {
	return sandboxPage() ? `${CAMERA_KEY}-sandbox` : CAMERA_KEY;
}
function framedKey(): string {
	return sandboxPage() ? `${FRAMED_KEY}-sandbox` : FRAMED_KEY;
}

/** THE map home (45.06°, -76.17°) — where a fresh mount lands when there's
 *  nowhere else to go: no resumable camera AND no map to frame. ONE constant
 *  shared by the online map's cold-open fallback AND the offline route's
 *  permanent demo blob (which is baked here so a first-time offline user
 *  always lands on a live demo). The two MUST be the same spot so the
 *  online↔offline crow toggle lands in the same place — they were once two
 *  independent literals whose comments begged them to match. */
export { MAP_HOME_CENTER } from "../shared/homeCentre"; // 28 Aug 2026: relative — same child

/** THE sandbox home — every sandbox opens here by default: centred on the
 *  seeded practice map (the GTUser block), user-picked coordinate + zoom.
 *  A fresh sandbox (nothing saved under the sandbox camera key) resumes to
 *  this instead of MAP_HOME_CENTER; roaming persists per-sandbox after that. */
export const SANDBOX_HOME_CENTER: [number, number] = [-76.32622, 45.25341];
export const SANDBOX_HOME_ZOOM = 12.8;

export interface SavedCamera {
	center: [number, number];
	zoom: number;
	bearing: number;
	pitch: number;
}

function finite(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n);
}

/** "Null island" (0,0) in the Gulf of Guinea is where a feature with NO known
 *  location lands — a real Get Cache user is never there. We never resume a camera
 *  there, never persist one there, and never let such a pin drag the auto-frame
 *  (geometryBounds in MapDrawControls uses this too). ~0.5° ≈ a 55 km box. */
export function isNullIsland(lng: number, lat: number): boolean {
	return Math.abs(lng) < 0.5 && Math.abs(lat) < 0.5;
}

/** Read the persisted camera, or null if none / corrupt / non-finite. In the
 *  SANDBOX world a missing/corrupt camera falls back to the sandbox home
 *  (SANDBOX_HOME_CENTER @ SANDBOX_HOME_ZOOM) instead of null, so every fresh
 *  sandbox — online or offline route — opens on the practice block. */
export function loadCamera(): SavedCamera | null {
	const fallback: SavedCamera | null = sandboxPage()
		? {
				center: SANDBOX_HOME_CENTER,
				zoom: SANDBOX_HOME_ZOOM,
				bearing: 0,
				pitch: 0,
			}
		: null;
	if (typeof localStorage === "undefined") return fallback;
	try {
		const raw = localStorage.getItem(cameraKey());
		if (!raw) return fallback;
		const v = JSON.parse(raw);
		if (
			Array.isArray(v?.center) &&
			finite(v.center[0]) &&
			finite(v.center[1]) &&
			!isNullIsland(v.center[0], v.center[1]) &&
			finite(v.zoom) &&
			finite(v.bearing) &&
			finite(v.pitch)
		) {
			return {
				center: [v.center[0], v.center[1]],
				zoom: v.zoom,
				// NORTH IS UP — see saveCamera. Writes are walled off now, but
				// cameras persisted BEFORE that wall existed are still on disk in
				// every browser and app install that ever rotated the map. Reading
				// them back as 0 heals those devices on their next load, with no
				// cache-clear and no reinstall asked of the user.
				bearing: 0,
				pitch: 0,
			};
		}
	} catch {
		/* corrupt value — fall through to default */
	}
	return null;
}

/** Snapshot the live camera into localStorage (no-op on non-finite state). */
function saveCamera(map: CameraMap): void {
	if (typeof localStorage === "undefined") return;
	try {
		const c = map.getCenter();
		const cam: SavedCamera = {
			center: [c.lng, c.lat],
			zoom: map.getZoom(),
			// NORTH IS UP. Never persist a bearing.
			//
			// A saved bearing is the one piece of camera state a user can set by
			// ACCIDENT and never discover: a two-finger twist on a trackpad, or a
			// stray rotate gesture, writes a rotation here — and because the camera
			// is restored on every mount, the map then opens rotated FOREVER. The
			// symptom is "north is facing west", the cause is invisible (localStorage),
			// and reinstalling the app does not clear it.
			//
			// The map itself was never wrong: offlineMapInit.ts constructs with
			// `bearing: 0`, and applyCameraOrientation immediately overwrote it with
			// this stored value. So the wall goes at the WRITE boundary — a rotation
			// that is never stored can never be restored.
			//
			// Pitch gets the same treatment for the same reason: a tilted offline map
			// is never intentional, and the route builds with `pitch: 0`.
			bearing: 0,
			pitch: 0,
		};
		if (!finite(cam.center[0]) || !finite(cam.center[1]) || !finite(cam.zoom)) {
			return;
		}
		// Never persist null island — a stray pan/jump to (0,0) must not become the
		// camera we resume into on the next mount.
		if (isNullIsland(cam.center[0], cam.center[1])) return;
		localStorage.setItem(cameraKey(), JSON.stringify(cam));
	} catch {
		// codestyle-allow-swallow: cosmetic camera-resume cache; localStorage full/unavailable just means the next mount uses the default center
	}
}

/**
 * Wire `moveend` → persist. Returns a detach fn for the caller's onMount
 * cleanup so the listener never leaks across remounts.
 */
export function attachCameraPersistence(map: CameraMap): () => void {
	const onMoveEnd = (): void => saveCamera(map);
	map.on("moveend", onMoveEnd);
	return () => {
		map.off("moveend", onMoveEnd);
	};
}

/**
 * Force the map upright. NORTH IS UP — always, on every mount.
 *
 * ⚠️ This used to RESTORE a saved bearing/pitch, and that is precisely how the
 * map came back rotated: an accidental two-finger twist was persisted by
 * saveCamera, and this function faithfully re-applied it on every single load.
 * `bearing: 0` in offlineMapInit.ts was correct and was then immediately
 * overwritten here, which is why every camera reading said 0 while the screen
 * showed a rotated map.
 *
 * It is now a one-way assertion rather than a restore. Kept (not deleted) as
 * the single place that guarantees orientation, so a future caller cannot
 * reintroduce a rotation by wiring setBearing back in somewhere else.
 */
export function applyCameraOrientation(map: CameraMap, _cam: SavedCamera): void {
	map.setBearing(0);
	map.setPitch(0);
}

/** The map key the camera was last auto-framed to (survives remounts). */
export function loadFramedMapKey(): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return localStorage.getItem(framedKey());
	} catch {
		return null;
	}
}

export function saveFramedMapKey(key: string | null): void {
	if (typeof localStorage === "undefined" || !key) return;
	try {
		localStorage.setItem(framedKey(), key);
	} catch {
		// codestyle-allow-swallow: cosmetic framed-map-key cache; a failed write just re-fires the auto-frame on next mount
	}
}
