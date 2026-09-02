// ⚠️ Roads must draw when the camera is above the stored zoom — keysForAddress must match by real geometric containment, not exact z/x/y string equality, or a zoomed-out camera reads zero roads.
// NOTE: the ANCESTOR (z5) cases below exercise the lookup's depth only — since RAW_MIN_Z === BLOB_MIN_Z the protocol can no longer be asked a shallower address; the branch stays as defense-in-depth.
import { describe, expect, it } from "vitest";
import { keysForAddress } from "./pinTileLookup";
import { RAW_MAX_Z, RAW_MIN_Z } from "./rawWallProtocol";
import { BLOB_MIN_Z } from "../../contract/roadBlob";

/** A pin near Spokane. */
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
		expect(keysForAddress(stored, Z5.z, Z5.x, Z5.y)).toEqual(stored);
	});

	it("does NOT match a different tile at the same shallow zoom", () => {
		expect(keysForAddress(stored, Z5.z, Z5.x + 1, Z5.y)).toEqual([]);
		expect(keysForAddress(stored, Z5.z, Z5.x, Z5.y + 1)).toEqual([]);
	});

	it("ANSWERS a deeper address with the tile that contains it", () => {
		// ⛔ this used to assert the OPPOSITE (expected [] on deeper addresses) — that was the bug that left z13-z14 cameras reading nothing from disk.
		expect(keysForAddress(stored, 12, Z8.x * 16, Z8.y * 16)).toEqual(stored);
	});

	it("still refuses a deeper address OUTSIDE the stored tile", () => {
		expect(keysForAddress(stored, 12, (Z8.x + 1) * 16, Z8.y * 16)).toEqual([]);
	});

	it("never answers from a stored zoom OUTSIDE the pyramid (foreign/stale data)", () => {
		// direction1/pv46 left real z6/z7 roads-only tiles in the SAME IndexedDB; containment alone matched them
		// for z8 requests and the merge painted sparse interstates mis-framed and mis-scaled. A foreign zoom answers NOTHING, at any request zoom.
		const stale = `${PIN}/6/${Math.floor(Z8.x / 4)}/${Math.floor(Z8.y / 4)}`;
		expect(keysForAddress([stale], Z8.z, Z8.x, Z8.y)).toEqual([]);
		expect(keysForAddress([stale], 6, Math.floor(Z8.x / 4), Math.floor(Z8.y / 4))).toEqual([]);
	});

	it("declares a render floor EQUAL to the stored level — no stretched tier below it", () => {
		// The zoom<8 distortion is gone BY CONTRACT: the blob never serves a shallower address than it stores; below the floor the world-base (offlineBaseStyle.ts) draws instead.
		expect(RAW_MIN_Z).toBe(RAW_MAX_Z);
		expect(RAW_MIN_Z).toBe(BLOB_MIN_Z);
	});
});
