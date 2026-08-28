import { describe, expect, it } from "vitest";
import { keysForAddress } from "./lib/onPhone/roads/pinTileLookup";

// READ OUT OF THE LIVE BROWSER'S IndexedDB, 27 Aug 2026.
const STORED = [
	"pin/-76.16798,45.06135/8/73/91",
	"pin/-76.16798,45.06135/8/73/92",
	"pin/-76.16798,45.06135/8/74/91",
	"pin/-76.16798,45.06135/8/74/92",
];

describe("the shipped lookup vs the tiles actually on disk", () => {
	for (let z = 5; z <= 16; z++) {
		it(`z${z} finds something`, () => {
			const f = z >= 8 ? 2 ** (z - 8) : 1;
			const x = z >= 8 ? 73 * f : Math.floor(73 / 2 ** (8 - z));
			const y = z >= 8 ? 91 * f : Math.floor(91 / 2 ** (8 - z));
			expect(keysForAddress(STORED, z, x, y).length, `z${z} (${x},${y})`).toBeGreaterThan(0);
		});
	}
});
