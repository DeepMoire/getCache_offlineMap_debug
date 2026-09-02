/** ⚠️ If a test here fails, the failure IS the point — don't loosen the test, fix the service. */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Seedable in-memory disk + mutable budget shared by the mock factories and assertions (satStore/tiles/cov/budget).
const h = vi.hoisted(() => {
	const satStore = new Map<string, number>();
	const tiles = new Set<string>();
	const cov = new Map<string, Record<string, unknown>>();
	const budget = { bytes: 1_000_000_000 };
	const key = (lng: number, lat: number) =>
		`${lng.toFixed(4)},${lat.toFixed(4)}`;
	return {
		satStore,
		tiles,
		cov,
		budget,
		key,
		// downloadV4Area = the roads fetch. Records that this area's tiles are now present.
		downloadV4Area: vi.fn(async (lng: number, lat: number) => {
			tiles.add(key(lng, lat));
			return { bytes: 1000, downloaded: 5 };
		}),
		// bakeSatelliteImage = the photo bake. Writes the photo to disk.
		bakeSatelliteImage: vi.fn(async (c: [number, number]) => {
			satStore.set(key(c[0], c[1]), 1000);
			return { blob: { size: 1000 }, bounds: [0, 0, 1, 1], bakeVersion: 3 };
		}),
		deleteSatImage: vi.fn(async (k: string) => void satStore.delete(k)),
		deleteVectorAt: vi.fn(async () => undefined),
		deleteFireCache: vi.fn(async () => undefined),
		// gps() defaults to null (location off/unknown) — tripwires assume feature-anchored behavior only.
		getLiveFix: vi.fn(async (): Promise<[number, number] | null> => null),
		// The fire fetch, reached through the PORT rather than a module mock.
		fetchAreaFires: vi.fn(async (_lng: number, _lat: number) => ({
			hotspots: [] as [],
			fetchedAt: 0,
			sourcesOk: 3,
			bytes: 0,
		})),
		// Arrival debt: real code uses a consume-once Set (per reader); here a single boolean since there's only one reader in tests.
		fireArrivalOwed: true,
		// fireRead spy — tripwire 5 throws it to prove a broken fire DB degrades only the overlay, never the pass.
		fireRead: vi.fn(async (_key: string) => null as FireRecord | null),
	};
});

let features: Array<{
	geometry: { geometry: { type: string } } | null;
	overlayBounds: null;
	lastTouched: string;
	anchors: [number, number][];
}> = [];
// The engine reaches only the HOST PORT (testPorts below), never mapStore/anchors/liveFix directly — a fake port would make every tripwire here bake nothing and fail.

vi.mock("../../worker/worker-local-dev/roads/packDownload", () => ({
	downloadV4Area: h.downloadV4Area,
	areaCentreCovered: vi.fn(async (lng: number, lat: number) =>
		h.tiles.has(h.key(lng, lat)),
	),
	areaTilesPresent: vi.fn(async (lng: number, lat: number) =>
		h.tiles.has(h.key(lng, lat)),
	),
	// getAllTileKeys snapshots tiles; areaTilesPresentIn reads live tiles (reflects same-pass downloads) — same semantics as the per-area probe, no per-area I/O.
	getAllTileKeys: vi.fn(async () => new Set(h.tiles)),
	areaTilesPresentIn: (_stored: Set<string>, lng: number, lat: number) =>
		h.tiles.has(h.key(lng, lat)),
	PACK_FORMAT_VERSION: 6,
	// MUST mirror the real outer ring (40 km) — a smaller mock would silently hide a containment/thrash regression.
	RINGS: [
		{ km: 3, z: 15 },
		{ km: 40, z: 12 },
	],
}));

vi.mock("../store/tombstones/purgeRoadRasters", () => ({
	// One-shot IndexedDB drop of the deleted road raster's leftover PNGs — stubbed (no indexedDB in the node test env).
	purgeDeadRoadRasters: vi.fn(() => undefined),
}));

vi.mock("../offlineDownloadGate", () => ({
	checkDownloadGate: vi.fn(async () => false),
	isPerFeatureOnly: () => false,
	noteDownloadedBytes: () => undefined,
}));

// No fireCache mock — fire storage goes through the port too; stubs live in testPorts below (same door production uses).


vi.mock("../satellite/satelliteImage", () => ({
	bakeSatelliteImage: h.bakeSatelliteImage,
	getSatImageByKey: vi.fn(async (k: string) =>
		h.satStore.has(k)
			? {
					blob: { size: h.satStore.get(k) },
					bounds: [0, 0, 1, 1],
					bakeVersion: 3,
				}
			: undefined,
	),
	satImageKey: (c: [number, number]) => h.key(c[0], c[1]),
	BAKE_RADIUS_KM: 3,
	BAKE_VERSION: 3,
	deleteSatImage: h.deleteSatImage,
	getSatKeys: vi.fn(async () => [...h.satStore.keys()]),
	getAllSatImages: vi.fn(async () =>
		[...h.satStore.entries()].map(([key, size]) => ({
			key,
			img: { blob: { size }, bounds: [0, 0, 1, 1], bakeVersion: 3 },
		})),
	),
	// METADATA ONLY — deliberately omits blob so a future pixel-reaching caller fails loudly instead of silently reintroducing the 613 MB allocation.
	satImageMeta: vi.fn(async () =>
		[...h.satStore.entries()].map(([key, bytes]) => ({
			key,
			bytes,
			bakeVersion: 3,
		})),
	),
}));

vi.mock("../store/tombstones/legacyVectorCleanup", () => ({
	deleteVectorAt: h.deleteVectorAt,
	getVectorKeys: vi.fn(async () => []),
	getVectorFeaturesAt: vi.fn(async () => []),
}));

vi.mock("../store/coverageRegistry", () => ({
	allCoverage: async () => [...h.cov.values()],
	noteCoverage: async (
		areaKey: string,
		lng: number,
		lat: number,
		patch: Record<string, unknown>,
		_touch?: boolean,
		touchAt?: number,
	) => {
		const prev = h.cov.get(areaKey) ?? {};
		h.cov.set(areaKey, {
			...prev,
			areaKey,
			lng,
			lat,
			...patch,
			lastTouched: touchAt ?? prev.lastTouched ?? 0,
		});
	},
	dropCoverage: async (k: string) => void h.cov.delete(k),
	get OFFLINE_BUDGET_BYTES() {
		return h.budget.bytes;
	},
	EST_AREA_BYTES: 1000,
}));

import type {
	FireRecord,
	HostPorts,
} from "../../shared/hostPorts";
import { configureTilesHost } from "../../worker/worker-local-dev/tilesHost";
import { reconcileOnceForTest } from "./bakeService.svelte";

const testPorts: HostPorts = {
	places: () =>
		features.map((f) => ({
			anchors: f.anchors ?? [],
			lastTouched: f.lastTouched,
			corridor:
				f.geometry?.geometry?.type === "LineString" ||
				f.geometry?.geometry?.type === "MultiLineString",
		})),
	// ready() always true here (features set synchronously); distinct from "has places" — tripwire 4 needs eviction with zero features.
	ready: () => true,
	onPlacesChanged: () => () => {},
	fires: {
		fetchArea: (lng, lat) => h.fetchAreaFires(lng, lat),
		arrival: () => {
			h.fireArrivalOwed = true;
		},
		takeArrival: () => {
			const owed = h.fireArrivalOwed;
			h.fireArrivalOwed = false;
			return owed;
		},
		// Fire store stub (IndexedDB-backed in the real host) — empty + never-fresh, the default every fire tripwire below asserts against.
		read: (key: string) => h.fireRead(key),
		write: async () => undefined,
		delete: h.deleteFireCache,
		isFresh: () => false,
		coverage: async () => [],
		isCoverageFresh: () => false,
	},
	// gps() defaults to null (location off/unknown) — tripwires assume feature-anchored behavior only; tests opt in to a fix.
	gps: () => h.getLiveFix(),
};

const point = (anchor: [number, number]) => ({
	geometry: { geometry: { type: "Point" } },
	overlayBounds: null as null,
	lastTouched: "2026-06-17T12:00:00Z",
	anchors: [anchor],
});
/** Point feature with an explicit last-touched ISO, for ordering pins by recency like the conveyor does. */
const pointAt = (anchor: [number, number], iso: string) => ({
	geometry: { geometry: { type: "Point" } },
	overlayBounds: null as null,
	lastTouched: iso,
	anchors: [anchor],
});
const line = (anchor: [number, number]) => ({
	geometry: { geometry: { type: "LineString" } },
	overlayBounds: null as null,
	lastTouched: "2026-06-17T12:00:00Z",
	anchors: [anchor],
});
/** Seed an ORPHAN blob (on disk, no live feature points at it). */
function seedOrphan(lng: number, lat: number, lastTouched: number): void {
	const k = h.key(lng, lat);
	h.satStore.set(k, 1000);
	h.cov.set(k, {
		areaKey: k,
		lng,
		lat,
		bytes: 1000,
		hasPhoto: true,
		lastTouched,
	});
}

beforeEach(() => {
	// configureTilesHost needed or fire tripwires throw "no tiles host configured"; uses a FIXTURE origin only — never a real one (see noParentNames.test.ts).
	configureTilesHost("https://tiles.example.test");
	h.satStore.clear();
	h.tiles.clear();
	h.cov.clear();
	h.budget.bytes = 1_000_000_000;
	features = [];
	h.downloadV4Area.mockClear();
	h.bakeSatelliteImage.mockClear();
	h.deleteSatImage.mockClear();
	h.deleteVectorAt.mockClear();
	h.getLiveFix.mockClear();
	h.getLiveFix.mockResolvedValue(null); // default: location off / unknown
});

describe("offline tripwire 1 — bakes headlessly the moment a feature is touched", () => {
	it("a point feature → downloads tiles AND bakes a satellite for its anchor, with NO map", async () => {
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).toHaveBeenCalledWith(10, 20, undefined, false);
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([10, 20]);
	});

	it("a LINE feature → corridor (roads-only ribbon, NO satellite for the line anchor)", async () => {
		features = [line([30, 40])];
		await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).toHaveBeenCalledWith(30, 40, undefined, true);
		expect(h.bakeSatelliteImage).not.toHaveBeenCalledWith([30, 40]);
	});
});

describe("offline tripwire 2 — a photo alone is NOT complete; roads are always fetched", () => {
	it("satellite present but tiles MISSING → STILL downloads the roads (never 'done' on the photo)", async () => {
		// Regression guard: pin has photo but no roads must never be marked complete.
		h.satStore.set(h.key(50, 60), 1000); // photo on disk
		// tiles NOT present for (50,60)
		features = [point([50, 60])];
		await reconcileOnceForTest(testPorts);
		// It MUST go get the roads despite the photo already being there.
		expect(h.downloadV4Area).toHaveBeenCalledWith(50, 60, undefined, false);
	});

	it("BOTH present → zero work (no re-download, no re-probe churn)", async () => {
		h.satStore.set(h.key(50, 60), 1000); // photo
		h.tiles.add(h.key(50, 60)); // roads
		features = [point([50, 60])];
		await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).not.toHaveBeenCalledWith(50, 60, undefined, false);
	});
});

describe("offline ledger — the end-of-pass mirror must not zero what the pass just wrote", () => {
	// The "2 tiles / —" regression (2026-09-01): covByKey is a PASS-START snapshot, so an area
	// downloaded DURING the pass is invisible to the mirror (rec === undefined) and it rewrote
	// the download's freshly-written lineBytes with an explicit 0. The mirror must re-read the
	// registry AFTER the download loop and carry the real numbers.
	it("an area downloaded DURING a pass keeps its lineBytes/lineCount", async () => {
		features = [point([70, 80])];
		await reconcileOnceForTest(testPorts);
		const rec = h.cov.get(h.key(70, 80));
		// the download wrote lineBytes 1000 / lineCount 5 — the mirror must not flatten them to 0
		expect(rec?.lineBytes).toBe(1000);
		expect(rec?.lineCount).toBe(5);
	});

	it("a photo baked DURING a pass keeps its photoBytes", async () => {
		features = [point([71, 81])];
		await reconcileOnceForTest(testPorts);
		expect(h.cov.get(h.key(71, 81))?.photoBytes).toBe(1000);
	});
});

describe("offline tripwire — ONE pass has a TIME BUDGET", () => {
	// A pass MUST stop cleanly after its time slice (not download everything) — an unbudgeted pass measured 81s of continuous work and starved GC/idle.
	/** ⚠️ Must restore the mockImplementation by hand — mockClear() resets calls but not the implementation, so leaving it would silently break later tests. */
	async function passWithSlowDownloads(msPerArea: number): Promise<number> {
		let clock = 0;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
		h.downloadV4Area.mockImplementation(async (lng: number, lat: number) => {
			clock += msPerArea;
			h.tiles.add(h.key(lng, lat)); // same effect as the default mock
			return { bytes: 1000, downloaded: 5 };
		});
		try {
			await reconcileOnceForTest(testPorts);
			return h.downloadV4Area.mock.calls.length;
		} finally {
			nowSpy.mockRestore();
			h.downloadV4Area.mockImplementation(
				async (lng: number, lat: number) => {
					h.tiles.add(h.key(lng, lat));
					return { bytes: 1000, downloaded: 5 };
				},
			);
		}
	}

	it("stops early instead of walking every area when the slice is used up", async () => {
		// 12 areas × 2s each — an unbudgeted pass would do all 12; a budgeted one stops once the 5s slice is gone.
		features = Array.from({ length: 12 }, (_, i) => point([100 + i, 60]));
		const n = await passWithSlowDownloads(2000);
		expect(n).toBeGreaterThan(0); // a pass ALWAYS makes progress…
		expect(n).toBeLessThan(12); // …but never grinds through everything
	});

	it("ALWAYS lands at least one area, however slow the device", async () => {
		// The budget must never starve progress — even a download that blows the whole slice still completes its first area.
		features = [point([200, 60]), point([201, 60])];
		const n = await passWithSlowDownloads(60_000); // 12× the budget, in one area
		expect(n).toBe(1);
	});
});

describe("offline tripwire 3 — under budget, NOTHING is ever evicted", () => {
	it("an orphan blob (no live feature) survives every pass while under the 1 GB budget", async () => {
		// Regression (578→206 swing bug): orphans must persist forever under budget, never deleted on sight.
		seedOrphan(99, 99, 1);
		features = []; // nothing references the orphan
		await reconcileOnceForTest(testPorts);
		expect(h.deleteSatImage).not.toHaveBeenCalled();
		expect(h.satStore.has(h.key(99, 99))).toBe(true);
	});
});

describe("offline tripwire 3b — a kept pin gets BOTH halves; roads top up a photo-only pin", () => {
	it("within budget, a pin with a photo but no roads STILL downloads its roads", async () => {
		// default budget is huge — the pin is a keeper, so it must be COMPLETE.
		h.satStore.set(h.key(70, 80), 1000); // photo present, no tiles
		features = [point([70, 80])];
		await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).toHaveBeenCalledWith(70, 80, undefined, false);
	});
});

describe("offline tripwire 3c — a NEW pin gets its satellite even at the cap (displaces oldest)", () => {
	it("disk full of OLDER photos → the newest pin still bakes its photo; an old one is evicted", async () => {
		// Regression (stuck-at-1GB bug): the conveyor must rank by touch (newest wins) — measuring total disk bytes blocked every new pin's photo.
		h.budget.bytes = 2000; // demo(1000) + ONE more pin fits; the rest evict
		// Two OLDER pins already have their photos on disk (disk is "full").
		h.satStore.set(h.key(10, 10), 1000);
		h.tiles.add(h.key(10, 10));
		h.satStore.set(h.key(11, 11), 1000);
		h.tiles.add(h.key(11, 11));
		features = [
			pointAt([20, 20], "2026-06-18T12:00:00Z"), // NEWEST — has NO photo yet
			pointAt([10, 10], "2026-06-01T12:00:00Z"), // older
			pointAt([11, 11], "2026-05-01T12:00:00Z"), // oldest
		];
		await reconcileOnceForTest(testPorts);
		// The new pin MUST bake its satellite despite the disk already being at the cap.
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([20, 20]);
		// …and an OLD pin's photo is evicted to make room (oldest first).
		expect(h.deleteSatImage).toHaveBeenCalledWith(h.key(11, 11));
	});
});

describe("offline tripwire 4 — over budget, oldest falls off, newest survives", () => {
	it("the milk-shelf conveyor: only the oldest-touched blob is dropped", async () => {
		// Budget holds the demo (always baked) + the newest orphan, but not the oldest.
		h.budget.bytes = 2500; // demo(1000) + new(1000) = 2000 ≤ 2500 < +old(1000)=3000
		seedOrphan(11, 11, 1); // OLDEST (lastTouched 1)
		seedOrphan(22, 22, 100); // NEWEST (lastTouched 100)
		features = [];
		await reconcileOnceForTest(testPorts);
		// Oldest evicted, newest kept.
		expect(h.deleteSatImage).toHaveBeenCalledWith(h.key(11, 11));
		expect(h.deleteSatImage).not.toHaveBeenCalledWith(h.key(22, 22));
		expect(h.satStore.has(h.key(22, 22))).toBe(true);
	});

	it("a blob is ONE unit — eviction drops the photo AND the roads together (same areaKey)", async () => {
		// "last touched" is one clock per area — satellite + roads share it and evict as a pair, never one without the other.
		h.budget.bytes = 2500; // demo(1000) + new(1000) keep; old(1000) over
		seedOrphan(11, 11, 1); // OLDEST — gets evicted
		seedOrphan(22, 22, 100); // newest — survives
		features = [];
		await reconcileOnceForTest(testPorts);
		// The SAME areaKey is removed from BOTH stores — photo and vectors together.
		expect(h.deleteSatImage).toHaveBeenCalledWith(h.key(11, 11));
		expect(h.deleteVectorAt).toHaveBeenCalledWith(h.key(11, 11));
	});

	it("fires ride along on eviction — an evicted area sheds its hotspots too", async () => {
		h.budget.bytes = 2500;
		seedOrphan(11, 11, 1); // OLDEST — gets evicted
		seedOrphan(22, 22, 100);
		features = [];
		await reconcileOnceForTest(testPorts);
		// Otherwise hotspots orphan in rt-fire-cache with no coverage record pointing at them — invisible, un-evictable, growing forever.
		expect(h.deleteFireCache).toHaveBeenCalledWith(h.key(11, 11));
	});
});

describe("offline tripwire 6 — an active user with location gets covered, feature or not", () => {
	it("a user standing NOWHERE NEAR a feature bakes a blob at their position", async () => {
		// The point of the feature: a user with no features still gets a blob at their live position — the one screen that must work without signal.
		h.getLiveFix.mockResolvedValue([100, 60]);
		await reconcileOnceForTest(testPorts);
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([100, 60]);
	});

	// Demo blob (MAP_HOME_CENTER) bakes every pass by design — assertions name a coordinate rather than count calls, or they'd accidentally assert on the demo.
	const bakedAt = (c: [number, number]): boolean =>
		h.bakeSatelliteImage.mock.calls.some(
			([arg]) => arg[0] === c[0] && arg[1] === c[1],
		);

	it("does NOT bake anything extra when location is off", async () => {
		// Permission is never assumed/requested — no fix means feature anchors only.
		h.getLiveFix.mockResolvedValue(null);
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts);
		expect(bakedAt([10, 20])).toBe(true);
		// Nothing anchored anywhere near the pin but the pin itself.
		const nearPin = h.bakeSatelliteImage.mock.calls.filter(
			([arg]) => Math.abs(arg[1] - 20) < 1 && Math.abs(arg[0] - 10) < 1,
		);
		expect(nearPin).toHaveLength(1);
	});

	it("does NOT re-bake for a user standing beside their own pin", async () => {
		// The 11m thrash: satImageKey rounds to 4 decimals, so a raw live fix would mint a new area every few paces unless containment sees the feature's own coverage.
		features = [point([10, 20])];
		h.getLiveFix.mockResolvedValue([10.0001, 20.0001]); // ~11 m away
		await reconcileOnceForTest(testPorts);
		expect(bakedAt([10, 20])).toBe(true);
		expect(bakedAt([10.0001, 20.0001])).toBe(false);
	});

	it("does not re-bake while pacing a block all day", async () => {
		// ~1km of wandering inside the 40km blob — every position is a distinct satImageKey; none may produce a download.
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts); // the pin's own blob lands first
		for (const dLat of [0.001, 0.003, 0.006, 0.009]) {
			h.bakeSatelliteImage.mockClear();
			h.getLiveFix.mockResolvedValue([10, 20 + dLat]);
			await reconcileOnceForTest(testPorts);
			expect(bakedAt([10, 20 + dLat])).toBe(false);
		}
	});

	it("DOES bake once the user leaves coverage", async () => {
		// Past MAP_TRIGGER_KM (1.5km photo radius, not the road ring) — leaving coverage earns exactly one new blob.
		features = [point([10, 20])];
		h.getLiveFix.mockResolvedValue([10, 20.5]); // ~55 km north
		await reconcileOnceForTest(testPorts);
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([10, 20.5]);
	});

	it("fetches fires at the SNAPPED position, never the raw fix", async () => {
		// Regression: liveFix must be SNAPPED before the fire pass — raw fix would mint a new fire record every few paces (same 11m round as the map blob).
		h.fetchAreaFires.mockClear();
	h.fireRead.mockClear();
	h.fireRead.mockResolvedValue(null);
		h.getLiveFix.mockResolvedValue([-123.0694, 49.2643]);
		await reconcileOnceForTest(testPorts);
		const rawCall = vi
			.mocked(h.fetchAreaFires)
			.mock.calls.some(([lng, lat]) => lng === -123.0694 && lat === 49.2643);
		expect(rawCall).toBe(false);
		expect(h.fetchAreaFires).toHaveBeenCalledWith(-123, 49.25);
	});

	it("a failing geolocation read never aborts the pass", async () => {
		// The live anchor is a BONUS — a geolocation throw must not starve the user's actual features.
		h.getLiveFix.mockRejectedValueOnce(new Error("geolocation exploded"));
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts);
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([10, 20]);
	});
});

describe("offline tripwire 7 — fires are PERISHABLE and must keep refreshing", () => {
	it("refreshes fires for an area whose photo and tiles are ALREADY on disk", async () => {
		// Regression: fires must refresh even when photo+tiles are complete — fireTask used to live inside the completion-gated ensureAreaData and never re-ran.
		h.fetchAreaFires.mockClear();
	h.fireRead.mockClear();
	h.fireRead.mockResolvedValue(null);
		// Area is COMPLETE on disk: photo + tiles both present.
		h.satStore.set(h.key(10, 20), 1000);
		h.tiles.add(h.key(10, 20));
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts);
		// Nothing to download for THIS area's map data (the demo blob still bakes).
		const rebakedPin = h.bakeSatelliteImage.mock.calls.some(
			([arg]) => arg[0] === 10 && arg[1] === 20,
		);
		expect(rebakedPin).toBe(false);
		// ...but the fires MUST still refresh.
		expect(h.fetchAreaFires).toHaveBeenCalledWith(10, 20);
	});
});

describe("offline tripwire 5 — the fire layer can never break the map", () => {
	it("a THROWING fire cache does not abort the area (satellite + tiles still run)", async () => {
		// Regression: a corrupt fire DB (readFireCache throwing) must degrade the overlay only — it used to kill the whole pass silently.
		h.fireRead.mockRejectedValueOnce(
			new ReferenceError("indexedDB is not defined"),
		);
		h.budget.bytes = 2500;
		seedOrphan(11, 11, 1);
		features = [pointAt([20, 20], "2026-06-18T12:00:00Z")];
		await reconcileOnceForTest(testPorts);
		// The area's OTHER work completed despite the fire failure.
		expect(h.bakeSatelliteImage).toHaveBeenCalledWith([20, 20]);
		expect(h.deleteSatImage).toHaveBeenCalledWith(h.key(11, 11));
	});
});

// A completed area must never be re-downloaded — regression: the MIRROR step derived hasLines from the empty legacy getVectorKeys(), causing endless re-download until the circuit breaker tripped.
describe("offline tripwire — a completed area is NEVER re-downloaded", () => {
	it("second pass does NOT re-download an area whose tiles are already on disk", async () => {
		features = [point([10, 20])];
		await reconcileOnceForTest(testPorts); // pass 1 — legitimately downloads
		expect(h.downloadV4Area).toHaveBeenCalledWith(10, 20, undefined, false);

		h.downloadV4Area.mockClear();
		await reconcileOnceForTest(testPorts); // pass 2 — must be a no-op
		expect(h.downloadV4Area).not.toHaveBeenCalled();
	});

	it("stays quiet across MANY passes (the 20 s tick ran forever in the bug)", async () => {
		features = [point([11, 21])];
		await reconcileOnceForTest(testPorts);
		h.downloadV4Area.mockClear();
		for (let pass = 0; pass < 5; pass++) await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).not.toHaveBeenCalled();
	});

	it("the ledger AGREES with the disk after a pass (hasLines true when tiles exist)", async () => {
		features = [point([12, 22])];
		await reconcileOnceForTest(testPorts);
		const rec = h.cov.get(h.key(12, 22));
		expect(rec).toBeTruthy();
		// The exact contradiction seen live: tiles on disk, ledger says no lines.
		expect(h.tiles.has(h.key(12, 22))).toBe(true);
		expect(rec?.hasLines).toBe(true);
	});

	it("still re-downloads when the tiles are genuinely GONE (self-heal intact)", async () => {
		features = [point([13, 23])];
		await reconcileOnceForTest(testPorts);
		h.downloadV4Area.mockClear();
		h.tiles.delete(h.key(13, 23)); // eviction / DB bump wiped them
		await reconcileOnceForTest(testPorts);
		expect(h.downloadV4Area).toHaveBeenCalledWith(13, 23, undefined, false);
	});
});
