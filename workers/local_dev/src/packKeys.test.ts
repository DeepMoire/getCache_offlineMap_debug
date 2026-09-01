import { describe, expect, it, vi } from "vitest";

/** Every source tile is a non-empty stub; the filter passes bytes through so tiles reach the manifest. */
vi.mock("./mvtFilter", () => ({
	filterMvtToLayers: (b: ArrayBuffer) => b,
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

describe("buildPack keys every tile by the PIN", () => {
	it("pin/… keys only — a cell key is shared by neighbouring pins (the 50 km bug)", async () => {
		const { buildPack } = await import("./packBuilder");
		const keys = keysOf(await buildPack(archive, LNG, LAT));

		expect(keys.length).toBeGreaterThan(0);
		for (const k of keys) {
			expect(k).toMatch(/^pin\/-?[\d.]+,-?[\d.]+\/\d+\/\d+\/\d+$/);
		}
	});

	it("two different pins never share a key", async () => {
		const { buildPack } = await import("./packBuilder");
		const a = new Set(keysOf(await buildPack(archive, LNG, LAT)));
		const b = keysOf(await buildPack(archive, LNG + 0.01, LAT));

		expect(b.length).toBeGreaterThan(0);
		for (const k of b) expect(a.has(k)).toBe(false);
	});
});
