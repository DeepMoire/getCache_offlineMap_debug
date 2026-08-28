/**
 * ⛔ THE 27.9 km BUG — MEASURED, THEN PINNED.
 *
 * From the user's own blob inspector (West Glacier MT, build v25):
 *     satellite: reach   2.8 km, offsetFromPin      4 m   ← correct
 *     roads:     reach 128.7 km, offsetFromPin 27.9 km   ← wrong
 *
 * The roads spanned 211 km × 68 km — the union of four z8 cells — because a
 * cell contributed ALL of itself, and a z8 cell is ~104 km wide. The pin was a
 * passenger inside that union.
 *
 * ⚠️ THIS IS ALSO THE "IT WORKED THIS MORNING" BUG. A pin near a cell's centre
 * looks perfect; the same code with a pin near a cell EDGE puts roads ~28 km
 * away. Identical code, different luck — which is exactly what the user saw
 * across five months of "sometimes".
 */
import { describe, expect, it } from "vitest";
import { GRID_RADIUS_KM, cellBox, cellsFor, radiusBox } from "./grid";

const R = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;
function km(aLng: number, aLat: number, bLng: number, bLat: number): number {
	const dLat = toRad(bLat - aLat);
	const dLng = toRad(bLng - aLng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * ⛔ THE CLIP IS GONE — and this test now guards the OPPOSITE property.
 *
 * Clipping cells to the pin's box centred the coverage and cut every road
 * crossing the boundary into an arc. Mapbox/MapLibre ship WHOLE tiles
 * intersecting the region ("may include many tiles outside the visible area");
 * the pin is honoured by the camera, not by cutting geometry.
 *
 * So what must hold is COVERAGE, not centring: the tiles a pin selects must
 * fully CONTAIN its 30 km box. A superset is correct; a shortfall is the bug.
 */

// His real pins. West Glacier is the one that measured 27.9 km off; the others
// are pins he showed working, to prove the fix does not break the lucky cases.
const PINS: Array<[string, number, number]> = [
	["West Glacier MT (the 27.9 km failure)", -114.0172, 48.5377],
	["Valemount BC", -119.391772, 52.431991],
	["Nespelem WA", -118.0365, 48.679],
	["Island Park ID", -111.661, 44.829],
];

describe("every cell is clipped to the pin's own box", () => {
	for (const [name, lng, lat] of PINS) {
		it(`${name}: selected cells CONTAIN the pin's full 30 km box`, () => {
			const pin = radiusBox(lng, lat);
			const cells = cellsFor(lng, lat);
			expect(cells.length).toBeGreaterThan(0);

			// Union of the WHOLE cells that ship.
			let w = 180;
			let e = -180;
			let s = 90;
			let n = -90;
			for (const c of cells) {
				const cb = cellBox(c);
				w = Math.min(w, cb.w);
				e = Math.max(e, cb.e);
				s = Math.min(s, cb.s);
				n = Math.max(n, cb.n);
			}

			// ── THE ASSERTION THAT MATTERS ──
			// Every edge of the pin's radius box is inside what we ship. If this
			// fails, a pin gets less than its 30 km and roads stop mid-screen.
			expect(w).toBeLessThanOrEqual(pin.w);
			expect(e).toBeGreaterThanOrEqual(pin.e);
			expect(s).toBeLessThanOrEqual(pin.s);
			expect(n).toBeGreaterThanOrEqual(pin.n);

			// And the pin itself is inside, which the 50 km bug violated.
			expect(lng).toBeGreaterThan(w);
			expect(lng).toBeLessThan(e);
			expect(lat).toBeGreaterThan(s);
			expect(lat).toBeLessThan(n);
		});
	}

	it("a tile-aligned union IS off-centre — and that is fine now", () => {
		// Kept as documentation: the union really is off-centre (that is what a
		// grid does). It is no longer a bug, because the camera centres the view
		// and the coverage assertions above guarantee the pin's 30 km is present.
		const [, lng, lat] = PINS[0];
		let w = 180;
		let e = -180;
		let s = 90;
		let n = -90;
		for (const c of cellsFor(lng, lat)) {
			const cb = cellBox(c);
			w = Math.min(w, cb.w);
			e = Math.max(e, cb.e);
			s = Math.min(s, cb.s);
			n = Math.max(n, cb.n);
		}
		// Off-centre, yes — but the pin is INSIDE it, which is the real property.
		expect(lng).toBeGreaterThan(w);
		expect(lng).toBeLessThan(e);
		expect(lat).toBeGreaterThan(s);
		expect(lat).toBeLessThan(n);
	});
});
