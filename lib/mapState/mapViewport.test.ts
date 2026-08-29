// regression guard: a saved camera at null island (0,0) must never be resumed or persisted — isNullIsland is the shared sentinel used by the camera, auto-frame bounds, and the offline flyToUrlTarget guard.
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

// regression: a persisted bearing rotated the map permanently (“north facing west”) — heal must happen on READ as well as write, since reinstalling doesn’t clear localStorage.
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
