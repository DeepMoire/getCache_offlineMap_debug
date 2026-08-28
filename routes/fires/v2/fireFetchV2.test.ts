/**
 * fireFetchV2.test.ts — the "must throw, never lie" contract.
 *
 * Every test here defends ONE property: **a failure must never render as
 * "no fires near you"**. That is the single most dangerous thing this layer can
 * say, because it is indistinguishable from a genuine all-clear to the person
 * reading it, and they may be standing in the trees.
 *
 * So the fetch throws on everything it cannot fully validate, and the caller
 * keeps its last good cache. An empty layer is only ever allowed to mean "the
 * Worker looked and found nothing", never "something went wrong".
 *
 * The conditional-GET block at the bottom guards the OTHER half of that rule:
 * a 304 is a SUCCESS and must not be dragged into the failure path, while every
 * genuine failure must keep throwing exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/onPhone/store/downloadGuard", () => ({
	guardPackDownload: vi.fn(),
}));

import { configureTilesHost } from "../../../lib/r2Worker/local_dev/tilesHost";

// The prod tier from lib/r2Worker/TIERS.md. A literal, because the host is
// module state the HOST APP sets at boot — and a child may not import $lib.
const TILES_HOST = "https://tiles-prod.getcache.org";

import { fetchFireDiscV2, type FireFetchV2Result } from "./fireFetchV2";

/**
 * Narrow to the 200 branch, failing loudly if it was a 304.
 *
 * The union is the point — a caller cannot touch `.disc` without narrowing —
 * so the tests narrow the same way real callers must, rather than casting past
 * the type that is doing the work.
 */
function fresh(r: FireFetchV2Result) {
	if (r.notModified) throw new Error("expected a fresh disc, got 304");
	return r;
}

const FC = (features: unknown[] = []) => ({
	type: "FeatureCollection",
	features,
});

const point = (lng: number, lat: number) => ({
	type: "Feature",
	geometry: { type: "Point", coordinates: [lng, lat] },
	properties: { t: 1_800_000_000_000, c: "nominal", frp: 12 },
});

/** A well-formed v2 body. */
const v2Body = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		points: FC([point(-121.78, 49.3)]),
		clusters: FC(),
		outlines: FC(),
		...over,
	});

function mockFetch(
	body: string,
	init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
) {
	// Header lookup is case-insensitive in a real `Headers`, and servers are not
	// obliged to spell it `ETag` — matching that here stops the test passing on
	// an exact-case fluke the network would not reproduce.
	const headers = new Map(
		Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
	);
	const status = init.status ?? 200;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: init.ok ?? (status >= 200 && status < 300),
			status,
			text: async () => body,
			headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
		})),
	);
}

/** The `RequestInit` the code under test passed to `fetch`. */
function lastInit(): { signal?: AbortSignal; headers?: Record<string, string> } {
	return (
		globalThis.fetch as unknown as {
			mock: { calls: [string, { signal?: AbortSignal; headers?: Record<string, string> }][] };
		}
	).mock.calls[0][1];
}

/**
 * THE CHILD HAS NO HOST UNTIL AN APP GIVES IT ONE.
 *
 * getCache_OfflineMap ships with no production origin — `firesUrl()` answers
 * null until `configureTilesHost()` runs, so a stranger installing that AGPL
 * package cannot bill our R2 bucket (see its tilesHost.ts and
 * src/lib/core/childEndpoints.ts). At runtime `src/hooks.client.ts:39` makes
 * that call at boot; a test file has no boot, so it makes it here.
 *
 * Without this, all 24 tests below die on "no tiles host configured" before
 * reaching a single assertion — which is exactly what they did on 27 Aug 2026.
 *
 * In beforeEach, not once at module load: the host is module state inside the
 * child, and `clearMocks`/module resets between files must not be able to
 * leave a later test talking to a null host.
 */
beforeEach(() => {
	configureTilesHost(TILES_HOST);
	vi.unstubAllGlobals();
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a failure THROWS — it never returns an empty layer", () => {
	it("throws on a non-OK response", async () => {
		mockFetch("", { ok: false, status: 503 });
		await expect(fetchFireDiscV2(-121.78, 49.3)).rejects.toThrow("503");
	});

	it("throws on a non-JSON body", async () => {
		mockFetch("<html>gateway timeout</html>");
		await expect(fetchFireDiscV2(-121.78, 49.3)).rejects.toThrow("non-JSON");
	});

	it("throws when the payload has no `points` collection", async () => {
		// A v1 Worker answers ?v=2 with a bare FeatureCollection and no `points`
		// member. Rendering that as empty would be the dangerous lie; failing
		// loudly lets the caller keep its last good cache.
		mockFetch(JSON.stringify(FC([point(-121.78, 49.3)])));
		await expect(fetchFireDiscV2(-121.78, 49.3)).rejects.toThrow("v2 payload");
	});

	it("throws when `points` is present but malformed", async () => {
		mockFetch(JSON.stringify({ points: { type: "Nonsense" } }));
		await expect(fetchFireDiscV2(-121.78, 49.3)).rejects.toThrow("v2 payload");
	});

	it("names the v1-Worker case in the error, so the cause is obvious", async () => {
		mockFetch(JSON.stringify(FC()));
		await expect(fetchFireDiscV2(-121.78, 49.3)).rejects.toThrow(/v1/);
	});
});

describe("a GENUINELY empty disc is allowed — and is not an error", () => {
	it("accepts zero detections when the Worker says so in v2 shape", async () => {
		// "The Worker looked and found nothing" is a legitimate, honest answer.
		// Only a FAILURE must throw; an all-clear must not.
		mockFetch(v2Body({ points: FC() }));
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.pointCount).toBe(0);
	});
});

describe("the stored disc is render-ready and self-describing", () => {
	it("stores the payloads as strings, not objects", async () => {
		mockFetch(v2Body());
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(typeof disc.pointsJson).toBe("string");
		expect(typeof disc.clustersJson).toBe("string");
		expect(typeof disc.outlinesJson).toBe("string");
	});

	it("records the point count without the caller parsing anything", async () => {
		mockFetch(v2Body({ points: FC([point(-121, 49), point(-122, 50)]) }));
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.pointCount).toBe(2);
	});

	it("substitutes an EMPTY collection for a missing clusters/outlines member", async () => {
		// Absent optional members are normal (a disc with no outline-worthy
		// cluster). They become empty collections so `setData` always has
		// something valid — never `undefined`, which would throw at paint.
		mockFetch(v2Body({ clusters: undefined, outlines: undefined }));
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(JSON.parse(disc.clustersJson)).toEqual(FC());
		expect(JSON.parse(disc.outlinesJson)).toEqual(FC());
	});
});

describe("freshness comes from the SERVER's clock", () => {
	it("prefers X-Fetched-At over our own clock", async () => {
		// The edge may serve a cached slice, so our own clock would overstate
		// freshness by up to the cache TTL — the "Last checked" number would lie.
		mockFetch(v2Body(), { headers: { "X-Fetched-At": "1799999999000" } });
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.fetchedAt).toBe(1_799_999_999_000);
	});

	it("falls back to our clock when the header is missing", async () => {
		// The CORS Expose-Headers trap makes a custom header read as null unless
		// explicitly exposed. The route exposes it; don't crash if that changes.
		mockFetch(v2Body());
		const before = Date.now();
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.fetchedAt).toBeGreaterThanOrEqual(before);
	});

	it("carries sourcesOk so the UI can flag degraded coverage", async () => {
		mockFetch(v2Body(), { headers: { "X-Sources-Ok": "2" } });
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.sourcesOk).toBe(2);
	});
});

describe("the request itself", () => {
	it("asks for v2 explicitly", async () => {
		mockFetch(v2Body());
		await fetchFireDiscV2(-121.78, 49.3);
		const url = (globalThis.fetch as unknown as { mock: { calls: string[][] } })
			.mock.calls[0][0];
		expect(url).toContain("v=2");
	});

	it("passes an abort signal — an un-timed fetch is a documented field failure", async () => {
		// A field phone on lie-fi (connected, no throughput) leaves a bare fetch
		// pending forever, stalling the bake pass behind it.
		mockFetch(v2Body());
		await fetchFireDiscV2(-121.78, 49.3);
		expect(lastInit()?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("conditional GET — a 304 is a SUCCESS, not a failure", () => {
	it("resolves (does not throw) on a 304 and reports not-modified", async () => {
		// The whole feature lives or dies on this. `res.ok` is false for 304, so
		// the naive ordering (`if (!res.ok) throw`) would turn the intended happy
		// path into an error — and only ever against a warm edge cache, i.e. never
		// in local testing. The 304 branch must come FIRST.
		mockFetch("", { status: 304 });
		const r = await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(r.notModified).toBe(true);
	});

	it("reports zero bytes for a 304, so the cellular tally stays honest", async () => {
		// A 304 is bodiless. Counting it as a full disc would make the data-usage
		// number report bytes that never crossed the wire.
		mockFetch("", { status: 304 });
		const r = await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		if (r.notModified) expect(r.bytes).toBe(0);
	});

	it("sends If-None-Match when given a stored etag", async () => {
		mockFetch(v2Body());
		await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(lastInit()?.headers?.["If-None-Match"]).toBe('"abc123"');
	});

	it("sends NO If-None-Match when there is no stored etag", async () => {
		// A first fetch after upgrade has no etag. It must go out unconditional —
		// never as `If-None-Match: undefined`, which an intermediary may answer
		// with a 304 we have no stored disc to back.
		mockFetch(v2Body());
		await fetchFireDiscV2(-121.78, 49.3);
		expect(lastInit()?.headers?.["If-None-Match"]).toBeUndefined();
	});

	it("captures the ETag response header on a 200", async () => {
		mockFetch(v2Body(), { headers: { ETag: '"deadbeef"' } });
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.etag).toBe('"deadbeef"');
	});

	it("leaves etag absent when the Worker sends none", async () => {
		// The Worker route may not set ETag yet, and a cross-origin response hides
		// it unless Access-Control-Expose-Headers lists it. Missing must degrade
		// to "ask unconditionally next time", not break the fetch.
		mockFetch(v2Body());
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.etag).toBeUndefined();
	});

	it("still bounds a 304 with the abort signal", async () => {
		// Conditional does not mean unbounded — a 304 that takes 20 s on lie-fi
		// must abort exactly like a 200 would.
		mockFetch("", { status: 304 });
		await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(lastInit()?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("the safety invariant survives the conditional-GET change", () => {
	it("a 500 STILL throws, even with an etag in hand", async () => {
		// The regression this guards: widening "304 is fine" into "any non-2xx is
		// fine". A 5xx must keep throwing so the caller retains its last good
		// cache instead of painting an empty, all-clear-looking map.
		mockFetch("", { status: 500 });
		await expect(
			fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"'),
		).rejects.toThrow("500");
	});

	it("a network error still throws on the conditional path", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await expect(
			fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"'),
		).rejects.toThrow("network down");
	});

	it("a 304 does NOT skip the download circuit-breaker", async () => {
		// The breaker counts attempts, not bytes. A refresh loop spinning on 304s
		// is still a runaway loop and must remain visible to it.
		const { guardPackDownload } = await import(
			"../../../lib/onPhone/store/downloadGuard"
		);
		vi.mocked(guardPackDownload).mockClear();
		mockFetch("", { status: 304 });
		await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(guardPackDownload).toHaveBeenCalledTimes(1);
	});
});
