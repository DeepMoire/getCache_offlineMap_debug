import { describe, expect, it, vi } from "vitest";

/** Every source tile is a non-empty stub; the filter is stubbed to keep a road blob alive so tiles reach the manifest. */
vi.mock("./mvtFilter", () => ({
	filterTile: (b: Uint8Array) => b,
}));
vi.mock("./oneBlob", () => ({
	buildBlobTile: () => ({ bytes: new Uint8Array([1, 2, 3, 4]), features: 1 }),
	boxFrame: () => ({ w: 0, s: 0, e: 1, n: 1 }),
}));

/** A PMTiles stand-in: every requested tile returns four bytes. */
const archive = {
	getHeader: async () => ({}),
	getZxy: async () => ({ data: new Uint8Array([9, 9, 9, 9]).buffer }),
} as never;

/** Read the manifest back out of the packed bytes. */
function keysOf(pack: ArrayBuffer): string[] {
	const buf = new Uint8Array(pack);
	const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
	const manifest = JSON.parse(
		new TextDecoder().decode(buf.subarray(4, 4 + len)),
	) as { tiles: Array<{ k: string }> };
	return manifest.tiles.map((t) => t.k);
}

const LNG = -123.0694;
const LAT = 49.2606;

describe("buildPack keys tiles by the CLIENT's pack version", () => {
	it("pv 15 (the App Store phone) gets bare z/x/y keys it can find", async () => {
		const { buildPack } = await import("./packBuilder");
		const keys = keysOf(await buildPack(archive, LNG, LAT, false, {}, 15));

		expect(keys.length).toBeGreaterThan(0);
		// A `pin/` prefix here means a phone that stores roads it can never look up again.
		for (const k of keys) {
			expect(k).toMatch(/^\d+\/\d+\/\d+$/);
		}
	});

	it("pv 44 (a current client) gets pin/… keys — the 50 km fix stays fixed", async () => {
		const { buildPack } = await import("./packBuilder");
		const keys = keysOf(await buildPack(archive, LNG, LAT, false, {}, 44));

		expect(keys.length).toBeGreaterThan(0);
		for (const k of keys) {
			expect(k.startsWith("pin/")).toBe(true);
		}
	});

	it("the two fleets really do get different keys for the same pin", async () => {
		const { buildPack } = await import("./packBuilder");
		const old = keysOf(await buildPack(archive, LNG, LAT, false, {}, 15));
		const now = keysOf(await buildPack(archive, LNG, LAT, false, {}, 44));

		expect(old).not.toEqual(now);
		// The modern key is the legacy key with the pin's address in front, so one pack's tiles map onto the other's addresses exactly.
		expect(now.every((k, i) => k.endsWith(old[i]))).toBe(true);
	});
});
