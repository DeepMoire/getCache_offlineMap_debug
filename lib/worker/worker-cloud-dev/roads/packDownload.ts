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
import { mergeSameFrameTiles } from "../../../onPhone/roads/tileMerge";
import { cellTileKey, cellsFor } from "../../../contract/grid";
import { getWorkerTarget, packUrl } from "../tilesHost";
import { noteCircuit } from "../../../shared/workMeter.svelte";
import { satImageKey } from "../../../onPhone/satellite/satelliteImage";

// ⚠️ bump on ANY pack wire/content change — edge cache keys by full URL, survives redeploys, never purged; bump only AFTER the deploy is live or the version is poisoned permanently
export const PACK_FORMAT_VERSION = 45;

// ⚠️ renaming the DB wipes every device's tile pile (fleet-wide re-bake); older rt-tiles* names are swept, never migrated
export const DB_NAME = "gc-offlineTiles";
const STORE = "tiles";
const DB_VERSION = 1;

// ⚠️ sweep must run AFTER the migration settles — rt-tiles-v3 is both the source and a sweep match
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
			// codestyle-allow-swallow: best-effort stale-DB sweep, retried next boot
			.catch(() => {
			});
	}
	});
}

// ⚠️ DO NOT ADD ROWS — derived from roadBlob.ts; edit BLOB_RADIUS_KM / BLOB_ZOOMS, bump PACK_FORMAT_VERSION, and keep the Worker's rings in lockstep
export const RINGS: ReadonlyArray<{ km: number; z: number }> = BLOB_ZOOMS.map(
	(z) => ({ km: BLOB_RADIUS_KM, z }),
);
export const DETAIL_INNER_Z = 15;
export const V4_SOURCE_MAXZOOM = DETAIL_INNER_Z;

function openDb(): Promise<IDBDatabase> {
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

async function idbPutMany(
	items: Array<[string, ArrayBuffer]>,
	onStored?: (done: number) => void,
): Promise<void> {
	// ⚠️ never persist a 0-byte tile — Mapbox throws "Unimplemented type: 4" on every render pass until the DB is wiped
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

/** ⚠️ one transaction — a half-deleted area leaves a coverage record saying "gone" over tiles still on disk. */
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

/** codestyle-allow-blob-getall: on-demand only (/blobs stats) — never on a render path. */
async function idbEntries(): Promise<Array<[string, ArrayBuffer]>> {
	const db = await openDb();
	const out = await new Promise<Array<[string, ArrayBuffer]>>(
		(resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);
			const keysReq = store.getAllKeys();
			// codestyle-allow-blob-getall: on-demand only
			const valsReq = store.getAll();
			tx.oncomplete = () =>
				resolve(
					(keysReq.result as string[])
						.map(
							(k, i) =>
								[k, valsReq.result[i] as ArrayBuffer] as [string, ArrayBuffer],
						)
						.filter(([, b]) => b?.byteLength > 0),
				);
			tx.onerror = () => reject(tx.error);
		},
	);
	db.close();
	return out;
}

// ⚠️ one long-lived handle — idbGetTile runs per visible tile; open/close per call is ruinous
let rawDb: IDBDatabase | null = null;

// ⚠️ a cached connection blocks deleteDatabase — every module caching an IDBDatabase MUST register here
registerOfflineDbReset(() => {
	rawDb?.close();
	rawDb = null;
});

registerWipeLatch({
	latch: () => {
		rawDb?.close();
		rawDb = null;
	},
	unlatch: () => {},
});

// ⚠️ runtime marker for the layer-merge path — once per address per session (a per-read line would spam every pan). Seeing `[roads] merged N pins` in DevTools proves the merged read path is LIVE in the running build (stale-build check, 2026-09-01 strips bug).
const mergedReads = new Set<string>();

/** ⚠️ returns ALL owners layer-merged into ONE tile (byte-concat would keep only the last same-named layer — one pin's roads would erase the other's); null on miss. */
export async function idbGetTileForAddress(
	z: number,
	x: number,
	y: number,
): Promise<ArrayBuffer | null> {
	const keys = keysForAddress(await getAllTileKeys(), z, x, y);
	if (!keys.length) return null;
	if (keys.length === 1) return idbGetTile(keys[0]);

	const parts: ArrayBuffer[] = [];
	for (const k of keys) {
		const b = await idbGetTile(k);
		if (b?.byteLength) parts.push(b);
	}
	if (!parts.length) return null;
	if (parts.length === 1) return parts[0];

	// ⛔ NOT byte-concat: every blob has a layer named `roads`, and the MVT parser indexes layers BY NAME — the LAST duplicate silently wins, so the whole tile flips to one pin (the farthest) whenever another pin lands nearby: roads vanish and appear in axis-aligned strips along the two radius boxes (2026-09-01). Merge at the LAYER level instead — one `roads`, every owner's features, tags re-indexed into merged tables.
	const addr = `${z}/${x}/${y}`;
	if (!mergedReads.has(addr)) {
		mergedReads.add(addr);
		console.warn(`[roads] merged ${parts.length} pins' blobs at ${addr}`);
	}
	return mergeSameFrameTiles(parts.map((b) => new Uint8Array(b))).buffer;
}

export async function idbGetTile(key: string): Promise<ArrayBuffer | null> {
	// ⚠️ never gate this read on the wipe latch — every read becomes a miss and the map silently draws nothing; fix a blocked wipe in wipe.ts
	if (!rawDb) {
		rawDb = await openDb();
		// a version change can close this out from under us — reopen on next read
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
			rawDb = null;
			resolve(null);
			return;
		}
		const req = tx.objectStore(STORE).get(key);
		req.onsuccess = () => {
			// never hand 0 bytes to the protobuf parser
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

export async function hasV4Tiles(): Promise<boolean> {
	return (await idbCount()) > 0;
}

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

// ⚠️ must stay ONE-TIME — a recurring purge makes areas look un-fetched and feeds a purge → re-download loop forever
const PURGE_FLAG = "rtV4EmptyTilesPurged";
export async function purgeEmptyTilesOnce(): Promise<void> {
	try {
		if (typeof localStorage === "undefined") return;
		if (localStorage.getItem(PURGE_FLAG)) return;
		const removed = await purgeEmptyTiles();
		localStorage.setItem(PURGE_FLAG, "1");
		if (removed > 0) {
			console.warn(
				`[v4] purged ${removed} zero-byte tiles left by the pre-guard pack Worker`,
			);
		}
	} catch (err) {
		// codestyle-allow-swallow: best-effort one-time sweep; the read-side skip still applies
		console.warn(
			"[v4] empty-tile purge failed (read-side skip still applies)",
			err,
		);
	}
}


export interface DownloadResult {
	downloaded: number;
	empty: number; // ocean/void tiles
	total: number;
	bytes: number;
	/** X-Pack-Build */
	build?: string;
	/** X-Pack-Cache: HIT | MISS */
	cache?: string;
	/** X-Diag: reads, loopMs, outerKm */
	diag?: string;
}

/** Pack wire format: [uint32 LE manifestLen][manifest JSON][tile bytes in manifest order]. */
interface PackManifest {
	total: number;
	empty: number;
	tiles: Array<{ k: string; n: number }>;
	/** ⛔ the renderer MUST use this box, not the tile's — MVT coords are relative to it; absent on old packs. */
	box?: { w: number; s: number; e: number; n: number };
}

export async function downloadV4Area(
	lng: number,
	lat: number,
	onProgress?: (done: number, total: number) => void,
	// `&ring=corridor` is a distinct edge-cache key — no PACK_FORMAT_VERSION bump needed
	corridor = false,
): Promise<DownloadResult> {
	guardPackDownload({ lng, lat });
	const ringParam = corridor ? "&ring=corridor" : "";
	// ⚠️ timeout must exceed the Worker's cold pack build (~66 s measured) — 60 s made the feature look broken
	// ⛔ send the ACTUAL pin, never the cell centre — the Worker builds around whatever point it is given
	const qLng = lng.toFixed(6);
	const qLat = lat.toFixed(6);
	// ⚠️ packUrl() is null until configureTilesHost() — interpolating it fetches "null?lng=…" and 404s
	const packEndpoint = packUrl();
	if (packEndpoint === null) {
		throw new Error(
			"[v4] no tiles host configured — call configureTilesHost(<origin>) at app boot before downloading a pack.",
		);
	}
	// area-tagged so a background re-bake of an old pin can't repaint the new pin's lights
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

	// gzip is application-layer (not Content-Encoding) so the edge can't double-compress — inflate exactly once
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

	// .slice() copies — a subarray view would alias the whole pack into IndexedDB
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
		build: res.headers.get("x-pack-build") ?? "",
		cache: res.headers.get("x-pack-cache") ?? "",
		diag: res.headers.get("x-diag") ?? "",
	};
}

// ⛔ ONE request per pin, never one per cell — per-cell fetching trips guardPackDownload and draws fragments

export interface V4LayerStat {
	layer: string;
	features: number;
	bytes: number;
}

export function areaTileKeys(lng: number, lat: number): string[] {
	// ⛔ keyed by the PIN (pinTileKey) — a bare cell key served one pin's roads to another
	return cellsFor(lng, lat).map((c) => pinTileKey(lng, lat, c));
}

export interface GeoBox {
	w: number;
	s: number;
	e: number;
	n: number;
}

export interface V4TileIndex {
	// "z/x/y" -> { layerName: { features, bytes } }
	byTile: Record<string, Record<string, { features: number; bytes: number }>>;
	/** "z/x/y" -> box the DECODED geometry really covers, not what the key implies */
	boxByTile: Record<string, GeoBox>;
	tiles: number;
}

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

/** Accepts `pin/<lng>,<lat>/z/x/y` and legacy `z/x/y`; returns null (never NaN) for anything else. */
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
		// ⛔ keys are pin-addressed — splitting on "/" and taking the first three segments yields NaN
		const addr = parseTileAddress(key);
		if (!addr) continue;
		const { z, x, y } = addr;
		let vt: VectorTile;
		try {
			// pbf@4 lacks the PbfReader type vector-tile's d.ts imports — boundary cast
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
		let w = Infinity;
		let s2 = Infinity;
		let e = -Infinity;
		let n2 = -Infinity;
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
		// Infinity sentinels must never leak out as coordinates
		if (Number.isFinite(w) && Number.isFinite(s2))
			boxByTile[key] = { w, s: s2, e, n: n2 };
	}
	return { byTile, boxByTile, tiles };
}

// ⚠️ verify tiles on disk — never trust a registry flag (DB rename / storage eviction leaves the flag behind)
export async function areaTilesPresent(
	lng: number,
	lat: number,
): Promise<boolean> {
	// ⚠️ EXACT, not any-hit — a fuzzy probe stamped 232 areas current while holding none of the new ring
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

/** ⚠️ batch probes through areaTilesPresentIn — per-area areaTilesPresent over hundreds of areas is an I/O storm. */
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

export function areaTilesPresentIn(
	stored: Set<string>,
	lng: number,
	lat: number,
): boolean {
	const keys = areaTileKeys(lng, lat);
	return keys.length > 0 && keys.every((k) => stored.has(k));
}

// ⚠️ must ask the SAME question as areaTilesPresent — a looser adoption probe stamped areas current without the tiles
export async function areaCentreCovered(
	lng: number,
	lat: number,
): Promise<boolean> {
	return areaTilesPresent(lng, lat);
}

// ⚠️ rtwall:// and rtraw:// MUST be listed — a blocked "Tile" gets BLANK_PNG fed to the protobuf parser
const LOCAL_PREFIXES = [
	"blob:",
	"data:",
	"capacitor://",
	"file://",
	"rtwall://",
	"rtraw://",
];
// ⚠️ a false negative doesn't just block, it substitutes BLANK_PNG — must accept 127.0.0.1/localhost, https proxy, capacitor
const isSameOrigin = (url: string): boolean => {
	if (typeof location === "undefined") return false;
	if (url.startsWith(`${location.origin}/`)) return true;
	try {
		const u = new URL(url, location.href);
		if (u.host === location.host) return true;
		if (u.protocol === "capacitor:" || u.protocol === "ionic:") return true;
		return false;
	} catch {
		// codestyle-allow-swallow: unparseable URL is not same-origin
		return false;
	}
};
const BLANK_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// ⚠️ only an image request may be answered with an image — a PNG handed to a parsed resource corrupts on every render pass
const IMAGE_RESOURCES = new Set(["Image", "SpriteImage", "Tile"]);
let blockedLogged = 0;

/** ⚠️ a blocked non-image resource must get "" — a blocked glyph must NOT become a PNG. */
export function v4TransformRequest(
	url: string,
	resourceType?: string,
): { url: string } {
	if (url.startsWith("/")) {
		// ⚠️ must absolutise — Mapbox's worker is a blob: URL, so a root-relative tile URL throws there (fine on the main thread)
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
	if (resourceType && IMAGE_RESOURCES.has(resourceType)) {
		return { url: BLANK_PNG };
	}
	return { url: "" };
}
