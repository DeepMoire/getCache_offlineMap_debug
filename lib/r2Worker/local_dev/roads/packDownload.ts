// v4 offline base map — downloads Protomaps tiles to on-device storage and serves them to the renderer UNCHANGED (LAW 0: map never streams).
// ⚠️ the disc math here MUST match the Worker's (workers/offline-tiles/) — RENDER has no decode step; NOTHING in this file turns a tile into GeoJSON any more.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { guardPackDownload } from "../../../onPhone/store/downloadGuard";
import { migrateIdbDatabase } from "../../../onPhone/store/idbRename";
import {
	currentDbName,
	registerOfflineDbReset,
	registerWipeLatch,
} from "../../../shared/sandboxDbNames";
import { BLOB_RADIUS_KM, BLOB_ZOOMS } from "../../../contract/roadBlob";
import { pinTileKey } from "../../../contract/grid";
import { keysForAddress } from "../../../onPhone/roads/pinTileLookup";
import { cellTileKey, cellsFor } from "../../../contract/grid";
import { getWorkerTarget, packUrl } from "../tilesHost";
import { noteCircuit } from "../../../shared/workMeter.svelte";
import { satImageKey } from "../../../onPhone/satellite/satelliteImage";

/** The `offline-tiles` Worker's pack endpoint — ring geometry here (RINGS / DETAIL_INNER_Z) MUST stay in lockstep with the Worker. */
// ⚠️ bump PACK_FORMAT_VERSION whenever the wire format changes — packs are cached immutable at the edge with no purge, so bump only AFTER the deploy is live, or a version requested against the old build is poisoned permanently.
export const PACK_FORMAT_VERSION = 44;

// renaming DB_NAME is the fleet-wide re-bake lever — it wipes the pile, so every area re-downloads at current geometry on its next reconcile pass.
// `gc-` = Get Cache (this app, not ReTreever); `Tiles` = roads/water geometry (satellite photos live in gc-offlineSatellite).
export const DB_NAME = "gc-offlineTiles";
const STORE = "tiles";
const DB_VERSION = 1;

// ⚠️ order is load-bearing — the sweep must run only AFTER the migration settles, or it races the copy and deletes the pile mid-read.
// only rt-tiles-v3 is migrated; older rt-tiles* and retreever-v4-tiles* generations are swept without migration (superseded geometry, re-baked thin).
const TILES_MIGRATION_SOURCE = "rt-tiles-v3";
if (typeof indexedDB !== "undefined") {
	void migrateIdbDatabase(TILES_MIGRATION_SOURCE, DB_NAME, STORE).then(() => {
	if (typeof indexedDB.databases === "function") {
		indexedDB
			.databases()
			.then((dbs) => {
				for (const d of dbs) {
					if (
						(d.name?.startsWith("retreever-v4-tiles") ||
							d.name?.startsWith("rt-tiles")) &&
						d.name !== DB_NAME
					) {
						indexedDB.deleteDatabase(d.name);
					}
				}
			})
			// codestyle-allow-swallow: best-effort stale-DB sweep; if indexedDB.databases() rejects we just leave the old tile DBs to be swept next boot
			.catch(() => {
				/* swept next boot instead */
			});
	}
	});
}

// ⚠️ DO NOT ADD ROWS HERE — RINGS is derived from roadBlob.ts (one radius × every zoom); a hand-maintained list drifted before (declared 40km while the Worker shipped 25km). To change coverage, edit BLOB_RADIUS_KM/BLOB_ZOOMS and bump PACK_FORMAT_VERSION.
export const RINGS: ReadonlyArray<{ km: number; z: number }> = BLOB_ZOOMS.map(
	(z) => ({ km: BLOB_RADIUS_KM, z }),
);
/** Inner (detail) zoom — a stored tile below this contributes roads + water when decoded for stats. */
export const DETAIL_INNER_Z = 15;
export const V4_SOURCE_MAXZOOM = DETAIL_INNER_Z;

// ⛔ ring machinery (tilesForRing/tilesForRings/tileKey) is DELETED — one cell is ONE blob under ONE key (areaTileKeys → cellTileKey), nothing left to enumerate.

function openDb(): Promise<IDBDatabase> {
	// opens fresh each call, so no cached handle to reset on sandbox toggle
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(currentDbName(DB_NAME), DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE))
				req.result.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** Write many tiles in ONE transaction (open/close the DB once, not per tile — avoids ~1000 connection churns). onStored ticks per put for UI. */
async function idbPutMany(
	items: Array<[string, ArrayBuffer]>,
	onStored?: (done: number) => void,
): Promise<void> {
	// ⚠️ THE WRITE BOUNDARY — a 0-byte tile must never be persisted; Mapbox's worker throws "Unimplemented type: 4" parsing it on every render pass until the DB is wiped.
	items = items.filter(([, b]) => b.byteLength > 0);
	if (!items.length) return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		let done = 0;
		for (const [k, b] of items) {
			const req = store.put(b, k);
			req.onsuccess = () => onStored?.(++done);
		}
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}

/** Deletes one area's tiles — the missing half of idbPutMany (pruneArea used to evict everything else but leak tiles forever). ONE transaction: a half-deleted area is a coverage record saying "gone" over tiles that are still there. */
export async function idbDeleteMany(keys: readonly string[]): Promise<void> {
	if (!keys.length) return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		for (const k of keys) store.delete(k);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}

// EVERY stored tile's bytes (full-pile read). codestyle-allow-blob-getall: ON-DEMAND ONLY (the /blobs stats page) — must never move onto a render path. Enforced by scripts/check-blob-getall.mjs.
async function idbEntries(): Promise<Array<[string, ArrayBuffer]>> {
	const db = await openDb();
	const out = await new Promise<Array<[string, ArrayBuffer]>>(
		(resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);
			const keysReq = store.getAllKeys();
			// codestyle-allow-blob-getall: on-demand only — no render path reaches here.
			const valsReq = store.getAll();
			tx.oncomplete = () =>
				resolve(
					(keysReq.result as string[])
						.map(
							(k, i) =>
								[k, valsReq.result[i] as ArrayBuffer] as [string, ArrayBuffer],
						)
						// never hand a 0-byte tile to the decoder — same self-heal as idbGetMany (see write-boundary note in idbPutMany).
						.filter(([, b]) => b?.byteLength > 0),
				);
			tx.onerror = () => reject(tx.error);
		},
	);
	db.close();
	return out;
}

// idbGetTile runs PER VISIBLE TILE while panning, so it holds ONE long-lived connection instead of open/close per call. A miss is NORMAL — most addresses were never downloaded — and returns null.
let rawDb: IDBDatabase | null = null;

// ⛔ a cached connection blocks deleteDatabase — any module caching an IDBDatabase MUST register a closer here, or a wipe silently does nothing (MEASURED: 4,303 stale tiles survived).
registerOfflineDbReset(() => {
	rawDb?.close();
	rawDb = null;
});

/** ⛔ closing the handle isn't enough — reads must stop REOPENING it, or a read microseconds after close re-establishes the connection that blocks deleteDatabase. While the latch is set, reads resolve as MISSES instead of reopening. */
registerWipeLatch({
	// closes the cached handle before deleting; refusing later reads is done in idbGetTile, not here.
	latch: () => {
		rawDb?.close();
		rawDb = null;
	},
	unlatch: () => {},
});

/** Reads roads for a z/x/y ADDRESS — EVERY owning pin, merged (returning only one owner left half a map blank; MEASURED at a Greybull pin). The merge is a byte concatenation, valid by the MVT spec since same-address tiles share a frame — nothing decoded or re-projected. A miss returns null, never another pin's bytes standing in. */
export async function idbGetTileForAddress(
	z: number,
	x: number,
	y: number,
): Promise<ArrayBuffer | null> {
	const keys = keysForAddress(await getAllTileKeys(), z, x, y);
	if (!keys.length) return null;
	// The common case is ONE owner — return its bytes untouched (no copy).
	if (keys.length === 1) return idbGetTile(keys[0]);

	const parts: ArrayBuffer[] = [];
	for (const k of keys) {
		const b = await idbGetTile(k);
		if (b?.byteLength) parts.push(b);
	}
	if (!parts.length) return null;
	if (parts.length === 1) return parts[0];

	const total = parts.reduce((n, b) => n + b.byteLength, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const b of parts) {
		out.set(new Uint8Array(b), off);
		off += b.byteLength;
	}
	return out.buffer;
}

export async function idbGetTile(key: string): Promise<ArrayBuffer | null> {
	// ⛔ the latch no longer blocks reads — a latch that survives here makes every read a miss, indistinguishable from "blobs never arrive". If the wipe blocks again, fix it in wipe.ts, never by making this read path conditional.
	if (!rawDb) {
		rawDb = await openDb();
		// a connection can be closed out from under us by a version change (the legacy-DB sweep) — drop the handle so the next read reopens.
		rawDb.onclose = () => {
			rawDb = null;
		};
	}
	const db = rawDb;
	return new Promise<ArrayBuffer | null>((resolve) => {
		let tx: IDBTransaction;
		try {
			tx = db.transaction(STORE, "readonly");
		} catch {
			// Connection went stale mid-flight — reopen on the next call.
			rawDb = null;
			resolve(null);
			return;
		}
		const req = tx.objectStore(STORE).get(key);
		req.onsuccess = () => {
			// same 0-byte self-heal as idbGetMany — never hand empty bytes to the protobuf parser ("Unimplemented type: 4" on every render pass).
			const b = req.result as ArrayBuffer | undefined;
			resolve(b?.byteLength ? b : null);
		};
		req.onerror = () => resolve(null);
	});
}

async function idbCount(): Promise<number> {
	const db = await openDb();
	const n = await new Promise<number>((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).count();
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	db.close();
	return n;
}

/** True once at least one tile is stored (so we can skip a re-download). */
export async function hasV4Tiles(): Promise<boolean> {
	return (await idbCount()) > 0;
}

/** One-time sweep of 0-byte tiles — an ANY-HIT areaTilesPresent probe reads an all-empty area as "covered" and never re-downloads it, a permanent hole. Cheap, idempotent cursor pass. */
export async function purgeEmptyTiles(): Promise<number> {
	const db = await openDb();
	const removed = await new Promise<number>((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		let n = 0;
		const cur = store.openCursor();
		cur.onsuccess = () => {
			const c = cur.result;
			if (!c) return;
			const v = c.value as ArrayBuffer | undefined;
			if (!v || v.byteLength === 0) {
				c.delete();
				n++;
			}
			c.continue();
		};
		tx.oncomplete = () => resolve(n);
		tx.onerror = () => reject(tx.error);
	});
	db.close();
	return removed;
}

/** Runs purgeEmptyTiles() at most once per install (localStorage-guarded). ⚠️ MUST NEVER become a recurring sweep — deleting a tile makes its area look un-fetched, and a repeating purge feeds an infinite purge→redownload→purge loop. */
const PURGE_FLAG = "rtV4EmptyTilesPurged";
export async function purgeEmptyTilesOnce(): Promise<void> {
	try {
		if (typeof localStorage === "undefined") return;
		if (localStorage.getItem(PURGE_FLAG)) return;
		const removed = await purgeEmptyTiles();
		localStorage.setItem(PURGE_FLAG, "1");
		if (removed > 0) {
			// loud on purpose, once per install — reports real corruption that was silently breaking the map.
			console.warn(
				`[v4] purged ${removed} zero-byte tiles left by the pre-guard pack Worker`,
			);
		}
	} catch (err) {
		// codestyle-allow-swallow: a best-effort one-time sweep — if storage is blocked, the read-side skip still keeps empties away from Mapbox; this only reclaims space and un-sticks stale coverage.
		console.warn(
			"[v4] empty-tile purge failed (read-side skip still applies)",
			err,
		);
	}
}

export interface DownloadResult {
	downloaded: number;
	empty: number; // tiles the planet has nothing for (ocean/void) — fine
	total: number;
	bytes: number;
	/** Worker build id (X-Pack-Build) — which deployed code answered, so a deploy is visible in the console instead of guessed at. */
	build?: string;
	/** HIT | MISS (X-Pack-Cache). MISS = real cold build; HIT = replayed edge bytes, says nothing about build speed. */
	cache?: string;
	/** Worker's own timings (X-Diag): reads, loopMs, outerKm — loopMs separates "slow build" from "slow network". */
	diag?: string;
}

/** Worker's pack wire format (workers/offline-tiles/src/index.ts): [uint32 LE manifestLen][manifest JSON][tile bytes, manifest order]. manifest = {total, empty, tiles:[{k:"z/x/y", n:byteLen}]}; zoom lives in each key. */
interface PackManifest {
	total: number;
	empty: number;
	tiles: Array<{ k: string; n: number }>;
	/** The box the blob's geometry was drawn into — [w,s,e,n] degrees. ⛔ the renderer MUST use THIS box, not the tile's — assuming the wrong one draws the data elsewhere entirely (MEASURED: 89km off at Timbuktu). Absent on pre-shipped packs, which fall back to tile bounds. */
	box?: { w: number; s: number; e: number; n: number };
}

/** Downloads the area around (lng,lat) into IndexedDB in ONE request to the offline-tiles Worker's /pack endpoint (the one network op, on user volition). Fails LOUD — a non-OK response or short body throws, no silent fallback. */
export async function downloadV4Area(
	lng: number,
	lat: number,
	onProgress?: (done: number, total: number) => void,
	// corridor: a thin roads-only ribbon instead of the full area (Worker's &ring=corridor, CORRIDOR_RINGS) — a distinct cache key, so no PACK_FORMAT_VERSION bump needed.
	corridor = false,
): Promise<DownloadResult> {
	// trips the circuit breaker if an implausible number of pack downloads fire in one session (a reconcile loop) — before the network call.
	guardPackDownload({ lng, lat });
	const ringParam = corridor ? "&ring=corridor" : "";
	// ⛔ LIE-FI GUARD — timeout must stay well above the Worker's cold-build time (~56-66s MEASURED); 60s was too short and made the feature look randomly broken. Currently 150s. Never re-tighten without re-measuring the Worker's build time.
	// ⚠️ ASK BY THE ACTUAL PIN, never the cell centre — a cache key may be DERIVED from the request but must never REPLACE it (MEASURED: cell-centre optimisation put roads 70km off at a Timbuktu pin).
	const qLng = lng.toFixed(6);
	const qLat = lat.toFixed(6);
	// NO HOST, NO REQUEST — packUrl() is null until configureTilesHost() is called; interpolating null would silently fetch "null?lng=..." (404, reads as "map is broken" not "not configured").
	const packEndpoint = packUrl();
	if (packEndpoint === null) {
		throw new Error(
			"[v4] no tiles host configured — call configureTilesHost(<origin>) at app boot before downloading a pack.",
		);
	}
	// CIRCUITS (workMeter.svelte.ts): yellow now, green when bytes land, red on any failure — tagged with the area so a background re-bake of an OLD pin can't repaint the pin just dropped.
	const wk = `worker:${getWorkerTarget()}`;
	const area = satImageKey([lng, lat]);
	const lit = (state: "transit" | "ok" | "err", note = "") => {
		noteCircuit(wk, state, note, area);
		noteCircuit("pack", state, note, area);
	};
	lit("transit");
	let res: Response;
	try {
		res = await fetch(
			`${packEndpoint}?lng=${qLng}&lat=${qLat}&pv=${PACK_FORMAT_VERSION}${ringParam}`,
			{ signal: AbortSignal.timeout(150_000) },
		);
	} catch (err) {
		lit("err", err instanceof Error ? err.message : String(err));
		throw err;
	}
	if (!res.ok) {
		lit("err", `${res.status} ${res.statusText}`);
		throw new Error(
			`[v4] pack fetch failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`,
		);
	}

	// Worker gzips at the APPLICATION layer (not transport Content-Encoding) so the edge can't double-compress — inflate that one explicit layer here.
	if (!res.body) throw new Error("[v4] pack response has no body");
	const buf = new Uint8Array(
		await new Response(
			res.body.pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer(),
	);
	if (buf.byteLength < 4) throw new Error("[v4] pack response too short");

	const manifestLen = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(
		0,
		true,
	);
	const manifest = JSON.parse(
		new TextDecoder().decode(buf.subarray(4, 4 + manifestLen)),
	) as PackManifest;

	// .slice() copies each tile out of the trailing blob — a subarray view would alias the whole pack and bloat IndexedDB. Order matches the manifest.
	const items: Array<[string, ArrayBuffer]> = [];
	let off = 4 + manifestLen;
	let bytes = 0;
	for (const t of manifest.tiles) {
		items.push([t.k, buf.slice(off, off + t.n).buffer]);
		off += t.n;
		bytes += t.n;
	}

	onProgress?.(0, items.length);
	await idbPutMany(items, (done) => onProgress?.(done, items.length));
	lit("ok", `${items.length} tiles · ${(bytes / 1e6).toFixed(2)} MB · cache ${res.headers.get("x-pack-cache") ?? "?"}`);

	return {
		downloaded: items.length,
		empty: manifest.empty,
		total: manifest.total,
		bytes,
		// server-side truth surfaced to console — loopMs is what separates "slow network" from "slow build" (proved the bottleneck was read count, not bytes).
		build: res.headers.get("x-pack-build") ?? "",
		cache: res.headers.get("x-pack-cache") ?? "",
		diag: res.headers.get("x-diag") ?? "",
	};
}

// ⛔ ONE request per pin, never one per cell — per-cell fetching produced unpredictable arrival, latched the circuit breaker, and was slower (see downloadV4Area above).

// ⚠️ THE WALL MAP DOES NOT DECODE — downloaded tiles are handed to MapLibre exactly as they arrived (rawWallProtocol.ts). Nothing decodes on the render path any more; a tile is downloaded, stored, and handed to the renderer.

// `bytes` below is serialized-GeoJSON size, not on-disk MVT bytes (which has no per-layer split) — a comparable proxy only.
export interface V4LayerStat {
	layer: string;
	features: number;
	bytes: number;
}

/** Tile keys for the area around (lng,lat) — used by /blobs to sum a feature's layer breakdown from the per-tile index below. */
export function areaTileKeys(lng: number, lat: number): string[] {
	// ⛔ a handful of keys now, not a jagged disc — one cell is ONE blob under ONE key; a pin needs 1-4 keys (grid.ts cellsFor) to keep the 20km guarantee true everywhere.
	// ⛔ KEYED BY THE PIN (grid.ts pinTileKey) — a bare cell key is shared by two pins and served one pin's roads to another (MEASURED: 50.4km off).
	return cellsFor(lng, lat).map((c) => pinTileKey(lng, lat, c));
}

// ONE decode pass → a per-tile, per-source-layer index; /blobs sums it globally and per-feature (via areaTileKeys).
/** The real-world box a decoded tile's geometry actually occupies, in degrees. ⛔ every offline bug here was correct bytes in the WRONG BOX — a feature count can't show 400m drift, two corners and a distance can. */
export interface GeoBox {
	w: number;
	s: number;
	e: number;
	n: number;
}

export interface V4TileIndex {
	// "z/x/y" -> { layerName: { features, bytes } }
	byTile: Record<string, Record<string, { features: number; bytes: number }>>;
	/** "z/x/y" -> the box the tile's DECODED geometry really covers — not the box the key implies; comparing the two is the check. */
	boxByTile: Record<string, GeoBox>;
	tiles: number;
}

/** Distance in metres between two lng/lat points (haversine). */
export function metresBetween(
	aLng: number,
	aLat: number,
	bLng: number,
	bLat: number,
): number {
	const R = 6_371_008.8;
	const toRad = (d: number): number => (d * Math.PI) / 180;
	const dLat = toRad(bLat - aLat);
	const dLng = toRad(bLng - aLng);
	const la1 = toRad(aLat);
	const la2 = toRad(bLat);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

/** The tile-grid box a "z/x/y" key ADDRESSES — the promise, compared against the geometry's real box (the delivery). A gap between them IS the bug. */
export function boxOfTileKey(key: string): GeoBox | null {
	const [z, x, y] = key.split("/").map(Number);
	if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y))
		return null;
	const n = 2 ** z;
	const lng = (i: number): number => (i / n) * 360 - 180;
	const lat = (j: number): number => {
		const t = Math.PI - 2 * Math.PI * (j / n);
		return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
	};
	return { w: lng(x), e: lng(x + 1), n: lat(y), s: lat(y + 1) };
}

/** The z/x/y numbers inside a stored tile key — accepts pin/<lng>,<lat>/<z>/<x>/<y> (current) and legacy <z>/<x>/<y>. Returns null rather than NaN — a NaN address silently produced garbage coordinates before. */
export function parseTileAddress(
	key: string,
): { z: number; x: number; y: number } | null {
	const parts = key.split("/");
	const tail = parts.length === 5 && parts[0] === "pin" ? parts.slice(2) : parts;
	if (tail.length !== 3) return null;
	const [z, x, y] = tail.map(Number);
	if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y))
		return null;
	return { z, x, y };
}

export async function decodeV4TileLayerStats(): Promise<V4TileIndex> {
	const byTile: V4TileIndex["byTile"] = {};
	const boxByTile: V4TileIndex["boxByTile"] = {};
	let tiles = 0;
	for (const [key, bytes] of await idbEntries()) {
		// ⛔ keys are PIN-ADDRESSED (pin/<lng>,<lat>/<z>/<x>/<y>) — naively splitting on "/" yields NaN z/x/y and garbage coordinates; use parseTileAddress. MEASURED: a boxless roads row hid a real bug.
		const addr = parseTileAddress(key);
		if (!addr) continue;
		const { z, x, y } = addr;
		let vt: VectorTile;
		try {
			// pbf@4 doesn't export the PbfReader type vector-tile's d.ts imports — boundary cast (runtime-correct); drop when @mapbox/vector-tile ships pbf@4 types.
			vt = new VectorTile(
				new Pbf(new Uint8Array(bytes)) as unknown as ConstructorParameters<
					typeof VectorTile
				>[0],
			);
		} catch {
			continue;
		}
		tiles++;
		const perLayer: Record<string, { features: number; bytes: number }> = {};
		// decoded box accumulated across every layer — toGeoJSON already returns real lng/lat, so this is a min/max on a walk we were doing anyway (no second decode).
		let w = Infinity;
		let s2 = Infinity;
		let e = -Infinity;
		let n2 = -Infinity;
		/** Walk a GeoJSON coordinate tree of any depth and widen the box. */
		const eat = (c: unknown): void => {
			if (!Array.isArray(c)) return;
			if (typeof c[0] === "number" && typeof c[1] === "number") {
				const [lo, la] = c as [number, number];
				if (!Number.isFinite(lo) || !Number.isFinite(la)) return;
				if (lo < w) w = lo;
				if (lo > e) e = lo;
				if (la < s2) s2 = la;
				if (la > n2) n2 = la;
				return;
			}
			for (const part of c) eat(part);
		};
		for (const name of Object.keys(vt.layers)) {
			const layer = vt.layers[name];
			const feats: GeoJSON.Feature[] = [];
			for (let i = 0; i < layer.length; i++) {
				const f = layer.feature(i).toGeoJSON(x, y, z) as GeoJSON.Feature;
				feats.push(f);
				const g = f.geometry as { coordinates?: unknown } | null;
				if (g && "coordinates" in g) eat(g.coordinates);
			}
			perLayer[name] = {
				features: feats.length,
				bytes: JSON.stringify(feats).length,
			};
		}
		byTile[key] = perLayer;
		// only record a box if geometry was seen — Infinity sentinels must never leak out as coordinates.
		if (Number.isFinite(w) && Number.isFinite(s2))
			boxByTile[key] = { w, s: s2, e, n: n2 };
	}
	return { byTile, boxByTile, tiles };
}

// ⚠️ must VERIFY tiles are really present, never trust a registry flag — a centre-only probe would re-download edge-sparse areas forever (silent cellular burn). Checks REAL keys: any present → valid.
export async function areaTilesPresent(
	lng: number,
	lat: number,
): Promise<boolean> {
	// EXACT, not a vote — every cell this area needs must be on disk. ⚠️ a fuzzy "any tile" probe once let 232 areas stamp themselves current while holding none of a new ring (2026-08-17), destroying the staleness signal permanently.
	const keys = areaTileKeys(lng, lat);
	if (!keys.length) return false;
	const db = await openDb();
	const present = await new Promise<boolean>((resolve) => {
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		let pending = keys.length;
		let hits = 0;
		const tick = () => {
			if (--pending === 0) resolve(hits === keys.length);
		};
		for (const k of keys) {
			const req = store.getKey(k);
			req.onsuccess = () => {
				if (req.result !== undefined) hits++;
				tick();
			};
			req.onerror = () => tick();
		}
	});
	db.close();
	return present;
}

/** Every stored tile key in ONE getAllKeys() — batches many area probes in a single DB open. Calling areaTilesPresent per-area for hundreds of areas is a real I/O storm; load once, then use areaTilesPresentIn. */
export async function getAllTileKeys(): Promise<Set<string>> {
	const db = await openDb();
	const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).getAllKeys();
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	db.close();
	return new Set(keys.map(String));
}

/** Pure, zero-I/O equivalent of areaTilesPresent — are all of this area's cell blobs in an already-loaded key set (getAllTileKeys)? Same exact rule, just no DB open per area. */
export function areaTilesPresentIn(
	stored: Set<string>,
	lng: number,
	lat: number,
): boolean {
	const keys = areaTileKeys(lng, lat);
	return keys.length > 0 && keys.every((k) => stored.has(k));
}

/** ADOPTION probe for an anchor with no/stale coverage record. ⛔ deliberately the SAME question as areaTilesPresent now — two probes once disagreed and caused the 2026-08-17 stamp-without-tiles bug; kept as a named function so both call sites read clearly. */
export async function areaCentreCovered(
	lng: number,
	lat: number,
): Promise<boolean> {
	return areaTilesPresent(lng, lat);
}

// LAW 0: the map renders from in-memory GeoJSON only, no tile requests — this guard hard-blocks any stray non-local URL so the map physically cannot stream.
// ⚠️ rtwall:// and rtraw:// MUST be in LOCAL_PREFIXES — omitting either falls through to BLANK_PNG for a "Tile" resource, handing a protobuf parser PNG bytes ("Unimplemented type: 4"), silently, per-tile, forever.
const LOCAL_PREFIXES = [
	"blob:",
	"data:",
	"capacitor://",
	"file://",
	"rtwall://",
	"rtraw://",
];
/** Same-origin test — must accept EVERY form the browser may hand us; a false negative doesn't just block, it substitutes the wrong resource type. location.origin alone misses 127.0.0.1 vs localhost, https/proxy, and Capacitor. */
const isSameOrigin = (url: string): boolean => {
	if (typeof location === "undefined") return false;
	if (url.startsWith(`${location.origin}/`)) return true;
	try {
		const u = new URL(url, location.href);
		// Host+port match on any scheme (dev https proxy, 127.0.0.1 vs localhost).
		if (u.host === location.host) return true;
		// Capacitor/Ionic serve the bundle from their own scheme — still on-device.
		if (u.protocol === "capacitor:" || u.protocol === "ionic:") return true;
		return false;
	} catch {
		// codestyle-allow-swallow: an unparseable URL is not same-origin; the caller blocks it, which is the safe direction.
		return false;
	}
};
const BLANK_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** Glyphs/tiles/geojson are PARSED, not decoded as images — handing any of them a PNG is guaranteed corruption ("Unimplemented type: 4", every render pass, forever). Only an image request may get an image. */
const IMAGE_RESOURCES = new Set(["Image", "SpriteImage", "Tile"]);
let blockedLogged = 0;

/** Passes on-device URLs through; BLOCKs everything else (LAW 0). resourceType decides what a blocked request gets back — a blocked GLYPH must NOT become a PNG; blocking with null/"" makes Mapbox treat it as a clean miss instead of feeding the parser garbage. */
export function v4TransformRequest(
	url: string,
	resourceType?: string,
): { url: string } {
	if (url.startsWith("/")) {
		// ABSOLUTISE root-relative URLs here, on the main thread — Mapbox's worker runs from a blob: URL, so a relative URL there fails to parse ("Failed to construct 'Request'"); resolving here makes it unambiguous before any worker sees it.
		return {
			url:
				typeof location === "undefined"
					? url
					: new URL(url, location.href).href,
		};
	}
	if (LOCAL_PREFIXES.some((p) => url.startsWith(p)) || isSameOrigin(url)) {
		return { url };
	}
	if (blockedLogged < 8) {
		blockedLogged++;
		console.warn(
			`[v4] blocked non-local map request (${resourceType ?? "unknown"}): ${url}`,
		);
	}
	// an image request can safely take a blank image; anything PARSED (glyphs, style/sprite JSON, vector tiles) must get nothing at all.
	if (resourceType && IMAGE_RESOURCES.has(resourceType)) {
		return { url: BLANK_PNG };
	}
	return { url: "" };
}
