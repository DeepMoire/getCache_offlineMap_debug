/**
 * ROADS MUST DRAW WHEN THE CAMERA IS ABOVE THE STORED ZOOM.
 *
 * THE FIELD REPORT (27 Aug 2026): 961 road blobs on disk, nothing on screen.
 * The app's own diagnostic printed both halves seconds apart:
 *     ✅ 2 road layer(s) drawing from 961 blob(s)
 *     961 blob(s) on disk but NO ROADS DRAWING — check the zoom span
 *
 * Blobs are stored at BLOB_TILE_Z (8). Two things conspired:
 *   1. the source declared `minzoom: 8`, and MapLibre only overzooms UP, so
 *      above z8 it asked for nothing at all;
 *   2. `keysForAddress` compared `z/x/y` as an exact STRING, so even when a
 *      shallower address was requested it matched no stored tile.
 *
 * A z5 tile geometrically CONTAINS the z8 tiles under it, so the honest answer
 * is every stored tile whose footprint falls inside the requested one.
 */
import { describe, expect, it } from "vitest";
import { keysForAddress } from "./pinTileLookup";
import { RAW_MAX_Z, RAW_MIN_Z } from "./rawWallProtocol";

/** A pin near Spokane — the coordinates from the field report's focused blob. */
const PIN = "pin/-117.10620,47.34330";

/** z8 tile containing that pin. */
const Z8 = { z: 8, x: 41, y: 90 };

/** The same ground at z5 — x and y halve once per level climbed. */
const Z5 = { z: 5, x: Math.floor(41 / 8), y: Math.floor(90 / 8) };

const stored = [`${PIN}/${Z8.z}/${Z8.x}/${Z8.y}`];

describe("a zoomed-out camera still finds the stored roads", () => {
	it("resolves the EXACT stored address", () => {
		expect(keysForAddress(stored, Z8.z, Z8.x, Z8.y)).toEqual(stored);
	});

	it("resolves an ANCESTOR address — the z5 tile that contains it", () => {
		// THE ASSERTION THE FIELD BUG NEEDED. Exact string matching returns [].
		expect(keysForAddress(stored, Z5.z, Z5.x, Z5.y)).toEqual(stored);
	});

	it("does NOT match a different tile at the same shallow zoom", () => {
		// Containment must be real geometry, not "anything shallower wins".
		expect(keysForAddress(stored, Z5.z, Z5.x + 1, Z5.y)).toEqual([]);
		expect(keysForAddress(stored, Z5.z, Z5.x, Z5.y + 1)).toEqual([]);
	});

	it("leaves DEEPER addresses to MapLibre's own overzoom", () => {
		// z12 is below the stored z8 tile; the renderer scales the z8 tile up
		// itself, so the lookup deliberately answers nothing here.
		expect(keysForAddress(stored, 12, Z8.x * 16, Z8.y * 16)).toEqual([]);
	});

	it("declares a render floor SHALLOWER than the stored level", () => {
		// The floor and the storage level being one number is the root cause.
		expect(RAW_MIN_Z).toBeLessThan(RAW_MAX_Z);
		expect(RAW_MIN_Z).toBe(5);
	});
});
