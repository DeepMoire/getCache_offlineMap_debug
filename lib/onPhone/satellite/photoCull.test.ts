/**
 * photoCullPlan — the direction2.6 viewport cull, locked by numbers.
 *
 * Before the cull, the page mounted every baked photo on disk and never
 * unmounted: RAM grew with the PIN COUNT, not the screen (Law 5). These tests
 * pin the two-ring geometry that replaced it — mount one viewport out, unmount
 * two out (hysteresis) — and the two laws the cull must NOT break: Law 1 (a
 * photo on screen is mounted at EVERY zoom — the plan sees geometry, never a
 * zoom level) and Law 3 (the pre-mount ring means a panning user never sees a
 * photo pop in; the hysteresis band means one never flaps on the edge).
 */
import { describe, expect, it, vi } from "vitest";

// Faithful to the real exports the cull reads — same 4-decimal key, same 2 km
// disc. NOT the real module: importing it drags the IndexedDB store chain into
// a bare clone for nothing; photoCullPlan is pure geometry and must stay that
// way (Law 7).
vi.mock("./satelliteImage", () => ({
	BAKE_RADIUS_KM: 2,
	getSatImageByKey: vi.fn(),
	satImageKey: (c: [number, number]) => `${c[0].toFixed(4)},${c[1].toFixed(4)}`,
}));

import {
	photoCullPlan,
	SAT_MOUNT_VIEWPORTS,
	SAT_UNMOUNT_VIEWPORTS,
} from "./mountSatellite";

describe("photoCullPlan (the direction2.6 viewport cull)", () => {
	// 2° square camera at the equator: mount ring = [-3,-3,3,3] (one viewport
	// per side), keep ring = [-5,-5,5,5] (two). The hysteresis band — mounted
	// but not re-mountable — is everything between 3° and 5° out.
	const camera: [number, number, number, number] = [-1, -1, 1, 1];

	it("keeps the ring constants ordered — unmount wider than mount, or photos flap on the edge", () => {
		expect(SAT_UNMOUNT_VIEWPORTS).toBeGreaterThan(SAT_MOUNT_VIEWPORTS);
	});

	it("mounts the photo the camera is sitting on (Law 1 — every zoom)", () => {
		const p = photoCullPlan(camera, [[0, 0]]);
		expect(p.mount).toEqual([[0, 0]]);
		expect(p.keep.has("0.0000,0.0000")).toBe(true);
	});

	it("pre-mounts one viewport out — a panning user must never watch a photo pop in (Law 3)", () => {
		const p = photoCullPlan(camera, [[2.5, 0]]);
		expect(p.mount).toEqual([[2.5, 0]]);
		expect(p.keep.has("2.5000,0.0000")).toBe(true);
	});

	it("counts the 2 km disc's EDGE, not the pin — a photo whose rim overlaps the mount ring mounts", () => {
		// 3.01° east: the pin is past the mount ring's 3° edge, but the disc
		// (±0.0180° at the equator) reaches back to 2.992° — inside.
		const p = photoCullPlan(camera, [[3.01, 0]]);
		expect(p.mount).toEqual([[3.01, 0]]);
	});

	it("holds a mounted photo in the hysteresis band — kept but not (re)mounted between the rings", () => {
		// 4° east: outside the mount ring (3°), inside the keep ring (5°).
		// A photo mounted earlier survives here; a fresh pass will not add one.
		const p = photoCullPlan(camera, [[4, 0]]);
		expect(p.mount).toEqual([]);
		expect(p.keep.has("4.0000,0.0000")).toBe(true);
	});

	it("drops a photo beyond the keep ring — the sweep unmounts it and revokes the URL", () => {
		// 6° east: past the 5° keep ring even after the disc's 0.018° reach.
		const p = photoCullPlan(camera, [[6, 0]]);
		expect(p.mount).toEqual([]);
		expect(p.keep.size).toBe(0);
	});

	it("stretches the lng span with latitude — the same disc is wider at 60°N", () => {
		// Same shot shape, same 3.02° east offset: at the equator the disc
		// (±0.0180° lng) only reaches 3.002° — past the 3° mount ring, no
		// mount; at 60°N (±0.0360° lng) it reaches 2.984° — inside, mount.
		// Flat-earth lng would pass both or fail both.
		const equator = photoCullPlan([-1, -1, 1, 1], [[3.02, 0]]);
		const north = photoCullPlan([-1, 59, 1, 61], [[3.02, 60]]);
		expect(equator.mount).toEqual([]);
		expect(north.mount).toEqual([[3.02, 60]]);
	});

	it("a world-spanning camera mounts EVERYTHING — presence survives zoom-out (Law 1)", () => {
		const world: [number, number, number, number] = [-170, -80, 170, 80];
		const anchors: [number, number][] = [
			[0, 0],
			[100, 50],
			[-150, -70],
			[179.9, 0],
		];
		const p = photoCullPlan(world, anchors);
		expect(p.mount).toHaveLength(4);
		expect(p.keep.size).toBe(4);
	});

	it("no anchors, no plan — and no crash", () => {
		const p = photoCullPlan(camera, []);
		expect(p.mount).toEqual([]);
		expect(p.keep.size).toBe(0);
	});
});
