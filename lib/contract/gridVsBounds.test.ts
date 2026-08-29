/** ⛔ THIS ALSO ANSWERS "SHOULD WE USE PLUS CODES?" — NO: a grid address (a box someone else already drew) can never centre on the pin the way a bounds pair (corners you choose) can; a finer grid only shrinks the error, never removes it. */
import { describe, expect, it } from "vitest";
import { boxAround, centreOf, offsetFromPinKm, sizeKm } from "../onPhone/roads/pinBox";
import { tileToLat, tileToLng, lngToTileX, latToTileY, km } from "./geo";

/** The user's Chelan pin — the one that measured 45.2 km off. */
const PIN = { lng: -120.0148, lat: 47.9015 };

/** The box a slippy tile ADDRESSES, from its z/x/y — the grid's own edges. */
function boxOfTile(z: number, x: number, y: number) {
	return {
		w: tileToLng(x, z),
		e: tileToLng(x + 1, z),
		n: tileToLat(y, z),
		s: tileToLat(y + 1, z),
	};
}

/** A Plus Code is a fixed lat/lng grid (20 degrees, then /20 per pair); this returns the CELL BOX for a given resolution — enough to prove the shape of the idea without the full alphabet encoder. */
function plusCodeCellBox(lng: number, lat: number, degrees: number) {
	const w = Math.floor((lng + 180) / degrees) * degrees - 180;
	const s = Math.floor((lat + 90) / degrees) * degrees - 90;
	return { w, e: w + degrees, s, n: s + degrees };
}

describe("a grid address can never centre on the pin", () => {
	it("⛔ THE MEASURED BUG: a z8 tile puts the pin 45 km off centre", () => {
		const z = 8;
		const x = lngToTileX(PIN.lng, z);
		const y = latToTileY(PIN.lat, z);
		const box = boxOfTile(z, x, y);

		expect(PIN.lng).toBeGreaterThanOrEqual(box.w);
		expect(PIN.lng).toBeLessThanOrEqual(box.e);

		const off = offsetFromPinKm(box, PIN.lng, PIN.lat);
		expect(off).toBeGreaterThan(20);

		const { widthKm } = sizeKm(box);
		expect(widthKm).toBeGreaterThan(100);
	});

	it("⛔ PLUS CODES DO NOT FIX IT — a finer grid is still a grid", () => {
		const resolutions = [20, 1, 0.05, 0.0025]; // code lengths 2,4,6,8
		let previousOffset = Infinity;
		for (const deg of resolutions) {
			const cell = plusCodeCellBox(PIN.lng, PIN.lat, deg);
			const off = offsetFromPinKm(cell, PIN.lng, PIN.lat);

			expect(off).toBeGreaterThan(0);
			expect(off).toBeLessThan(previousOffset);
			previousOffset = off;
		}
		expect(previousOffset).toBeGreaterThan(0);
	});

	it("⛔ BOUNDS DO fix it — the pin is the centre, exactly, at any radius", () => {
		for (const radiusKm of [5, 20, 30, 50]) {
			const box = boxAround(PIN.lng, PIN.lat, radiusKm);
			const c = centreOf(box);
			expect(c.lng).toBeCloseTo(PIN.lng, 10);
			expect(c.lat).toBeCloseTo(PIN.lat, 10);
			expect(offsetFromPinKm(box, PIN.lng, PIN.lat)).toBeLessThan(0.000001);
		}
	});

	it("⛔ THE HEADLINE COMPARISON: grid 45 km off, bounds 0 m off", () => {
		const z = 8;
		const tile = boxOfTile(z, lngToTileX(PIN.lng, z), latToTileY(PIN.lat, z));
		const bounds = boxAround(PIN.lng, PIN.lat, 30);

		const gridOff = offsetFromPinKm(tile, PIN.lng, PIN.lat);
		const boundsOff = offsetFromPinKm(bounds, PIN.lng, PIN.lat);

		expect(gridOff).toBeGreaterThan(20);
		expect(boundsOff).toBeLessThan(0.000001);
		expect(boundsOff * 1000).toBeLessThan(3);
	});

	it("a pin at a grid cell's exact centre is the ONLY case a grid gets right", () => {
		const z = 8;
		const x = lngToTileX(PIN.lng, z);
		const y = latToTileY(PIN.lat, z);
		const box = boxOfTile(z, x, y);
		const c = centreOf(box);

		expect(offsetFromPinKm(box, c.lng, c.lat)).toBeLessThan(0.000001);
		expect(offsetFromPinKm(box, PIN.lng, PIN.lat)).toBeGreaterThan(20);
		expect(km(PIN.lng, PIN.lat, c.lng, c.lat)).toBeGreaterThan(20);
	});
});

/** ⛔ THE TWO HALVES MUST AGREE ON THE BOX. The phone (pinBox.boxAround) and the Worker (grid.radiusBox) must compute the SAME box — disagreement is the class of bug that produced a 1.86x stretch anchored top-left, and then a 45 km offset. */
describe("phone and worker agree on the pin's box", () => {
	const RADIUS_KM = 30;

	/** Worker's formula, copied verbatim from workers/offline-tiles/src/grid.ts radiusBox. If it changes, this test must go red — don't "fix" it by editing this copy; reconcile the two implementations instead. */
	function workerRadiusBox(lng: number, lat: number) {
		const dLat = RADIUS_KM / 110.574;
		const dLng =
			RADIUS_KM / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
		return { w: lng - dLng, e: lng + dLng, s: lat - dLat, n: lat + dLat };
	}

	it("⛔ same pin, same radius → same box (within 10 m)", () => {
		for (const p of [
			PIN,
			{ lng: -121.5722, lat: 48.2164 }, // Darrington
			{ lng: -76.32622, lat: 45.25341 }, // the sandbox home pin
			{ lng: 0, lat: 0 },
		]) {
			const mine = boxAround(p.lng, p.lat, RADIUS_KM);
			const theirs = workerRadiusBox(p.lng, p.lat);
			expect(km(mine.w, p.lat, theirs.w, p.lat) * 1000).toBeLessThan(10);
			expect(km(mine.e, p.lat, theirs.e, p.lat) * 1000).toBeLessThan(10);
			expect(km(p.lng, mine.n, p.lng, theirs.n) * 1000).toBeLessThan(10);
			expect(km(p.lng, mine.s, p.lng, theirs.s) * 1000).toBeLessThan(10);
		}
	});

	it("both are centred on the pin — neither drifts", () => {
		const mine = boxAround(PIN.lng, PIN.lat, RADIUS_KM);
		const theirs = workerRadiusBox(PIN.lng, PIN.lat);
		expect(offsetFromPinKm(mine, PIN.lng, PIN.lat)).toBeLessThan(0.000001);
		expect(offsetFromPinKm(theirs, PIN.lng, PIN.lat)).toBeLessThan(0.000001);
	});
});
