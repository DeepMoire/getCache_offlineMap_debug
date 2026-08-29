import { describe, expect, it } from "vitest";
import { keysForAddress } from "./pinTileLookup";
import { pinTileKey } from "../../contract/grid";
import { cellsFor } from "../../contract/grid";
import { BLOB_TILE_Z } from "../../contract/grid";
import { RAW_MIN_Z, RAW_MAX_Z } from "./rawWallProtocol";

// A real pin (Ottawa valley) — one of the three fixture pins the bake service reconciles over.
const PIN = { lng: -76.16798, lat: 45.061348 };

/** Exactly what the download path writes into IndexedDB for this pin. */
function storedKeysFor(lng: number, lat: number): string[] {
	return cellsFor(lng, lat).map((c) => pinTileKey(lng, lat, c));
}

describe("stored tiles are findable at the zooms the map renders", () => {
	it("the writer produces at least one key for a real pin", () => {
		// Guards the test itself — if cellsFor ever returns nothing, every assertion below passes vacuously and proves the opposite of what it claims.
		expect(storedKeysFor(PIN.lng, PIN.lat).length).toBeGreaterThan(0);
	});

	it("finds the stored tile at its OWN address", () => {
		const stored = storedKeysFor(PIN.lng, PIN.lat);
		// Parse one key back to its own address and ask for exactly that — a miss here means write and read disagree outright.
		const [, , z, x, y] = stored[0].split("/");
		const hits = keysForAddress(stored, Number(z), Number(x), Number(y));
		expect(hits).toContain(stored[0]);
	});

	it("finds it from every zoom the renderer actually asks for", () => {
		const stored = storedKeysFor(PIN.lng, PIN.lat);
		const [, , zStr, xStr, yStr] = stored[0].split("/");
		const sz = Number(zStr);
		let sx = Number(xStr);
		let sy = Number(yStr);

		// RAW_MIN_Z..RAW_MAX_Z is the span the wall protocol serves — the camera sits inside it, so a miss anywhere in this range is a blank map.
		const misses: string[] = [];
		for (let z = RAW_MAX_Z; z >= RAW_MIN_Z; z--) {
			// Climb the stored address up to this zoom — the ancestor tile that geometrically contains it, which is what MapLibre requests.
			let ax = sx;
			let ay = sy;
			for (let level = sz; level > z; level--) {
				ax = Math.floor(ax / 2);
				ay = Math.floor(ay / 2);
			}
			if (!keysForAddress(stored, z, ax, ay).length) {
				misses.push(`z${z} (${ax},${ay})`);
			}
		}
		expect(misses, `no tile found at: ${misses.join(", ")}`).toEqual([]);
	});

	it("does NOT match an unrelated tile on the other side of the world", () => {
		// The mirror of the bug above — a lookup that matches everything hides a miss just as effectively as one that matches nothing.
		const stored = storedKeysFor(PIN.lng, PIN.lat);
		expect(keysForAddress(stored, BLOB_TILE_Z, 1, 1)).toEqual([]);
	});
});
