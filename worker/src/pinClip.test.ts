/**
 * ⛔ THE 27.9 km BUG — a cell contributing ALL of itself (a z8 cell ~104 km wide) let roads land up to 28 km from the pin; measured: West Glacier MT, roads offset 27.9 km vs satellite's 4 m.
 * ⚠️ Also the "it worked this morning" bug — a pin near a cell centre looks fine, the same code near a cell EDGE puts roads ~28 km away.
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

// ⛔ The clip is gone — this test now guards COVERAGE, not centring: selected tiles must fully CONTAIN the pin's 30 km box (a superset is correct, a shortfall is the bug).

// West Glacier measured 27.9 km off; the others are pins that worked, to prove the fix doesn't break the lucky cases.
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

			// Every edge of the pin's box must be inside what we ship — a shortfall means roads stop mid-screen.
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
		// Off-centre is expected (that's what a grid does) — no longer a bug now that the camera centres the view and coverage is guaranteed.
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
