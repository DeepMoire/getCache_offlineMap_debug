/** ⚠️ A wrong answer here causes a cellular-data runaway (repeated re-download). areaTilesPresent = loose (any disc key stored); areaCentreCovered = strict (anchor's own centre tile stored). */
import "fake-indexeddb/auto";
import { BLOB_RADIUS_KM, BLOB_ZOOMS } from "../../../contract/roadBlob";
import { BLOB_MIN_Z } from "../../../contract/blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/sveltekit", () => ({ captureMessage: vi.fn() }));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	areaCentreCovered,
	areaTileKeys,
	areaTilesPresent,
	purgeEmptyTiles,
	v4TransformRequest,
	DB_NAME,
	RINGS,
} from "./packDownload";

// Mirrors openDb() in the module under test (store "tiles", version 1).
function putTiles(keys: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains("tiles"))
				req.result.createObjectStore("tiles");
		};
		req.onsuccess = () => {
			const db = req.result;
			const tx = db.transaction("tiles", "readwrite");
			for (const k of keys) tx.objectStore("tiles").put(new ArrayBuffer(8), k);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => {
				db.close();
				reject(tx.error);
			};
		};
		req.onerror = () => reject(req.error);
	});
}

describe("offline cell probes (download-runaway regression)", () => {
	it("empty pile → both probes false (area downloads once)", async () => {
		expect(await areaTilesPresent(-76, 45)).toBe(false);
		expect(await areaCentreCovered(-76, 45)).toBe(false);
	});

	it("its own cell blob stored → present", async () => {
		await putTiles(areaTileKeys(-78, 45));
		expect(await areaTilesPresent(-78, 45)).toBe(true);
		expect(await areaCentreCovered(-78, 45)).toBe(true);
	});

	it("⛔ A MISSING NEIGHBOUR CELL FAILS THE PROBE — partial is not present", async () => {
		const keys = areaTileKeys(-72, 45.0);
		if (keys.length < 2) return;
		await putTiles(keys.slice(0, keys.length - 1));
		expect(await areaTilesPresent(-72, 45.0)).toBe(false);
		expect(await areaCentreCovered(-72, 45.0)).toBe(false);
	});

	it("a far-away area's blob never marks this area present", async () => {
		await putTiles(areaTileKeys(-84, 45));
		expect(await areaTilesPresent(-70, 45)).toBe(false);
		expect(await areaCentreCovered(-70, 45)).toBe(false);
	});

	it("⛔ THE TWO PROBES ALWAYS AGREE — one rule, not two", async () => {
		await putTiles(areaTileKeys(-86, 45));
		for (const [lng, lat] of [
			[-86, 45],
			[-70, 45],
			[-86, 60],
		] as Array<[number, number]>) {
			expect(await areaTilesPresent(lng, lat)).toBe(
				await areaCentreCovered(lng, lat),
			);
		}
	});
});

describe("THE BLOB — one radius, every zoom", () => {
	it("RINGS is ONE radius paired with every zoom — never a hand-written table", () => {
		expect(RINGS.length).toBe(BLOB_ZOOMS.length);
		for (const r of RINGS) expect(r.km).toBe(BLOB_RADIUS_KM);
		expect(RINGS.map((r) => r.z)).toEqual([...BLOB_ZOOMS]);
	});

	it("⛔ ONE RADIUS — every level is the SAME circle", () => {
		// ⚠️ a blob saved only at the detail zoom vanishes when zoomed out — vector tiles only stretch bigger, never smaller.
		expect(new Set(RINGS.map((r) => r.km)).size).toBe(1);
	});

	it("NO GAPS — every level below the deepest exists", () => {
		// missing level = the blob vanishes silently at that zoom, with no console error (overzoom only goes up); z14 is the one legitimate absence, since z13 overzooms to cover it.
		// ⚠️ V5 raised the floor to z8 — not a gap; a floor is the pack's edge (source minzoom), a gap needs stored levels on both sides.
		const zs: number[] = [...BLOB_ZOOMS].sort((a, b) => a - b);
		const deepest = Math.max(...zs);
		const floor = Math.min(...zs);
		const missing: number[] = [];
		for (let z = floor; z < deepest; z++) {
			if (!zs.includes(z) && z !== 14) missing.push(z);
		}
		expect(missing).toEqual([]);
		// the floor must also be declared to the renderer, or MapLibre requests addresses that 404 and blank the map silently.
		expect(floor).toBe(BLOB_MIN_Z);
	});

	it("an anchor's tiles span EVERY zoom the blob declares", () => {
		const keys = areaTileKeys(-76.168, 45.061);
		// keys are pin-addressed `pin/<lng>,<lat>/<z>/<x>/<y>` — a bare `z/x/y` is shared between neighbouring pins and serves one pin's roads to another (measured 50.4 km off); zoom is the 3rd segment.
		const zooms = [...new Set(keys.map((k) => Number(k.split("/")[2])))].sort(
			(a, b) => a - b,
		);
		expect(zooms).toEqual([...BLOB_ZOOMS].sort((a, b) => a - b));
	});

	it("⛔ THE TILE IS AN ADDRESS, NOT A FOOTPRINT — the CELL bounds the data", () => {
		// the old "no tile wider than 4x the blob" rule no longer applies — the blob is addressed at z5 but its contents are remapped into the cell's frame; asserting the old rule would now be wrong.
		const keys = areaTileKeys(-76.168, 45.061);
		expect(keys.length).toBeGreaterThanOrEqual(1);
		expect(keys.length).toBeLessThanOrEqual(25);
		// Every key is PIN-ADDRESSED and stored under the single blob zoom.
		for (const k of keys) {
			expect(k.startsWith("pin/")).toBe(true);
			expect(k.split("/")[2]).toBe(String(BLOB_ZOOMS[0]));
		}
		// And they are distinct — a duplicate would mean two cells sharing storage.
		expect(new Set(keys).size).toBe(keys.length);
	});

	// ⚠️ the Worker packs from its own copy of this spec (cannot import the app's) — a drift means the phone probes for tiles the Worker never packed, causing permanent re-downloads or coverage holes.
	it("the Worker's spec matches the client's, exactly", () => {
		// a mismatch here means the phone asks for a tile the Worker never wrote — a blank map with no error.
		// BLOB_ZOOMS is derived from BLOB_TILE_Z — read that constant directly, since it decides the address and the cell size.
		const zoomLine = /BLOB_TILE_Z = (\d+)/.exec(
			readFileSync(
				fileURLToPath(
					// climbs out of rapper into ReTreever — the Worker it must agree with lives in ReTreever/workers/.
				new URL(
					"../../../../../ReTreever/workers/offline-tiles/src/grid.ts",
					import.meta.url,
				),
				),
				"utf8",
			),
		)?.[1] ?? "";
		// ⚠️ drop empty tokens after split — a trailing comma yields Number("") === 0, silently adding a phantom zoom 0.
		const workerZooms = zoomLine
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0)
			.map(Number);
		expect(workerZooms).toEqual([...BLOB_ZOOMS]);
	});
});

// ⚠️ a 0-byte tile must never be persisted — Mapbox's worker throws parsing it on every render pass, forever.
describe("zero-byte tiles — the write boundary", () => {
	/** Raw store contents, bypassing the module's own read-side filter. */
	function rawEntries(dbName: string): Promise<Array<[string, number]>> {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(dbName, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains("tiles"))
					req.result.createObjectStore("tiles");
			};
			req.onsuccess = () => {
				const db = req.result;
				const tx = db.transaction("tiles", "readonly");
				const store = tx.objectStore("tiles");
				const ks = store.getAllKeys();
				const vs = store.getAll();
				tx.oncomplete = () => {
					db.close();
					resolve(
						(ks.result as string[]).map((k, i) => [
							k,
							(vs.result[i] as ArrayBuffer).byteLength,
						]),
					);
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			};
			req.onerror = () => reject(req.error);
		});
	}

	function putRaw(entries: Array<[string, number]>): Promise<void> {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains("tiles"))
					req.result.createObjectStore("tiles");
			};
			req.onsuccess = () => {
				const db = req.result;
				const tx = db.transaction("tiles", "readwrite");
				for (const [k, n] of entries)
					tx.objectStore("tiles").put(new ArrayBuffer(n), k);
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			};
			req.onerror = () => reject(req.error);
		});
	}

	it("purgeEmptyTiles deletes every 0-byte tile and keeps every real one", async () => {
		await putRaw([
			["15/900/1400", 128],
			["15/900/1401", 0], // landmine
			["15/900/1402", 64],
			["15/900/1403", 0], // landmine
		]);
		const removed = await purgeEmptyTiles();
		expect(removed).toBe(2);
		const after = await rawEntries(DB_NAME);
		// NOTHING zero-byte survives, anywhere in the store.
		expect(after.every(([, n]) => n > 0)).toBe(true);
		// other specs share this DB — assert on this test's keys, not the whole store.
		const mine = after.filter(([k]) => k.startsWith("15/900/")).map(([k]) => k);
		expect(mine.sort()).toEqual(["15/900/1400", "15/900/1402"]);
	});

	it("is idempotent — a clean pile loses nothing on a second sweep", async () => {
		const before = await rawEntries(DB_NAME);
		expect(await purgeEmptyTiles()).toBe(0);
		expect(await rawEntries(DB_NAME)).toEqual(before);
	});
});

// ⚠️ a blocked request must never change resource type — a blank PNG is a valid answer only to something that decodes an image, else Mapbox throws "Unimplemented type: 4".
describe("v4TransformRequest — blocked requests keep their resource type", () => {
	// stubs `location` (absent in node) so tests exercise the same branch the browser does.
	const ORIGIN = "http://localhost:5173";
	beforeAll(() => {
		(globalThis as unknown as { location: unknown }).location = {
			origin: ORIGIN,
			href: `${ORIGIN}/mobile/offlinev4`,
			protocol: "http:",
			host: "localhost:5173",
		};
	});
	afterAll(() => {
		(globalThis as unknown as { location?: unknown }).location = undefined;
	});

	it("blocks a foreign GLYPH with nothing — never a PNG", () => {
		const r = v4TransformRequest("https://api.mapbox.com/fonts/v1/x/0-255.pbf", "Glyphs");
		expect(r.url).toBe("");
		expect(r.url).not.toContain("data:image/png");
	});

	it("blocks foreign style/sprite JSON with nothing — never a PNG", () => {
		for (const kind of ["Style", "Source", "SpriteJSON"]) {
			const r = v4TransformRequest("https://api.mapbox.com/whatever.json", kind);
			expect(r.url).toBe("");
		}
	});

	it("still answers a blocked IMAGE with the blank PNG", () => {
		for (const kind of ["Image", "SpriteImage", "Tile"]) {
			const r = v4TransformRequest("https://tiles.example.com/1.png", kind);
			expect(r.url).toContain("data:image/png");
		}
	});

	it("passes an ABSOLUTE same-origin glyph URL through untouched", () => {
		const local = `${ORIGIN}/mobileAssets/worldBase/glyphs/Noto%20Sans%20Regular/0-255.pbf`;
		expect(v4TransformRequest(local, "Glyphs").url).toBe(local);
	});

	it("ABSOLUTISES a root-relative local URL — the blob-worker trap", () => {
		// ⚠️ a root-relative URL must be absolutised — Mapbox's worker runs from a `blob:` URL with no origin to resolve against, so it fails silently; do not revert to asserting `toBe(rel)`.
		const rel = "/mobileAssets/worldBase/glyphs/Noto%20Sans%20Regular/0-255.pbf";
		expect(v4TransformRequest(rel, "Glyphs").url).toBe(`${ORIGIN}${rel}`);
	});

	it("treats other on-device origin FORMS as local, not foreign", () => {
		// A false negative here is what swapped a good font for a PNG.
		const sameHost = `http://localhost:5173/mobileAssets/worldBase/glyphs/A/0-255.pbf`;
		expect(v4TransformRequest(sameHost, "Glyphs").url).toBe(sameHost);
		const cap = "capacitor://localhost/mobileAssets/worldBase/glyphs/A/0-255.pbf";
		expect(v4TransformRequest(cap, "Glyphs").url).toBe(cap);
	});
});
