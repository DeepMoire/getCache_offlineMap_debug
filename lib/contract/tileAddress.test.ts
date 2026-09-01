/** ⚠️ splitting a pin-addressed key on "/" silently returns NaN z/x/y instead of throwing — this suite locks the fix. */
import { describe, expect, it } from "vitest";
import { parseTileAddress } from "../worker/worker-local-dev/roads/packDownload";
import { pinTileKey } from "./grid";

describe("parseTileAddress — never emit NaN", () => {
	it("reads z/x/y out of a PIN-addressed key", () => {
		const key = pinTileKey(-108.3021, 44.4966, { ix: 49, iy: 92, z: 8 });
		expect(parseTileAddress(key)).toEqual({ z: 8, x: 49, y: 92 });
	});

	it("still reads a LEGACY bare key (a mid-migration device is not half-blind)", () => {
		expect(parseTileAddress("8/49/92")).toEqual({ z: 8, x: 49, y: 92 });
	});

	it("⛔ the OLD parse produced NaN on a pin key — this one does not", () => {
		const key = pinTileKey(-108.3021, 44.4966, { ix: 49, iy: 92, z: 8 });
		const [oldZ] = key.split("/").map(Number);
		expect(Number.isNaN(oldZ)).toBe(true); // what shipped

		const addr = parseTileAddress(key);
		expect(addr).not.toBeNull();
		expect(Number.isFinite(addr?.z)).toBe(true);
		expect(Number.isFinite(addr?.x)).toBe(true);
		expect(Number.isFinite(addr?.y)).toBe(true);
	});

	it("returns null on junk rather than a NaN address", () => {
		for (const junk of ["", "pin/", "pin/nonsense/8/49", "a/b/c", "pin/1,2/x/y/z"])
			expect(parseTileAddress(junk)).toBeNull();
	});
});
