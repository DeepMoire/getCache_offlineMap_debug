/**
 * ⛔ THE FIX IS A CROP, NOT A BOUNDS EDIT — shrinking only `bounds` squashes the image; canvas extent and stored bounds must both derive from the pin's box.
 * ⚠️ SAME ROOT CAUSE as the roads blob drawing off-centre: an extent snapped to a tile grid instead of to the pin.
 */
import { describe, expect, it } from "vitest";
import { kmToDegSpan } from "../../../shared/kmGeo";

/** The tile-grid box the imagery tiles cover, as the bake computes it. */
function tileGridBox(lng: number, lat: number, radiusKm: number, z: number) {
	const { dLat, dLng } = kmToDegSpan(radiusKm, lat);
	const n = 2 ** z;
	const X = (lo: number) => Math.floor(((lo + 180) / 360) * n);
	const Y = (la: number) => {
		const s = Math.sin((la * Math.PI) / 180);
		return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
	};
	const t2lng = (x: number) => (x / n) * 360 - 180;
	const t2lat = (y: number) => {
		const m = Math.PI - (2 * Math.PI * y) / n;
		return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
	};
	return {
		w: t2lng(X(lng - dLng)),
		e: t2lng(X(lng + dLng) + 1),
		n: t2lat(Y(lat + dLat)),
		s: t2lat(Y(lat - dLat) + 1),
	};
}

/** The crop the bake applies — must match satelliteImage.ts exactly. */
function cropBox(lng: number, lat: number, radiusKm: number, z: number) {
	const b = tileGridBox(lng, lat, radiusKm, z);
	const span = kmToDegSpan(radiusKm, lat);
	return {
		w: Math.max(b.w, lng - span.dLng),
		e: Math.min(b.e, lng + span.dLng),
		s: Math.max(b.s, lat - span.dLat),
		n: Math.min(b.n, lat + span.dLat),
	};
}

/** Metres between a box's centre and the pin. */
function offsetM(
	box: { w: number; e: number; s: number; n: number },
	lng: number,
	lat: number,
): number {
	const dx =
		((box.w + box.e) / 2 - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
	const dy = ((box.s + box.n) / 2 - lat) * 110_574;
	return Math.hypot(dx, dy);
}

const ANCHORS: Array<[number, number]> = [
	[-111.939, 44.4744], // the user's own test pin
	[-123.1, 49.25],
	[0.0001, 0.0001],
	[19.11, 17.55],
	[-80.62, 45.374],
];

describe("the satellite photo is centred", () => {
	it("⛔ CROPPED BOX IS CENTRED ON THE PIN — within a metre", () => {
		for (const [lng, lat] of ANCHORS) {
			const off = offsetM(cropBox(lng, lat, 2, 14), lng, lat);
			expect(off, `pin ${lng},${lat} is ${off.toFixed(0)} m off centre`).toBeLessThan(1);
		}
	});

	it("the TILE-GRID box it replaces really was off-centre", () => {
		const worst = Math.max(
			...ANCHORS.map(([lng, lat]) => offsetM(tileGridBox(lng, lat, 2, 14), lng, lat)),
		);
		expect(worst).toBeGreaterThan(50);
	});

	it("the crop never expands past the fetched tiles", () => {
		// cropping outward would show blank canvas — no imagery fetched there
		for (const [lng, lat] of ANCHORS) {
			const b = tileGridBox(lng, lat, 2, 14);
			const c = cropBox(lng, lat, 2, 14);
			expect(c.w).toBeGreaterThanOrEqual(b.w);
			expect(c.e).toBeLessThanOrEqual(b.e);
			expect(c.s).toBeGreaterThanOrEqual(b.s);
			expect(c.n).toBeLessThanOrEqual(b.n);
		}
	});

	it("⛔ the bake crops the CANVAS, not just the stored bounds", async () => {
		// shrinking bounds alone squashes the image — both must derive from the same crop box
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			fileURLToPath(new URL("../../../onPhone/satellite/satelliteImage.ts", import.meta.url)),
			"utf8",
		);
		expect(src).toContain("bounds: [cw, cs, ce, cn]");
		expect(src).toContain("const xExt = ((ce - cw) * Math.PI) / 180;");
		expect(src).toContain("const yTop = mercY(cn);");
	});
});
