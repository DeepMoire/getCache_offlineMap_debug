/// <reference lib="webworker" />
// satBakeWorker.ts — the satellite compositor, off the UI thread; falls back to the main thread in satelliteImage.ts where OffscreenCanvas/convertToBlob aren't available.

type TileDraw = { url: string; dx: number; dy: number; dw: number; dh: number };
type BakeReq = { id: number; tiles: TileDraw[]; w: number; h: number };
type BakeRes = { id: number; blob: Blob | null; loaded: number; fetched: number };

// ⚠️ Sized in ENTRIES but the cost is in BYTES (a z14 tile is ~262 KB decoded, a ~37× expansion from its ~7 KB wire size) — if tiles get bigger (z15, @2x, RGBA16) this number must come DOWN, not stay put. 48 × 262 KB ≈ 12 MB.
const CACHE_MAX = 48;
const cache = new Map<string, Promise<ImageBitmap | null>>();

function loadTile(url: string, onFetch: () => void): Promise<ImageBitmap | null> {
	const hit = cache.get(url);
	if (hit) {
		// LRU bump — move to the most-recently-used end.
		cache.delete(url);
		cache.set(url, hit);
		return hit;
	}
	onFetch();
	const p = (async (): Promise<ImageBitmap | null> => {
		try {
			const r = await fetch(url);
			if (!r.ok) return null;
			return await createImageBitmap(await r.blob());
		} catch {
			return null;
		}
	})();
	cache.set(url, p);
	// Don't pin a failure: drop it so a later (online) pass can retry the tile.
	p.then((bm) => {
		if (!bm) cache.delete(url);
	}).catch(() => cache.delete(url));
	// Evict oldest-first with `while`, not `if` — after a cap reduction, `if` only removes one entry and strands the surplus at the old high-water mark forever.
	while (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next().value as string | undefined;
		// Never evict the entry just inserted, and stop if that's all that's left — otherwise the loop could spin forever.
		if (oldest === undefined || oldest === url) break;
		const ev = cache.get(oldest);
		cache.delete(oldest);
		// codestyle-allow-swallow: bitmap cache eviction is best-effort; a close() failure leaves GPU memory until GC, not a data loss
		ev?.then((bm) => bm?.close()).catch(() => {});
	}
	return p;
}

self.onmessage = async (e: MessageEvent<BakeReq>): Promise<void> => {
	const { id, tiles, w, h } = e.data;
	let loaded = 0;
	let fetched = 0;
	const post = (blob: Blob | null): void => {
		const res: BakeRes = { id, blob, loaded, fetched };
		(self as unknown as Worker).postMessage(res);
	};
	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		post(null);
		return;
	}
	// Bounded concurrency, mirroring the main-thread pool (6 in flight).
	const LIMIT = 6;
	let next = 0;
	const work = async (): Promise<void> => {
		while (next < tiles.length) {
			const t = tiles[next++];
			const bm = await loadTile(t.url, () => {
				fetched += 1;
			});
			if (!bm) continue; // gap → transparent → jagged mask
			ctx.drawImage(bm, t.dx, t.dy, t.dw, t.dh);
			loaded += 1;
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(LIMIT, tiles.length) }, () => work()),
	);
	if (!loaded) {
		post(null);
		return;
	}
	try {
		post(await canvas.convertToBlob({ type: "image/webp", quality: 0.75 }));
	} catch {
		post(null);
	}
};

export {};
