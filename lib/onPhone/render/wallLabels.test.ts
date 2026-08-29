// ⚠️ icon-anchor must be "bottom" (the pin's point), never MapLibre's default "center" — center anchoring made pins visibly drift across the ground while zooming.
import { describe, expect, it } from "vitest";

import { addWallPois, POI_LAYER_IDS } from "./wallLabels";

/** Minimal map double: records addLayer specs, pretends every image exists. */
function fakeMap() {
	const layers: Record<string, any> = {};
	return {
		layers,
		hasImage: () => true,
		addImage: () => {},
		getLayer: (id: string) => layers[id],
		addLayer: (spec: any) => {
			layers[spec.id] = spec;
		},
	};
}

describe("offline POI pins are anchored at the tip", () => {
	it("every teardrop POI layer sets icon-anchor: bottom", async () => {
		const map = fakeMap();
		await addWallPois(map as never);

		// Guard the guard: if the layers stop being created, the assertions below would vacuously pass.
		expect(Object.keys(map.layers).sort()).toEqual([...POI_LAYER_IDS].sort());

		for (const id of POI_LAYER_IDS) {
			expect(map.layers[id].layout["icon-anchor"], `${id} must hang from its tip`).toBe(
				"bottom",
			);
		}
	});

	it("never leaves icon-anchor unset — the default is `center`, which is the bug", async () => {
		const map = fakeMap();
		await addWallPois(map as never);
		for (const id of POI_LAYER_IDS) {
			expect(map.layers[id].layout["icon-anchor"]).toBeDefined();
		}
	});
});
