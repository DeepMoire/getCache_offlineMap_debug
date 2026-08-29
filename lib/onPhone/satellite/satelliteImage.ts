import {
	guardBakeGrid,
	noteSatelliteTiles,
} from "../store/downloadGuard";
import { kmBetween, kmToDegSpan } from "../../shared/kmGeo";
import { migrateIdbDatabase } from "../store/idbRename";
import { makeKeyedIdbStore } from "../store/keyedIdbStore";

/** EOX Sentinel-2 (s2cloudless), `{z}/{y}/{x}` order. */
function satelliteTileUrl(z: number, x: number, y: number): string {
	return `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`;
}

/** z14 is EOX Sentinel-2's sharp ceiling (~10 m/px) — z15 only upsamples into blur, verified; don't raise it. */
const BAKE_ZOOM = 14;

/** Imagery tiles fetched at once. See the pool call for why 16, not 6 or 60. */
const SAT_FETCH_CONCURRENCY = 16;
/** Satellite-photo radius (km); exported so the offline page can space LINE samples to keep discs overlapping into a continuous ribbon. */
export const BAKE_RADIUS_KM = 2;
/** Canvas width in px — the fixed photo resolution (image only ever scales); 1536 keeps it crisp without a huge blob. */
const CANVAS_W = 1536;

const DB_NAME = "gc-offlineSatellite";
const STORE = "images";
if (typeof indexedDB !== "undefined") {
	// Chain, don't fire both — two concurrent writers into one destination race; the newer name must win.
	void migrateIdbDatabase("retreever-v3-satimg", "rt-satellite", STORE).then(
		() => migrateIdbDatabase("rt-satellite", DB_NAME, STORE),
	);
}

export type Bounds = [number, number, number, number]; // [w,s,e,n]

/** Geometry stamp — BUMP whenever bake geometry changes (radius/zoom/canvas/mercator math) or a stale mis-bounded photo stays pinned forever, never healing. */
export const BAKE_VERSION = 6; // 6 = PIN-CENTRED CROP — this bump triggers a fleet-wide re-bake (expect an EOX rate-limit backoff).

export interface SatImage {
	blob: Blob;
	bounds: Bounds;
	/** See BAKE_VERSION. Absent on legacy records → treated as stale → re-bake. */
	bakeVersion?: number;
}

const idb = makeKeyedIdbStore<SatImage>({ dbName: DB_NAME, storeName: STORE });

/** Delete one area's baked photo (budget eviction). */
export async function deleteSatImage(key: string): Promise<void> {
	await idb.delete(key);
}

/** PURE READ — NEVER bakes, NEVER touches the network; a stale-geometry photo (bakeVersion ≠ current) is treated as absent, not mounted mis-bounded. */
export async function getSatImageByKey(
	key: string,
): Promise<SatImage | undefined> {
	const img = await idb.get(key);
	return img && img.bakeVersion === BAKE_VERSION ? img : undefined;
}

// NOTE: size readout comes from coverageRegistry.ts's coverageSizes, NOT the blobs — do NOT poll a stats fn that loads every baked photo on a timer.

/**
 * Every stored area's image — FULL BLOBS. On-demand Download button ONLY.
 *
 * ⚠️ Materialises every baked photo in the heap at once — never call this on a timer (measured 613 MB / 97.3% of allocation, OOM-crashed the tab). Use satImageMeta() for sizes/versions instead.
 *
 * codestyle-allow-blob-getall: admin /blobs export, one click — never a timer.
 */
export async function getAllSatImages(): Promise<{ key: string; img: SatImage }[]> {
	const [keys, vals] = await Promise.all([idb.keys(), idb.getAll()]);
	return keys.map((k, i) => ({ key: k, img: vals[i] }));
}

/** Per-area photo METADATA (size + bake version, never pixels) — cursor-streamed via getAllProjected so peak heap is one photo, not all of them. */
export async function satImageMeta(): Promise<
	{ key: string; bytes: number; bakeVersion?: number }[]
> {
	const [keys, meta] = await Promise.all([
		idb.keys(),
		idb.getAllProjected((v) => ({
			bytes: v.blob.size,
			bakeVersion: v.bakeVersion,
		})),
	]);
	return keys.map((k, i) => ({ key: k, ...meta[i] }));
}
/** Every stored area key (keys only, no blobs) — used by the reconcile's orphan sweep: a stored key with no registry record is stale. */
export async function getSatKeys(): Promise<string[]> {
	return idb.keys();
}

/** A stable key for an area centre. */
export function satImageKey(c: [number, number]): string {
	return `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
}

function lngToTileX(lng: number, z: number): number {
	return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
	const r = (lat * Math.PI) / 180;
	return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}
function tileToLng(x: number, z: number): number {
	return (x / 2 ** z) * 360 - 180;
}
function tileToLat(y: number, z: number): number {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function loadImage(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		// Same 20s lie-fi budget as fetch — <img> has no AbortSignal, so timeout via timer; late onload/onerror is a no-op.
		const timer = setTimeout(() => resolve(null), 20_000);
		img.crossOrigin = "anonymous";
		img.onload = () => {
			clearTimeout(timer);
			resolve(img);
		};
		img.onerror = () => {
			clearTimeout(timer);
			resolve(null);
		};
		img.src = url;
	});
}
async function pool(n: number, limit: number, fn: (i: number) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < n) {
			const i = next++;
			await fn(i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}

type TileSrc = ImageBitmap | HTMLImageElement;
/** Decoded-tile cap for the MAIN-THREAD fallback — must track the worker's CACHE_MAX (satBakeWorker.ts): same 262 KB/tile cost, sized in entries not bytes. 48 × 262 KB ≈ 12 MB. */
const TILE_CACHE_MAX = 48;
const tileCache = new Map<string, Promise<TileSrc | null>>();
function loadTileBitmap(url: string): Promise<TileSrc | null> {
	const hit = tileCache.get(url);
	if (hit) {
		tileCache.delete(url);
		tileCache.set(url, hit); // LRU bump
		return hit;
	}
	const p = (async (): Promise<TileSrc | null> => {
		try {
			if (typeof createImageBitmap === "function") {
				// LIE-FI GUARD: abort a hung tile at 20s — without it a stalled tile pins the connection for the full TCP timeout (30–75s); TimeoutError lands here as null → gap, never an unhandled rejection.
				const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
				if (!r.ok) return null;
				return await createImageBitmap(await r.blob());
			}
			return await loadImage(url);
		} catch {
			return null;
		}
	})();
	tileCache.set(url, p);
	p.then((v) => {
		if (!v) tileCache.delete(url);
	}).catch(() => tileCache.delete(url));
	// Drain oldest-first with `while`, not `if` — an `if` can't shrink an already-over cache and strands the surplus forever. Mirrors the worker's loop.
	while (tileCache.size > TILE_CACHE_MAX) {
		const oldest = tileCache.keys().next().value as string | undefined;
		if (oldest === undefined || oldest === url) break;
		const ev = tileCache.get(oldest);
		tileCache.delete(oldest);
		ev?.then((v) => {
			if (v && "close" in v) v.close();
		// codestyle-allow-swallow: bitmap cache eviction is best-effort; close() failure leaves GPU memory until GC, not a data loss
		}).catch(() => { /* best-effort eviction */ });
	}
	return p;
}

type TileDraw = { url: string; dx: number; dy: number; dw: number; dh: number };
type BakeRes = { id: number; blob: Blob | null; loaded: number; fetched: number };
let bakeWorker: Worker | null = null;
let workerBroken = false;
let reqId = 0;
const pendingBakes = new Map<number, (r: BakeRes) => void>();

/** True when we can composite off the UI thread (Worker + OffscreenCanvas + convertToBlob + createImageBitmap); else the main-thread fallback runs. */
function offscreenSupported(): boolean {
	return (
		typeof Worker !== "undefined" &&
		typeof OffscreenCanvas !== "undefined" &&
		typeof createImageBitmap === "function" &&
		typeof OffscreenCanvas.prototype.convertToBlob === "function"
	);
}

function getBakeWorker(): Worker | null {
	if (workerBroken) return null;
	if (bakeWorker) return bakeWorker;
	try {
		bakeWorker = new Worker(new URL("./satBakeWorker.ts", import.meta.url), {
			type: "module",
		});
		bakeWorker.onmessage = (e: MessageEvent<BakeRes>) => {
			const cb = pendingBakes.get(e.data.id);
			if (cb) {
				pendingBakes.delete(e.data.id);
				cb(e.data);
			}
		};
		bakeWorker.onerror = () => {
			workerBroken = true;
			bakeWorker = null;
		};
		return bakeWorker;
	} catch {
		workerBroken = true;
		return null;
	}
}

/** Composite in the worker; resolves null if the worker is unavailable or hangs (caller falls back to the main thread). */
function compositeInWorker(
	tiles: TileDraw[],
	w: number,
	h: number,
): Promise<BakeRes | null> {
	const wk = getBakeWorker();
	if (!wk) return Promise.resolve(null);
	const id = ++reqId;
	return new Promise<BakeRes | null>((resolve) => {
		pendingBakes.set(id, resolve);
		// Safety net: a wedged worker must never strand a bake — fall back after 30s.
		const timer = setTimeout(() => {
			if (pendingBakes.has(id)) {
				pendingBakes.delete(id);
				resolve(null);
			}
		}, 30000);
		const done = pendingBakes.get(id);
		if (done) {
			pendingBakes.set(id, (r) => {
				clearTimeout(timer);
				resolve(r);
			});
		}
		wk.postMessage({ id, tiles, w, h });
	}).finally(() => {
		scheduleBakeWorkerTeardown();
	});
}

/** Retire the idle bake worker (frees its heap — decoded tiles + canvases) and respawn lazily next bake. ⚠️ Leave `bakeWorker = null` here — do NOT set `workerBroken`, which would disable the worker for the whole session. */
const BAKE_WORKER_IDLE_MS = 30_000;
let bakeTeardownTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleBakeWorkerTeardown(): void {
	clearTimeout(bakeTeardownTimer);
	bakeTeardownTimer = setTimeout(() => {
		// A bake still in flight owns a resolver only the worker can call — terminating now would strand it until the 30s timeout; re-arm instead.
		if (pendingBakes.size > 0) {
			scheduleBakeWorkerTeardown();
			return;
		}
		if (bakeWorker) {
			bakeWorker.terminate();
			bakeWorker = null;
		}
	}, BAKE_WORKER_IDLE_MS);
}

/** Bake the masked satellite photo for a centre (idempotent). Fast path: OffscreenCanvas worker; fallback: main-thread canvas (older iOS). Returns null only if no tiles loaded. */
export async function bakeSatelliteImage(
	center: [number, number],
): Promise<SatImage | null> {
	const key = satImageKey(center);
	const existing = await idb.get(key);
	// Serve the cache ONLY when its geometry stamp is current — a stale photo (older bounds math) renders clipped to a fraction, so it's a MISS → re-bake.
	if (existing && existing.bakeVersion === BAKE_VERSION) return existing;
	// OFFLINE: skip re-bake — every tile fetch would fail and trip the session breaker (within ~30 min of airplane-mode use); keep showing a stale photo (better than blank) for the next ONLINE reconcile to heal.
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		return existing ?? null;

	const [clng, clat] = center;
	const z = BAKE_ZOOM;
	const { dLat, dLng } = kmToDegSpan(BAKE_RADIUS_KM, clat);
	const xMin = lngToTileX(clng - dLng, z);
	const xMax = lngToTileX(clng + dLng, z);
	const yMin = latToTileY(clat + dLat, z);
	const yMax = latToTileY(clat - dLat, z);

	// Circular tile set → jagged DISC, not a square.
	const tileGeo: { x: number; y: number; w: number; e: number; n: number; s: number }[] = [];
	for (let x = xMin; x <= xMax; x++) {
		for (let y = yMin; y <= yMax; y++) {
			const w = tileToLng(x, z);
			const e = tileToLng(x + 1, z);
			const n = tileToLat(y, z);
			const s = tileToLat(y + 1, z);
			const cx = Math.min(Math.max(clng, w), e);
			const cy = Math.min(Math.max(clat, s), n);
			if (kmBetween([clng, clat], [cx, cy]) > BAKE_RADIUS_KM) continue;
			tileGeo.push({ x, y, w, e, n, s });
		}
	}
	if (!tileGeo.length) return null;

	// HARD GUARD before fetching a byte: an absurd grid (huge area / bad coordinate) trips the circuit breaker NOW — stops cold + alerts Sentry, never racks up data.
	guardBakeGrid(tileGeo.length, { center, z, radiusKm: BAKE_RADIUS_KM });

	// Canvas spans the tile-set bbox in web-mercator Y (tiles sit square); loop instead of Math.min(...spread) — a spread over the tile list trips the arg-spread guard's RangeError check.
	let bw = Infinity;
	let be = -Infinity;
	let bn = -Infinity;
	let bs = Infinity;
	for (const t of tileGeo) {
		if (t.w < bw) bw = t.w;
		if (t.e > be) be = t.e;
		if (t.n > bn) bn = t.n;
		if (t.s < bs) bs = t.s;
	}
	// ⛔ Tile-grid bounds (bw/bs/be/bn) snap the pin off-centre inside the grid — the canvas must be CROPPED to the pin's own box, not stored as the raw tile union.
	// ⚠️ THE BOUNDS AND THE PIXELS MUST SHRINK TOGETHER — both derive from cw/cs/ce/cn below; shrinking only `bounds` squashes the image.
	const span = kmToDegSpan(BAKE_RADIUS_KM, clat);
	const cw = Math.max(bw, clng - span.dLng);
	const ce = Math.min(be, clng + span.dLng);
	const cs = Math.max(bs, clat - span.dLat);
	const cn = Math.min(bn, clat + span.dLat);

	const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
	const yTop = mercY(cn);
	const yExt = yTop - mercY(cs);
	const xExt = ((ce - cw) * Math.PI) / 180;
	const W = CANVAS_W;
	const H = Math.max(1, Math.round((W * yExt) / xExt));

	// Pre-compute pixel positions for every tile (same coords for worker + fallback).
	const xf = (lng: number) => (((lng - cw) * Math.PI) / 180 / xExt) * W;
	const yf = (lat: number) => ((yTop - mercY(lat)) / yExt) * H;
	const tileDraw: TileDraw[] = tileGeo.map((t) => {
		const dx = Math.floor(xf(t.w));
		const dy = Math.floor(yf(t.n));
		return {
			url: satelliteTileUrl(z, t.x, t.y),
			dx,
			dy,
			// Snap to whole px + round size up 1 px so adjacent tiles overlap (no plaid).
			dw: Math.ceil(xf(t.e) - dx) + 1,
			dh: Math.ceil(yf(t.s) - dy) + 1,
		};
	});

	let blob: Blob | null = null;
	let fetched = 0;
	let loaded = 0; // how many of the disc's tiles actually drew onto the canvas

	if (offscreenSupported()) {
		const res = await compositeInWorker(tileDraw, W, H);
		if (res?.blob) {
			blob = res.blob;
			fetched = res.fetched;
			loaded = res.loaded;
		}
	}

	if (!blob) {
		const canvas = document.createElement("canvas");
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		let mtFetched = 0;
		// ⚠️ 16 is chosen against Chrome's per-host/HTTP2 ceiling — raising it much further risks EOX throttling (30s–15min backoff) and starves the concurrent roads download sharing this connection.
		await pool(tileDraw.length, SAT_FETCH_CONCURRENCY, async (i) => {
			const t = tileDraw[i];
			// Check before calling so we know if this URL was already decoded.
			const wasCached = tileCache.has(t.url);
			const src = await loadTileBitmap(t.url);
			if (!src) return; // gap → transparent → jagged mask
			if (!wasCached) mtFetched += 1;
			ctx.drawImage(src, t.dx, t.dy, t.dw, t.dh);
			loaded += 1;
		});
		if (!loaded) return null;
		// WEBP, not PNG or JPEG — must keep the alpha channel for the jagged mask (LAW 2); WebP cuts the blob ~70% vs PNG. Older iOS WKWebView (<17) silently falls back to PNG, which is fine (blob.type stays honest).
		blob = await new Promise<Blob | null>((res) =>
			canvas.toBlob((b) => res(b), "image/webp", 0.75),
		);
		fetched = mtFetched;
	}

	if (!blob) return null;

	// COVERAGE GUARD: do NOT store a mostly-empty disc as "the satellite" — <40% of the disc drawn means a failed/throttled fetch, not a legitimate photo, so the bake fails and the reconcile retries later instead of poisoning the area.
	const minTiles = Math.max(1, Math.ceil(tileGeo.length * 0.4));
	if (loaded < minTiles) return existing ?? null;

	// Charge only REAL network fetches against the session download guard, not total tile count — the shared cache means reused tiles don't touch the network, so counting them overstates cost.
	if (fetched > 0) noteSatelliteTiles(fetched);
	// The bounds are the CROP box — the same box the pixels were drawn into.
	const out: SatImage = { blob, bounds: [cw, cs, ce, cn], bakeVersion: BAKE_VERSION };
	await idb.put(key, out);
	return out;
}
