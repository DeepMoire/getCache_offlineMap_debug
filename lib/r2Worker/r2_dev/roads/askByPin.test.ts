// ⛔ a cache key may be DERIVED from the request, but must never REPLACE it — sending the cell centre instead of the pin silently moved the data 70km off in production.
import { describe, expect, it } from "vitest";
import { cellBox, cellOf, cellTileKey } from "../../../contract/grid";

/** Km between two lng/lat points. */
function km(lng1: number, lat1: number, lng2: number, lat2: number): number {
	const dLat = (lat2 - lat1) * 110.574;
	const dLng =
		(lng2 - lng1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
	return Math.hypot(dLat, dLng);
}

const PINS: Array<[number, number, string]> = [
	[-2.92565, 16.7277, "Timbuktu (near a cell corner)"],
	[-115.4419, 41.905, "Nevada"],
	[-76.168, 45.061, "Ontario"],
	[0.001, 0.001, "equator"],
];

describe("the pack is asked about the PIN", () => {
	it("⛔ the URL carries the PIN, never the cell centre", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			fileURLToPath(new URL("./packDownload.ts", import.meta.url)),
			"utf8",
		);
		expect(src).toContain("const qLng = lng.toFixed(6);");
		expect(src).toContain("const qLat = lat.toFixed(6);");
		// The cell-centre spelling is the bug. It must not come back.
		expect(src).not.toContain("(box.w + box.e) / 2");
		expect(src).not.toContain("(box.s + box.n) / 2");
	});

	it("⛔ the cell centre is FAR from a pin near an edge — why it mattered", () => {
		// documents the size of the error — if a future cell size ever makes this small, this threshold may need revisiting.
		const [lng, lat] = PINS[0];
		const b = cellBox(cellOf(lng, lat));
		const off = km(lng, lat, (b.w + b.e) / 2, (b.s + b.n) / 2);
		expect(off).toBeGreaterThan(50);
	});

	it("the pin and the server agree on the storage key", () => {
		// both sides derive the key from the SAME point — a mismatch here is a blank map with no error, this subsystem's signature failure.
		for (const [lng, lat, name] of PINS) {
			const clientKey = cellTileKey(cellOf(lng, lat));
			const serverKey = cellTileKey(cellOf(Number(lng.toFixed(6)), Number(lat.toFixed(6))));
			expect(serverKey, name).toBe(clientKey);
		}
	});

	it("rounding the URL to 6dp never moves the pin to another cell", () => {
		// 6dp is ~11cm — a pin on a cell boundary must not round across it, or client and server would key differently.
		for (const [lng, lat] of PINS) {
			const exact = cellTileKey(cellOf(lng, lat));
			const rounded = cellTileKey(
				cellOf(Number(lng.toFixed(6)), Number(lat.toFixed(6))),
			);
			expect(rounded).toBe(exact);
		}
	});
});
