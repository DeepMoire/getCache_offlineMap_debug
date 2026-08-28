/**
 * Regression: the offline map jumped to "null island" (0,0 — the Gulf of Guinea,
 * off West Africa) instead of resuming the viewport on the online↔offline crow
 * toggle. Two causes are guarded here:
 *   • a saved camera at (0,0) must NOT be resumed (loadCamera) or persisted (saveCamera);
 *   • isNullIsland is the shared sentinel test used by the camera + the auto-frame
 *     bounds + the offline flyToUrlTarget guard.
 * (The third cause — Number(null) === 0 making a param-less /offlinev4 open "fly to"
 * (0,0) — lives in the route component and is covered by isNullIsland + that guard.)
 */
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});

import { attachCameraPersistence, isNullIsland, loadCamera } from "./mapViewport";

const CAMERA_KEY = "retreever-map-camera";
const real = { center: [-76.168, 45.061], zoom: 12, bearing: 0, pitch: 0 };
const nullIsland = { center: [0, 0], zoom: 12, bearing: 0, pitch: 0 };

describe("isNullIsland", () => {
	it("flags (0,0) and its immediate surroundings", () => {
		expect(isNullIsland(0, 0)).toBe(true);
		expect(isNullIsland(0.2, -0.3)).toBe(true);
		expect(isNullIsland(-0.01469, 0.00791)).toBe(true); // a real reported jump
	});
	it("does NOT flag a genuine location", () => {
		expect(isNullIsland(-76.168, 45.061)).toBe(false); // home
		expect(isNullIsland(-1.52725, 8.68004)).toBe(false); // inland Ghana, a real place
	});
});

describe("loadCamera rejects null island", () => {
	it("resumes a real saved camera", () => {
		store.clear();
		store.set(CAMERA_KEY, JSON.stringify(real));
		expect(loadCamera()?.center).toEqual([-76.168, 45.061]);
	});
	it("returns null for a (0,0) saved camera — so the home fallback wins, not Africa", () => {
		store.clear();
		store.set(CAMERA_KEY, JSON.stringify(nullIsland));
		expect(loadCamera()).toBeNull();
	});
});

/**
 * NORTH IS UP.
 *
 * THE BUG: a saved camera carried a `bearing`, and it was restored on every
 * mount. One accidental two-finger twist therefore rotated the map PERMANENTLY
 * — reported in the field as "north is facing west". It was invisible to every
 * camera probe, because `offlineMapInit` really did construct with `bearing: 0`
 * and `applyCameraOrientation` overwrote it a moment later from localStorage.
 *
 * Reinstalling did not clear it (localStorage survives), so the heal has to
 * happen on READ as well as on write.
 */
describe("north is up — bearing is never persisted or restored", () => {
	it("reads back a stored rotation as 0 — heals devices already rotated", () => {
		store.clear();
		store.set(
			CAMERA_KEY,
			JSON.stringify({ center: [-76.168, 45.061], zoom: 12, bearing: 90, pitch: 45 }),
		);
		const cam = loadCamera();
		expect(cam?.bearing).toBe(0);
		expect(cam?.pitch).toBe(0);
		// ...while still resuming the real location.
		expect(cam?.center).toEqual([-76.168, 45.061]);
	});

	it("never writes a rotation, even from a rotated live map", () => {
		store.clear();
		attachCameraPersistence({
			getCenter: () => ({ lng: -76.168, lat: 45.061 }),
			getZoom: () => 12,
			getBearing: () => 137,
			getPitch: () => 60,
			on: (_e: string, fn: () => void) => fn(), // fire moveend immediately
			off: () => {},
		} as never);
		const saved = JSON.parse(store.get(CAMERA_KEY) as string);
		expect(saved.bearing).toBe(0);
		expect(saved.pitch).toBe(0);
	});
});
