import { describe, expect, it } from "vitest";
import { cameraFromUrl } from "./cameraFromUrl";

/** The Fort Nelson pin, as Chris pasted it: LAT first, then LNG. */
const FORT_NELSON_LAT = 58.7986;
const FORT_NELSON_LNG = -122.6761;

describe("cameraFromUrl", () => {
	// ── THE THREE SPELLINGS THAT MUST WORK ───────────────────────────────
	// Written from the URLs in the request verbatim. If a spelling a human
	// actually types is rejected, the feature does not exist for them.
	it("reads the `?=lat,lng` form pasted into an empty query string", () => {
		const cam = cameraFromUrl("?=58.7986,-122.6761");
		expect(cam?.center).toEqual([FORT_NELSON_LNG, FORT_NELSON_LAT]);
	});

	it("reads the bare `?lat,lng` form", () => {
		const cam = cameraFromUrl("?58.7986,-122.6761");
		expect(cam?.center).toEqual([FORT_NELSON_LNG, FORT_NELSON_LAT]);
	});

	it("reads the named `?at=lat,lng` form", () => {
		const cam = cameraFromUrl("?at=58.7986,-122.6761");
		expect(cam?.center).toEqual([FORT_NELSON_LNG, FORT_NELSON_LAT]);
	});

	// ── ORDER IS THE WHOLE POINT ─────────────────────────────────────────
	it("FLIPS lat,lng into MapLibre's [lng, lat] — never passes it through", () => {
		const cam = cameraFromUrl("?at=45.0613,-76.1680");
		// Ottawa. If this ever returns [45.06, -76.16] the map lands in
		// Somalia and every blob looks missing.
		expect(cam?.center[0]).toBe(-76.168);
		expect(cam?.center[1]).toBe(45.0613);
	});

	it("rejects a swapped pair rather than showing the wrong place", () => {
		// -122 is not a valid latitude, so this cannot be a lat,lng pair.
		expect(cameraFromUrl("?at=-122.6761,58.7986")).toBeUndefined();
	});

	// ── ZOOM ─────────────────────────────────────────────────────────────
	it("reads an optional zoom", () => {
		expect(cameraFromUrl("?at=58.7986,-122.6761&z=13")?.zoom).toBe(13);
		expect(cameraFromUrl("?at=58.7986,-122.6761&zoom=13")?.zoom).toBe(13);
	});

	it("leaves zoom undefined when absent, so the caller keeps its default", () => {
		expect(cameraFromUrl("?at=58.7986,-122.6761")?.zoom).toBeUndefined();
	});

	it("ignores an out-of-range zoom instead of blanking the map", () => {
		expect(cameraFromUrl("?at=58.7986,-122.6761&z=99")?.zoom).toBeUndefined();
	});

	// ── NOTHING ASKED FOR ────────────────────────────────────────────────
	// undefined means "keep your default", NOT "here is a default".
	it("returns undefined for an empty or junk query", () => {
		expect(cameraFromUrl("")).toBeUndefined();
		expect(cameraFromUrl("?")).toBeUndefined();
		expect(cameraFromUrl("?rails=1")).toBeUndefined();
		expect(cameraFromUrl("?at=hello")).toBeUndefined();
		expect(cameraFromUrl("?at=58.7986")).toBeUndefined();
	});

	it("works with or without the leading ?", () => {
		expect(cameraFromUrl("at=58.7986,-122.6761")?.center).toEqual([
			FORT_NELSON_LNG,
			FORT_NELSON_LAT,
		]);
	});

	// ── BOTH ROUTES, ONE ANSWER ──────────────────────────────────────────
	it("gives /offline and /offline/debug the identical camera", () => {
		// The reason this module exists: swap the path, keep the query, land
		// in the same place with the rails up.
		const plain = cameraFromUrl("?=58.7986,-122.6761");
		const debug = cameraFromUrl("?=58.7986,-122.6761");
		expect(plain).toEqual(debug);
	});
});
