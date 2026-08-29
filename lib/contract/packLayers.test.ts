/**
 * THE PACK CONTRACT, ASSERTED — and held in lockstep with the phone's toggles.
 *
 * The Worker's allowlist is derived from PACK_LAYERS (worker/src/mvtFilter.test.ts
 * proves that side). This side proves every pack-fed toggle in wallLegend.ts
 * reads something the contract ships, so the debug report's `expects` row can
 * never say "covered" for a layer the Worker strips — or the reverse.
 */
import { describe, expect, it } from "vitest";
import { LAYER_TOGGLES } from "../onPhone/render/wallLegend";
import {
	PACK_LAYERS,
	PACK_LAYER_NAMES,
	describePackLayer,
	packShips,
} from "./packLayers";

describe("PACK_LAYERS", () => {
	it("ships roads, water, places and pois — and nothing that paints nothing", () => {
		expect([...PACK_LAYER_NAMES].sort()).toEqual(["places", "pois", "roads", "water"]);
		for (const dead of ["landuse", "landcover", "earth", "buildings", "boundaries"]) {
			expect(PACK_LAYERS[dead]).toBeUndefined();
		}
	});

	it("matches places on kind_detail — every v4 places feature is kind:locality", () => {
		// MEASURED 28 Aug 2026: 214/214 places features in one disc were
		// `kind:"locality"`; city/town/village/hamlet live in `kind_detail`.
		expect(PACK_LAYERS.places.key).toBe("kind_detail");
		expect(packShips({ layer: "places", key: "kind_detail", kinds: ["city", "hamlet"] })).toBe(true);
		expect(packShips({ layer: "places", kinds: ["city"] })).toBe(false); // wrong key
	});

	it("packShips answers per read", () => {
		expect(packShips({ layer: "roads" })).toBe(true);
		expect(packShips({ layer: "roads", kinds: ["path"] })).toBe(true);
		expect(packShips({ layer: "water" })).toBe(false); // whole layer wanted, subset shipped
		expect(packShips({ layer: "water", kinds: ["lake", "river"] })).toBe(true);
		expect(packShips({ layer: "water", kinds: ["stream"] })).toBe(false);
		expect(packShips({ layer: "pois", kinds: ["hospital"] })).toBe(true);
		expect(packShips({ layer: "pois", kinds: ["cafe"] })).toBe(false);
		expect(packShips({ layer: "landuse" })).toBe(false);
	});

	it("describes a layer for a report", () => {
		expect(describePackLayer("roads")).toBe("roads (all)");
		expect(describePackLayer("pois")).toBe("pois kind∈{hospital,camp_site}");
		expect(describePackLayer("earth")).toBe("earth (NOT shipped)");
	});
});

describe("wallLegend toggles stay in lockstep with the contract", () => {
	it("every pack-fed toggle declares reads, and the pack ships all of them", () => {
		for (const t of LAYER_TOGGLES) {
			if (t.feed !== "pack") continue;
			expect(t.reads?.length, `${t.key} must say what it reads from the pack`).toBeGreaterThan(0);
			for (const r of t.reads!) {
				expect(packShips(r), `${t.key} reads ${JSON.stringify(r)} which the pack does not ship`).toBe(true);
			}
		}
	});
});
