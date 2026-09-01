import { describe, expect, it } from "vitest";
import {
	cellKeysForDisc,
	HOSPITAL_RADIUS_KM,
	hospitalsCollection,
	parseHospitalsPack,
	readCellEntries,
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

describe("bundled pack", () => {
	it("round-trips: bake format → parse → cell read", () => {
		// Mirrors bakeHospitals.mjs's serializer byte-for-byte, in miniature.
		const enc = new TextEncoder();
		const cellA: HospitalEntry[] = [[-122.7, 53.9, "UHNBC", "yes"]];
		const cellB: HospitalEntry[] = [[-79.4, 43.7, "Toronto General"]];
		const aBytes = enc.encode(JSON.stringify(cellA));
		const bBytes = enc.encode(JSON.stringify(cellB));
		const index = {
			v: 1,
			cellDeg: 5,
			count: 2,
			generated: "2026-09-01",
			cells: {
				"27_11": [0, aBytes.byteLength],
				"26_20": [aBytes.byteLength, bBytes.byteLength],
			},
		};
		const idxBytes = enc.encode(JSON.stringify(index));
		const pack = new Uint8Array(
			4 + idxBytes.byteLength + aBytes.byteLength + bBytes.byteLength,
		);
		new DataView(pack.buffer).setUint32(0, idxBytes.byteLength, true);
		pack.set(idxBytes, 4);
		pack.set(aBytes, 4 + idxBytes.byteLength);
		pack.set(bBytes, 4 + idxBytes.byteLength + aBytes.byteLength);

		const parsed = parseHospitalsPack(pack.buffer);
		expect(parsed.index.count).toBe(2);
		expect(
			readCellEntries(pack.buffer, parsed.dataOrigin, parsed.index.cells["27_11"] as [number, number]),
		).toEqual(cellA);
		expect(
			readCellEntries(pack.buffer, parsed.dataOrigin, parsed.index.cells["26_20"] as [number, number]),
		).toEqual(cellB);
	});

	it("refuses a malformed pack instead of answering empty", () => {
		const enc = new TextEncoder();
		const junk = enc.encode(JSON.stringify({ nothing: true }));
		const pack = new Uint8Array(4 + junk.byteLength);
		new DataView(pack.buffer).setUint32(0, junk.byteLength, true);
		pack.set(junk, 4);
		expect(() => parseHospitalsPack(pack.buffer)).toThrow(/malformed/);
	});
});
