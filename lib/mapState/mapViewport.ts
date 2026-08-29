// persists the last map camera (center/zoom/bearing/pitch) and the last auto-framed map key across online/offline mounts, so a route remount resumes the exact viewport instead of snapping back to the default center.

// ⚠️ structural type, not mapboxgl.Map/MaplibreMap — MapLibre’s default maxPitch is 60 vs Mapbox 3.x’s 85, so a pitch persisted from the online map above 60 is CLAMPED (not thrown) when replayed offline.
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

/** TRUE when this load is the sandbox world (?sandbox=1) — localStorage is shared with the real app, so camera keys are suffixed per world; roaming the practice map must never move the real app’s camera, and vice versa. */
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

/** THE map home — shared by the online cold-open fallback and the offline demo blob; the two MUST stay the same spot so the crow toggle lands in the same place. */
export { MAP_HOME_CENTER } from "../shared/homeCentre";

/** THE sandbox home — every sandbox opens here by default (seeded practice map); a fresh sandbox resumes here instead of MAP_HOME_CENTER, then roaming persists per-sandbox. */
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

/** Null island (0,0, Gulf of Guinea) is where a feature with no known location lands — never resume a camera there, never persist one, never let it drag the auto-frame (~0.5° ≈ 55 km box). */
export function isNullIsland(lng: number, lat: number): boolean {
	return Math.abs(lng) < 0.5 && Math.abs(lat) < 0.5;
}

/** Reads the persisted camera, or null if none/corrupt/non-finite — in the sandbox world it falls back to the sandbox home instead of null. */
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
				// NORTH IS UP — see saveCamera; heals cameras persisted before writes were walled off (no cache-clear or reinstall needed).
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
			// NORTH IS UP — never persist bearing/pitch; an accidental twist gesture would otherwise rotate the map FOREVER on every remount (symptom: "north facing west", invisible in localStorage, survives reinstall).
			bearing: 0,
			pitch: 0,
		};
		if (!finite(cam.center[0]) || !finite(cam.center[1]) || !finite(cam.zoom)) {
			return;
		}
		// never persist null island — a stray pan/jump to (0,0) must not become the camera resumed on the next mount.
		if (isNullIsland(cam.center[0], cam.center[1])) return;
		localStorage.setItem(cameraKey(), JSON.stringify(cam));
	} catch {
	}
}

/** Wires moveend → persist. Returns a detach fn for the caller’s onMount cleanup so the listener never leaks across remounts. */
export function attachCameraPersistence(map: CameraMap): () => void {
	const onMoveEnd = (): void => saveCamera(map);
	map.on("moveend", onMoveEnd);
	return () => {
		map.off("moveend", onMoveEnd);
	};
}

/** ⚠️ Forces the map upright on every mount. This used to RESTORE a saved bearing/pitch, which is exactly how the map came back rotated — keep this a one-way assertion, never a restore. */
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
	}
}
