// ⛔ NO NETWORK HERE — fetch is stubbed; this measures OUR orchestration only, not the server's build time.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cellTileKey, cellsFor } from "../../../contract/grid";

/** A minimal valid pack: [uint32 manifestLen][manifest JSON][tile bytes]. */
function makePack(key: string, body = new Uint8Array([1, 2, 3])): Uint8Array {
	const manifest = JSON.stringify({
		total: 1,
		empty: 0,
		tiles: [{ k: key, n: body.length }],
	});
	const mb = new TextEncoder().encode(manifest);
	const out = new Uint8Array(4 + mb.length + body.length);
	new DataView(out.buffer).setUint32(0, mb.length, true);
	out.set(mb, 4);
	out.set(body, 4 + mb.length);
	return out;
}

/** Gzip a buffer — the client gunzips the pack at the application layer. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const cs = new CompressionStream("gzip");
	const stream = new Blob([bytes]).stream().pipeThrough(cs);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ANCHOR: [number, number] = [-111.939, 44.4744];
/** The key the stubbed Worker ships the blob under. */
const PACK_KEY = "8/48/92";

let urls: string[] = [];
/** Resolvers for in-flight fetches, so we can observe CONCURRENCY. */
let gate: Array<() => void> = [];

beforeEach(async () => {
	urls = [];
	gate = [];
	// A host must be configured or there's no request to observe (configureTilesHost) — imported dynamically because afterEach's vi.resetModules() would otherwise leave a stale copy holding the config.
	const { configureTilesHost } = await import("../tilesHost");
	configureTilesHost("https://tiles.example.test");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(String(url));
			// hold every request open until released, so the parallel assertion below can see them all in flight at once.
			await new Promise<void>((r) => gate.push(r));
			const key = PACK_KEY;
			return new Response(await gzip(makePack(key)), {
				status: 200,
				headers: { "x-pack-build": "test", "x-pack-cache": "MISS" },
			});
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

/** Let every currently-queued fetch finish. */
function releaseAll(): void {
	for (const r of gate.splice(0)) r();
}

describe("are the blobs coming?", () => {
	it("⛔ ONE PIN = ONE REQUEST — never a fragment", async () => {
		// THE LAW: one request per pin — per-cell fetches produced disconnected fragments and could latch the download guard after ~7 pins.
		const { downloadV4Area } = await import("./packDownload");
		const p = downloadV4Area(...ANCHOR);
		await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
		releaseAll();
		await p;
		expect(urls.length).toBe(1);
	});

	it("the request carries the pin's own coordinates", async () => {
		// the Worker reads the radius around the PIN, not a rounded cell centre — that would shift the data off the user.
		const { downloadV4Area } = await import("./packDownload");
		const p = downloadV4Area(...ANCHOR);
		await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
		releaseAll();
		await p;
		expect(urls[0]).toContain("lng=");
		expect(urls[0]).toContain("lat=");
		expect(urls[0]).toContain("pv=");
	});

	it("stores what came back, under the key the Worker chose", async () => {
		// bytes on disk under the address the renderer asks for — if this drifts, the map goes blank with no error anywhere.
		const { downloadV4Area, getAllTileKeys } = await import(
			"./packDownload"
		);
		const p = downloadV4Area(...ANCHOR);
		await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0));
		releaseAll();
		const res = await p;
		expect(res.downloaded).toBe(1);
		expect(await getAllTileKeys()).toContain(PACK_KEY);
	});

	it("a failed request does NOT throw the pass away", async () => {
		// a network hiccup must leave the area un-recorded so the next pass retries — never abort the whole reconcile and starve every area behind it.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network hiccup");
			}),
		);
		const { downloadV4Area } = await import("./packDownload");
		await expect(downloadV4Area(...ANCHOR)).rejects.toThrow();
	});
});
