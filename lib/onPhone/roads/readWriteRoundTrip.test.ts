import { describe, expect, it } from "vitest";
import { keysForAddress } from "./pinTileLookup";
import { pinTileKey } from "../../contract/grid";
import { cellsFor } from "../../contract/grid";
import { BLOB_TILE_Z } from "../../contract/grid";
import { RAW_MIN_Z, RAW_MAX_Z } from "./rawWallProtocol";

/**
 * WRITE → READ ROUND TRIP. The one test that would have caught a day of "the
 * map is blank while megabytes sit on disk".
 *
 * MEASURED 27 Aug 2026 in a live browser on localhost:5174/offline/debug, with
 * a pack successfully downloaded and stored (the panel read `1 area · 574 KB`):
 *
 *     [roads] ⚠️ map is reading NOTHING from disk (4 tiles asked, 0 found)
 *
 * Downloads worked. Storage worked. The renderer asked for four tiles and the
 * lookup answered with nothing for every one of them.
 *
 * WHY A ROUND TRIP AND NOT TWO UNIT TESTS. The write side and the read side
 * were each self-consistent and separately tested; the disagreement lived in
 * the SEAM between them, which no test crossed. So this test refuses to
 * hand-write a key: it asks the real writer (`pinTileKey` + `cellsFor`) for
 * what actually lands on disk, then asks the real reader (`keysForAddress`)
 * to find it. Anything that changes either side's idea of an address reddens
 * this file rather than blanking a map in silence.
 */

// A real pin. Ottawa valley — one of the three fixture pins the bake service
// reconciles over, so these are addresses the app genuinely asks for.
const PIN = { lng: -76.16798, lat: 45.061348 };

/** Exactly what the download path writes into IndexedDB for this pin. */
function storedKeysFor(lng: number, lat: number): string[] {
	return cellsFor(lng, lat).map((c) => pinTileKey(lng, lat, c));
}

describe("stored tiles are findable at the zooms the map renders", () => {
	it("the writer produces at least one key for a real pin", () => {
		// Guards the test itself: if cellsFor ever returns nothing, every
		// assertion below would pass vacuously and prove the opposite of what
		// it claims.
		expect(storedKeysFor(PIN.lng, PIN.lat).length).toBeGreaterThan(0);
	});

	it("finds the stored tile at its OWN address", () => {
		const stored = storedKeysFor(PIN.lng, PIN.lat);
		// Parse one key back to the address it was filed under and ask for
		// exactly that. If this misses, write and read disagree outright.
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

		// RAW_MIN_Z..RAW_MAX_Z is the span the wall protocol serves. The camera
		// sits inside it, so a miss anywhere in this range is a blank map.
		const misses: string[] = [];
		for (let z = RAW_MAX_Z; z >= RAW_MIN_Z; z--) {
			// Climb the stored address up to this zoom — the ancestor tile that
			// geometrically contains it, which is what MapLibre requests.
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
		// The mirror of the bug above: a lookup that matches everything hides a
		// miss just as effectively as one that matches nothing.
		const stored = storedKeysFor(PIN.lng, PIN.lat);
		expect(keysForAddress(stored, BLOB_TILE_Z, 1, 1)).toEqual([]);
	});
});
