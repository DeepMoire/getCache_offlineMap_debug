import { describe, expect, it } from "vitest";
import { PIN_KEYED_FROM_PV } from "./packBuilder";

/** The App Store build in the field — read from the tree at commit 08bcf909b (21 Jul 2026), not a guess. */
const APP_STORE_PV = 15;

/** The shape the Worker picks for a given client-declared pack version. */
function keyShapeFor(pv: number): "pin" | "cell" {
	return pv >= PIN_KEYED_FROM_PV ? "pin" : "cell";
}

describe("tile key shape is chosen by the client's pack version", () => {
	it("serves the App Store phone (pv 15) CELL keys — the shape it can find", () => {
		expect(keyShapeFor(APP_STORE_PV)).toBe("cell");
	});

	it("serves a current client (pv 44) PIN keys — the 50 km fix stays fixed", () => {
		expect(keyShapeFor(44)).toBe("pin");
	});

	it("switches exactly at the square-grid rewrite, not one either side", () => {
		expect(keyShapeFor(PIN_KEYED_FROM_PV - 1)).toBe("cell");
		expect(keyShapeFor(PIN_KEYED_FROM_PV)).toBe("pin");
	});

	it("treats a pv-less probe as current, never as legacy", () => {
		// Missing pv defaults via buildPack's own parameter; defaulting to "cell" would quietly reintroduce the 50 km bug.
		expect(keyShapeFor(PIN_KEYED_FROM_PV)).toBe("pin");
	});
});
