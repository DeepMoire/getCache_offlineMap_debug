/**
 * ⚠️ a wrong answer here causes a cellular-data runaway — the reconcile re-fetches every pass, forever.
 * areaTilesPresent: true if ANY of the disc's keys is stored (loose, survival check).
 * areaCentreCovered: true only when the anchor's own centre-tile patch is stored (strict, adoption check).
 */
import "fake-indexeddb/auto";
import { BLOB_RADIUS_KM, BLOB_ZOOMS } from "../../../contract/roadBlob";
import { BLOB_MIN_Z } from "../../../contract/blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// downloadGuard pulls in Sentry — mocked here so tests don't hit the real SDK.
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

// each test uses its own centre, ≥2° apart, so 25 km outer rings never overlap and no state leaks between tests
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
		// ⛔ partial storage must read as absent — a loose "any tile present" vote let areas falsely claim full coverage and go permanently stale.
		const keys = areaTileKeys(-72, 45.0);
		// only meaningful when the anchor needs a neighbour — skip if it sits mid-cell (nothing partial to test)
		if (keys.length < 2) return;
		await putTiles(keys.slice(0, keys.length - 1));
		expect(await areaTilesPresent(-72, 45.0)).toBe(false);
		expect(await areaCentreCovered(-72, 45.0)).toBe(false);
	});

	it("a far-away area's blob never marks this area present", async () => {
		// cells are disjoint by construction — a distant area's blob can never be mistaken for this one's
		await putTiles(areaTileKeys(-84, 45));
		expect(await areaTilesPresent(-70, 45)).toBe(false);
		expect(await areaCentreCovered(-70, 45)).toBe(false);
	});

	it("⛔ THE TWO PROBES ALWAYS AGREE — one rule, not two", async () => {
		// a cell blob is not shared and not partial — there is one question and one answer (the two probes must always agree)
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

// concentric-ring model: z15 inner + z12 outer disc, not one monolithic z14 disc.
// client RINGS max is 40 km (superset of areaTileKeys); Worker base RINGS is 25 km, grown to 40 km per-pack by the roads budget — see the lockstep test below.
describe("THE BLOB — one radius, every zoom", () => {
	it("RINGS is ONE radius paired with every zoom — never a hand-written table", () => {
		// ⚠️ RINGS must stay a projection of the spec, not a hand-maintained table — it drifted before (stale 40 km vs 25 km entries).
		expect(RINGS.length).toBe(BLOB_ZOOMS.length);
		for (const r of RINGS) expect(r.km).toBe(BLOB_RADIUS_KM);
		expect(RINGS.map((r) => r.z)).toEqual([...BLOB_ZOOMS]);
	});

	it("⛔ ONE RADIUS — every level is the SAME circle", () => {
		// ⛔ every zoom level must share ONE radius — a second radius is a second visible edge (shipped 3x with a different shallow radius, rejected each time).
		expect(new Set(RINGS.map((r) => r.km)).size).toBe(1);
	});

	it("NO GAPS — every level below the deepest exists", () => {
		// ⚠️ every level below the deepest must exist or the blob silently vanishes at that zoom (overzoom only goes up); z14 is the one exception — z13 overzooms to cover it, free.
		// ⚠️ a FLOOR (source minzoom) is not a gap — a gap has stored levels on both sides; below the floor the renderer is told nothing exists, so there's no cliff.
		const zs: number[] = [...BLOB_ZOOMS].sort((a, b) => a - b);
		const deepest = Math.max(...zs);
		const floor = Math.min(...zs);
		const missing: number[] = [];
		for (let z = floor; z < deepest; z++) {
			if (!zs.includes(z) && z !== 14) missing.push(z);
		}
		expect(missing).toEqual([]);
		// the floor must also be declared to the renderer, or MapLibre requests addresses that 404 and blanks the map with no error
		expect(floor).toBe(BLOB_MIN_Z);
	});

	it("an anchor's tiles span EVERY zoom the blob declares", () => {
		const keys = areaTileKeys(-76.168, 45.061);
		// ⚠️ keys are PIN-ADDRESSED (pin/<lng>,<lat>/<z>/<x>/<y>) — a bare z/x/y is shared between neighbouring pins and served one pin's roads to another (measured 50.4 km off); zoom is the 3rd segment, not the 1st.
		const zooms = [...new Set(keys.map((k) => Number(k.split("/")[2])))].sort(
			(a, b) => a - b,
		);
		expect(zooms).toEqual([...BLOB_ZOOMS].sort((a, b) => a - b));
	});

	it("⛔ THE TILE IS AN ADDRESS, NOT A FOOTPRINT — the CELL bounds the data", () => {
		// ⛔ the tile number only sets the shallowest visible zoom — it does not bound how much ground is in the tile (contents are remapped into the cell's frame). What must hold: one area maps to a SMALL, BOUNDED set of keys, or it's the download-storm bug again.
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

	// ⚠️ LOCKSTEP: the Worker packs from its own copy of this spec — a drift means the phone probes for tiles the Worker never packed (permanent re-downloads or coverage holes).
	it("the Worker's spec matches the client's, exactly", () => {
		// radius/shape are compared byte-for-byte by OFFLINEV5/grid.lockstep.test.ts; this checks the ZOOM only — a mismatch means the phone asks for a tile the Worker never wrote, a blank map with no error.
		// BLOB_ZOOMS is derived from BLOB_TILE_Z — read that constant, it's what actually decides the address.
		const zoomLine = /BLOB_TILE_Z = (\d+)/.exec(
			readFileSync(
				fileURLToPath(
				// climbs out of rapper into ReTreever — the engine is vendored into rapper, but the Worker it must agree with lives in ReTreever/workers/
				new URL(
					"../../../../../ReTreever/workers/offline-tiles/src/grid.ts",
					import.meta.url,
				),
				),
				"utf8",
			),
		)?.[1] ?? "";
		// ⚠️ split on commas and drop empties — a trailing comma yields Number("")===0, a phantom zoom 0 that would fail this test for the wrong reason.
		const workerZooms = zoomLine
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0)
			.map(Number);
		expect(workerZooms).toEqual([...BLOB_ZOOMS]);
	});
});

// ⚠️ a 0-byte tile must never be persisted — root cause of the "Unimplemented type: 4" storm (Mapbox threw parsing it, every render pass, forever); guarded by the WRITE guard and healed by PURGE.
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
		// other specs share this DB — assert on THIS test's keys, not the whole store, or it flakes
		const mine = after.filter(([k]) => k.startsWith("15/900/")).map(([k]) => k);
		expect(mine.sort()).toEqual(["15/900/1400", "15/900/1402"]);
	});

	it("is idempotent — a clean pile loses nothing on a second sweep", async () => {
		const before = await rawEntries(DB_NAME);
		expect(await purgeEmptyTiles()).toBe(0);
		expect(await rawEntries(DB_NAME)).toEqual(before);
	});
});

// ⛔ a blank PNG is a valid answer ONLY to something that decodes an image — substituting it for a blocked GLYPH/JSON request threw "Unimplemented type: 4" on every render pass, forever.
describe("v4TransformRequest — blocked requests keep their resource type", () => {
	// the guard reads location, which node lacks — stub the real dev origin so tests exercise the same branch as the browser
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
		// ⛔ a root-relative URL must be absolutised, not passed through — Mapbox's worker location is a blob: URL with no origin to resolve against, so it fails far from its cause. Do not "restore" the old assertion (toBe(rel)).
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
