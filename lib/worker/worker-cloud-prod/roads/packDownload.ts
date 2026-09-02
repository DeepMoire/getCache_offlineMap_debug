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
import { packUrl } from "../tilesHost";

// ⚠️ bump on ANY pack wire/content change — edge cache is immutable, keyed by the full URL
export const PACK_FORMAT_VERSION = 45;

// renaming the DB wipes the pile → fleet-wide re-download
export const DB_NAME = "gc-offlineTiles";
const STORE = "tiles";
const DB_VERSION = 1;

// ⚠️ sweep must run AFTER the migration settles — the source is also a sweep match
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
			// codestyle-allow-swallow: stale-DB sweep retries next boot
			.catch(() => {
			});
	}
	});
}

// ⚠️ don't add rows — projection of roadBlob.ts; change BLOB_RADIUS_KM / BLOB_ZOOMS and bump PACK_FORMAT_VERSION
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
	// ⚠️ write boundary — a persisted 0-byte tile throws "Unimplemented type: 4" in Mapbox on every render
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

// codestyle-allow-blob-getall: on-demand /blobs stats only — never on a render path
async function idbEntries(): Promise<Array<[string, ArrayBuffer]>> {
	const db = await openDb();
	const out = await new Promise<Array<[string, ArrayBuffer]>>(
		(resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);
			const keysReq = store.getAllKeys();
			// codestyle-allow-blob-getall: on-demand only, no render path reaches here
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

// long-lived handle; idbGetTile runs per visible tile
let rawDb: IDBDatabase | null = null;

// ⛔ a cached connection blocks deleteDatabase — any module caching an IDBDatabase must register here
registerOfflineDbReset(() => {
	rawDb?.close();
	rawDb = null;
});

// ⛔ the latch only closes the handle — never make reads miss (see idbGetTile)
registerWipeLatch({
	latch: () => {
		rawDb?.close();
		rawDb = null;
	},
	unlatch: () => {},
});

/** ⛔ merges EVERY owning pin into ONE layer-merged tile (byte-concat keeps only the last same-named layer); null on miss — never another pin's bytes. */
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
	return mergeSameFrameTiles(parts.map((b) => new Uint8Array(b))).buffer;
}

export async function idbGetTile(key: string): Promise<ArrayBuffer | null> {
	// ⛔ don't gate reads on the wipe latch — a stuck latch makes every read a miss; fix wipes in wipe.ts
	if (!rawDb) {
		rawDb = await openDb();
		// a version change can close the handle — drop it so the next read reopens
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
			// stale connection — reopen next call
			rawDb = null;
			resolve(null);
			return;
		}
		const req = tx.objectStore(STORE).get(key);
		req.onsuccess = () => {
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

// ⚠️ must stay one-time — a recurring purge makes areas read un-fetched and feeds a download loop
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
		// codestyle-allow-swallow: best-effort sweep; the read-side skip still applies
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
	build?: string;
	cache?: string;
	diag?: string;
}

// wire: [uint32 LE manifestLen][manifest JSON][tile bytes in manifest order]
interface PackManifest {
	total: number;
	empty: number;
	tiles: Array<{ k: string; n: number }>;
	// ⛔ renderer must use THIS box, not the tile's — MVT coords are relative to it; absent on old packs
	box?: { w: number; s: number; e: number; n: number };
}

export async function downloadV4Area(
	lng: number,
	lat: number,
	onProgress?: (done: number, total: number) => void,
	// corridor: Worker's &ring=corridor, a distinct edge-cache key
	corridor = false,
): Promise<DownloadResult> {
	guardPackDownload({ lng, lat });
	const ringParam = corridor ? "&ring=corridor" : "";
	// ⛔ send the REAL pin, never the cell centre — the Worker builds the blob around whatever point it gets
	const qLng = lng.toFixed(6);
	const qLat = lat.toFixed(6);
	// a null host would fetch "null?lng=…" and 404 — throw instead
	const packEndpoint = packUrl();
	if (packEndpoint === null) {
		throw new Error(
			"[v4] no tiles host configured — call configureTilesHost(<origin>) at app boot before downloading a pack.",
		);
	}
	// ⛔ timeout must exceed the Worker's cold pack build (~66 s measured) — 60 s made the feature look broken
	const res = await fetch(
		`${packEndpoint}?lng=${qLng}&lat=${qLat}&pv=${PACK_FORMAT_VERSION}${ringParam}`,
		{ signal: AbortSignal.timeout(150_000) },
	);
	if (!res.ok) {
		throw new Error(
			`[v4] pack fetch failed: ${res.status} ${res.statusText} — ${await res.text().catch(() => "")}`,
		);
	}
	// ⚠️ app-layer gzip, not Content-Encoding — inflate exactly one layer
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

// ⛔ one pack request per pin, never per cell — per-cell arrives fragmented and trips guardPackDownload

export interface V4LayerStat {
	layer: string;
	features: number;
	bytes: number;
}

export function areaTileKeys(lng: number, lat: number): string[] {
	// ⛔ keyed by the PIN, not the bare cell — a shared cell key served one pin's roads to another
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
	// "z/x/y" -> the decoded geometry's real box, not the key's
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

/** Accepts `pin/<lng>,<lat>/z/x/y` and legacy `z/x/y`; null (never NaN) otherwise — callers MUST check. */
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
		const addr = parseTileAddress(key);
		if (!addr) continue;
		const { z, x, y } = addr;
		let vt: VectorTile;
		try {
			// pbf@4 lacks the PbfReader type vector-tile's d.ts expects — boundary cast
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
		// no geometry → no box; Infinity sentinels must not leak
		if (Number.isFinite(w) && Number.isFinite(s2))
			boxByTile[key] = { w, s: s2, e, n: n2 };
	}
	return { byTile, boxByTile, tiles };
}

export async function areaTilesPresent(
	lng: number,
	lat: number,
): Promise<boolean> {
	// ⚠️ exact — ALL cells on disk, never a registry flag or any-hit vote; a fuzzy probe let 232 areas stamp current while holding nothing
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

/** ⚠️ Load once and use areaTilesPresentIn when probing many areas — per-area areaTilesPresent is an I/O storm. */
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

// ⛔ deliberately the same question as areaTilesPresent — the probe must check the shape the stamp promises
export async function areaCentreCovered(
	lng: number,
	lat: number,
): Promise<boolean> {
	return areaTilesPresent(lng, lat);
}

// ⛔ rtwall:// and rtraw:// must pass through — a blocked "Tile" gets BLANK_PNG and the protobuf parser chokes
const LOCAL_PREFIXES = [
	"blob:",
	"data:",
	"capacitor://",
	"file://",
	"rtwall://",
	"rtraw://",
];
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
// ⚠️ only image requests may get BLANK_PNG — parsed resources (glyphs, tiles, JSON) get "" or Mapbox throws
const IMAGE_RESOURCES = new Set(["Image", "SpriteImage", "Tile"]);
let blockedLogged = 0;

export function v4TransformRequest(
	url: string,
	resourceType?: string,
): { url: string } {
	// ⚠️ root-relative URLs must be absolutised — Mapbox's blob: worker can't resolve them and the tile fetch throws
	if (url.startsWith("/")) {
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
