import { describe, expect, it } from "vitest";
import {
	cellKeysForDisc,
	HOSPITAL_RADIUS_KM,
	hospitalsCollection,
	type HospitalEntry,
} from "./hospitals";

// The radius filter moved SERVER-side from the phone (the online map used to
// bake Canada and filter 3,005 points on-device) — these guard the promise the
// route makes to the client: within-radius kept, beyond-radius dropped, the
// emergency tag intact, and the whole world never in one answer.

describe("cellKeysForDisc", () => {
	it("covers the centre cell and its disc neighbours", () => {
		const keys = cellKeysForDisc(-75.7, 45.4, 5, HOSPITAL_RADIUS_KM);
		expect(keys).toContain("27_20"); // floor((45.4+90)/5)=27, floor((-75.7+180)/5)=20
		expect(keys.length).toBeGreaterThan(1);
		expect(keys.length).toBeLessThan(20); // a disc, never a continent
	});

	it("wraps the antimeridian instead of walking off the grid", () => {
		const keys = cellKeysForDisc(179.5, 0, 5, HOSPITAL_RADIUS_KM);
		for (const k of keys) {
			const cx = Number(k.split("_")[1]);
			expect(cx).toBeGreaterThanOrEqual(0);
			expect(cx).toBeLessThan(72);
		}
		expect(keys).toContain("18_0"); // the far side of the seam
	});

	it("survives a polar centre without exploding the lng span", () => {
		const keys = cellKeysForDisc(0, 89, 5, HOSPITAL_RADIUS_KM);
		expect(keys.length).toBeLessThanOrEqual(2 * 72);
	});
});

describe("hospitalsCollection", () => {
	const anchor: [number, number] = [-122.75, 53.92]; // Prince George, BC
	const near: HospitalEntry = [-122.7, 53.9, "UHNBC", "yes"];
	const far: HospitalEntry = [-79.4, 43.7, "Toronto General"]; // ~3,400 km

	it("keeps within-radius, drops beyond-radius", () => {
		const fc = hospitalsCollection([[near, far]], anchor[0], anchor[1]);
		expect(fc.features.map((f) => f.properties.name)).toEqual(["UHNBC"]);
	});

	it("carries the emergency tag through raw, and omits it when untagged", () => {
		const untagged: HospitalEntry = [-122.8, 53.95, "Clinic"];
		const fc = hospitalsCollection([[near, untagged]], anchor[0], anchor[1]);
		expect(fc.features[0].properties.emergency).toBe("yes");
		expect("emergency" in fc.features[1].properties).toBe(false);
	});
});
