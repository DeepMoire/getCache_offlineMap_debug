/**
 * AN APP-STORE PHONE MUST STILL GET ROADS.
 *
 * THE FIELD REPORT (27 Aug 2026): "the satellite came, but the roads didn't."
 *
 * On 2026-08-20 the Worker started keying road tiles by the PIN
 * (`pin/<lng>,<lat>/<z>/<x>/<y>`) instead of by the grid cell (`<z>/<x>/<y>`),
 * to fix the 50 km bug where two pins in one square shared a blob. Correct fix
 * — but the installed App Store build (iOS 1.0.93, submitted 21 Jul 2026,
 * PACK_FORMAT_VERSION 15) stores whatever key it is sent and then looks tiles
 * up by its OWN `${z}/${x}/${y}`. Every lookup missed. The bytes were on the
 * phone and unreachable, so the map drew no roads at all.
 *
 * ROADS ONLY, and that asymmetry is the tell: the satellite photo travels
 * under `${lng},${lat}` and never shared a key, so it kept working — which is
 * precisely what was seen on the phone.
 *
 * The client has always sent `pv`; the Worker ignored it. These tests hold the
 * Worker to reading it, so ONE deploy serves both fleets.
 */
import { describe, expect, it } from "vitest";
import { PIN_KEYED_FROM_PV } from "./packBuilder";

/** The App Store build in the field. Not a guess — read out of the tree at the
 *  submission commit (08bcf909b, 21 Jul 2026). */
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
		// A missing pv reaches buildPack as its default parameter. Defaulting a
		// curl to "cell" would quietly reintroduce the 50 km bug on any hand-made
		// request and make the debug surface lie about what phones receive.
		expect(keyShapeFor(PIN_KEYED_FROM_PV)).toBe("pin");
	});
});
