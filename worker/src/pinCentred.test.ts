/**
 * THE ROADS ARE AN IMAGE, CENTRED ON THE PIN — like the satellite photo.
 *
 * ── THE DAY THIS ENDS ─────────────────────────────────────────────────────
 *
 * The roads were a VECTOR TILE. MapLibre draws a vector tile's contents across
 * the box it REQUESTED — a slippy tile on a world grid — and there is no
 * override (a source's `bounds` only filters which tiles are fetched). So a
 * vector blob CANNOT be centred on a GPS point: it is centred on its tile.
 *
 * MEASURED with two of the user's own pins, both landing in tile 8/41/88:
 *     -121.5722, 48.2164  →  tile centre 27 km from the pin
 *     -121.5246, 48.4817  →  tile centre  9 km from the pin
 * and the second overwrote the first, because they shared one address.
 *
 * Every attempt to fix it was an attempt to make a tile-shaped thing behave
 * like a point-shaped thing — cells, promotion to shallower tiles, per-cell
 * frames, neighbour sets. Each failed differently. The user: "GPS is
 * meaningless to you... it has to be wrong."
 *
 * ⛔ THE COUNTER-EXAMPLE WAS ALREADY ON SCREEN: the satellite photo is centred
 * on the pin every time, because it is an IMAGE placed by explicit GPS bounds.
 * The roads now use that identical mechanism.
 */
import { describe, expect, it } from "vitest";
import { GRID_RADIUS_KM, radiusBox } from "./grid";

/** Km between two lng/lat points. */
function km(lng1: number, lat1: number, lng2: number, lat2: number): number {
	const dLat = (lat2 - lat1) * 110.574;
	const dLng =
		(lng2 - lng1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
	return Math.hypot(dLat, dLng);
}

/** The user's own pins, including the two that collided in one tile. */
const PINS: Array<[number, number]> = [
	[-121.5722, 48.2164],
	[-121.5246, 48.4817],
	[-2.92565, 16.7277],
	[-115.4419, 41.905],
	[0.001, 0.001],
];

describe("the roads picture is pin-centred", () => {
	it("⛔ THE BOX IS CENTRED ON THE PIN — every pin, exactly", () => {
		// The property a vector tile could never have.
		for (const [lng, lat] of PINS) {
			const b = radiusBox(lng, lat);
			const cx = (b.w + b.e) / 2;
			const cy = (b.s + b.n) / 2;
			expect(km(lng, lat, cx, cy), `pin ${lng},${lat}`).toBeLessThan(0.01);
		}
	});

	it("⛔ TWO NEARBY PINS GET DIFFERENT BOXES — no shared address", () => {
		// These two shared tile 8/41/88 and overwrote each other. As images with
		// their own GPS bounds they cannot collide: each is placed where it is.
		const a = radiusBox(-121.5722, 48.2164);
		const b = radiusBox(-121.5246, 48.4817);
		expect(a.w).not.toBe(b.w);
		expect(a.s).not.toBe(b.s);
	});

	it("the box really is the promised radius each way", () => {
		for (const [lng, lat] of PINS) {
			const b = radiusBox(lng, lat);
			expect(km(lng, lat, b.w, lat)).toBeGreaterThanOrEqual(GRID_RADIUS_KM - 0.5);
			expect(km(lng, lat, b.e, lat)).toBeGreaterThanOrEqual(GRID_RADIUS_KM - 0.5);
			expect(km(lng, lat, lng, b.s)).toBeGreaterThanOrEqual(GRID_RADIUS_KM - 0.5);
			expect(km(lng, lat, lng, b.n)).toBeGreaterThanOrEqual(GRID_RADIUS_KM - 0.5);
		}
	});

	it("⛔ packBuilder builds VECTOR tiles around the PIN'S OWN point", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			fileURLToPath(new URL("./packBuilder.ts", import.meta.url)),
			"utf8",
		);
		// VECTORS, not a raster. The PNG transport was reverted 2026-08-20 — it
		// centred correctly and was still unusable (no restyling, blurs on zoom).
		expect(src).toContain("buildBlobTile(");
		expect(src).not.toContain("renderRoadPng(");

		// THE PIN'S REAL GPS POINT drives BOTH what is read and which cells are
		// built. If either reverts to a snapped/derived point, roads land far
		// from the pin — that is the 45 km bug, and it is what this pins down.
		expect(src).toContain("radiusBox(lng, lat)");
		expect(src).toContain("cellsFor(lng, lat)");

		// ⚠️ EACH CELL FRAMED TO ITS OWN BOX. A vector tile's geometry spans the
		// box it was requested at, so framing a cell to the PIN's box re-anchors
		// it and draws it in the wrong place. That shipped twice.
		expect(src).toContain("boxFrame(cellBox(c))");
	});
});
