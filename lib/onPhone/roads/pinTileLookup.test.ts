// ⛔ Two pins sharing one grid address were served each other's roads tiles — measured a 36.6 km offset.
import { describe, expect, it } from "vitest";
import { pinTileKey } from "../../contract/grid";
import {
	keyForAddress,
	keysForAddress,
	parsePinTileKey,
	tileCentre,
} from "./pinTileLookup";

const MORAN = { lng: -110.7261, lat: 44.0618 };
const YELLOWSTONE = { lng: -110.747, lat: 44.6629 };

describe("pinTileLookup — one address, the RIGHT pin", () => {
	it("round-trips a pin key", () => {
		const c = { ix: 49, iy: 93, z: 8 };
		const k = pinTileKey(MORAN.lng, MORAN.lat, c);
		const p = parsePinTileKey(k);
		expect(p).not.toBeNull();
		expect(p?.lng).toBeCloseTo(MORAN.lng, 5);
		expect(p?.lat).toBeCloseTo(MORAN.lat, 5);
		expect(p?.address).toBe("8/49/93");
	});

	it("ignores a legacy bare z/x/y key (old blobs are not mistaken for a pin's)", () => {
		expect(parsePinTileKey("8/49/93")).toBeNull();
	});

	// The tile must resolve to whichever pin it actually sits nearest — never "whatever was stored first" (that produced the 50.4 km reading).
	it("⛔ two pins sharing one address each get their OWN roads", () => {
		const c = { ix: 49, iy: 92, z: 8 };
		const moranKey = pinTileKey(MORAN.lng, MORAN.lat, c);
		const yellKey = pinTileKey(YELLOWSTONE.lng, YELLOWSTONE.lat, c);
		const disk = [moranKey, yellKey];

		const north = tileCentre(8, 49, 92);
		const nearYell = keyForAddress(
			disk,
			8,
			49,
			92,
		);
		expect(nearYell).not.toBeNull();

		const dY = Math.hypot(north.lng - YELLOWSTONE.lng, north.lat - YELLOWSTONE.lat);
		const dM = Math.hypot(north.lng - MORAN.lng, north.lat - MORAN.lat);
		expect(nearYell).toBe(dY < dM ? yellKey : moranKey);
	});

	it("returns null on a miss — NEVER another pin's bytes", () => {
		const disk = [pinTileKey(MORAN.lng, MORAN.lat, { ix: 49, iy: 93, z: 8 })];
		expect(keyForAddress(disk, 8, 10, 10)).toBeNull();
	});

	it("an empty disk is a miss, not a crash", () => {
		expect(keyForAddress([], 8, 49, 93)).toBeNull();
	});

	// ⛔ THE HALF-A-MAP BUG — returning only the nearest owner drew nothing for every other pin sharing that tile; must return ALL owners.
	it("⛔ returns EVERY pin that owns an address, not just the nearest", () => {
		const c = { ix: 49, iy: 92, z: 8 };
		const moranKey = pinTileKey(MORAN.lng, MORAN.lat, c);
		const yellKey = pinTileKey(YELLOWSTONE.lng, YELLOWSTONE.lat, c);
		const all = keysForAddress([moranKey, yellKey], 8, 49, 92);
		expect(all).toHaveLength(2);
		expect(new Set(all)).toEqual(new Set([moranKey, yellKey]));
	});

	it("orders nearest FIRST (so the looked-at pin's layers lead)", () => {
		const c = { ix: 49, iy: 92, z: 8 };
		const moranKey = pinTileKey(MORAN.lng, MORAN.lat, c);
		const yellKey = pinTileKey(YELLOWSTONE.lng, YELLOWSTONE.lat, c);
		const centre = tileCentre(8, 49, 92);
		const dY = Math.hypot(centre.lng - YELLOWSTONE.lng, centre.lat - YELLOWSTONE.lat);
		const dM = Math.hypot(centre.lng - MORAN.lng, centre.lat - MORAN.lat);
		const all = keysForAddress([moranKey, yellKey], 8, 49, 92);
		expect(all[0]).toBe(dY < dM ? yellKey : moranKey);
	});

	it("an address nobody owns yields an empty list, not a neighbour's key", () => {
		const disk = [pinTileKey(MORAN.lng, MORAN.lat, { ix: 49, iy: 93, z: 8 })];
		expect(keysForAddress(disk, 8, 10, 10)).toEqual([]);
	});
});
