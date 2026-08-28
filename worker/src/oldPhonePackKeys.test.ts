/**
 * THE PACK ITSELF, NOT JUST THE BRANCH.
 *
 * THE FIELD REPORT (27 Aug 2026): "the satellite came, but the roads didn't."
 *
 * On 2026-08-20 the Worker started keying road tiles by the PIN
 * (`pin/<lng>,<lat>/<z>/<x>/<y>`) instead of by the grid cell (`<z>/<x>/<y>`),
 * fixing the 50 km bug where two pins in one square shared a blob. Correct fix
 * — but the installed App Store build (iOS 1.0.93, 21 Jul 2026,
 * PACK_FORMAT_VERSION 15) stores whatever key it is sent and then looks tiles
 * up by its OWN `${z}/${x}/${y}`. Every lookup missed: the bytes reached the
 * phone and were unreachable, so the map drew NO ROADS. Roads only — the
 * satellite travels under `${lng},${lat}`, never shared a key, and kept
 * working, which is exactly how it presented in the field.
 *
 * This test drives the REAL `buildPack` and reads the keys out of the manifest
 * it serialises. It fails if the pv branch is removed — which is the point:
 * asserting the key HELPERS in isolation passes even with the bug restored.
 */
import { describe, expect, it, vi } from "vitest";

/** Every source tile is a non-empty stub; the filter is stubbed to keep a
 *  road blob alive so tiles actually reach the manifest. */
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
		// THE ASSERTION THE FIELD BUG NEEDED. A `pin/` prefix here is a phone
		// that stores roads it can never look up again.
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
		// The modern key is the legacy key with the pin's address in front, so
		// one pack's tiles map onto the other's addresses exactly.
		expect(now.every((k, i) => k.endsWith(old[i]))).toBe(true);
	});
});
