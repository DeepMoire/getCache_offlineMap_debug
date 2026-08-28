import { describe, expect, it } from "vitest";
import { keysForAddress } from "./lib/onPhone/roads/pinTileLookup";

// THE EXACT keys prod returned for a Kingston pin, measured 27 Aug 2026.
const STORED = [
	"pin/-76.48600,44.23120/8/73/92",
	"pin/-76.48600,44.23120/8/73/93",
];

describe("the reader finds the tiles prod actually shipped", () => {
	it("finds tile 8/73/92 at its own address", () => {
		expect(keysForAddress(STORED, 8, 73, 92)).toContain(STORED[0]);
	});
	it("finds tile 8/73/93 at its own address", () => {
		expect(keysForAddress(STORED, 8, 73, 93)).toContain(STORED[1]);
	});
	it("finds them from the zooms the camera renders at", () => {
		const misses: string[] = [];
		for (let z = 8; z <= 14; z++) {
			const f = 2 ** (z - 8);
			if (!keysForAddress(STORED, z, 73 * f, 92 * f).length) misses.push(`z${z}`);
		}
		expect(misses, `no tile found at ${misses.join(", ")}`).toEqual([]);
	});
});
