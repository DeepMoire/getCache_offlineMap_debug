/**
 * ⚠️ a failure must always throw — an empty/silent result reads as "no fires near you", the most dangerous lie this layer can tell; a 304 is a SUCCESS and must never be routed through the failure path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/onPhone/store/downloadGuard", () => ({
	guardPackDownload: vi.fn(),
}));

import { configureTilesHost } from "../../../lib/worker/worker-local-dev/tilesHost";

// literal, not imported — host is module state set at boot, and a child may not import $lib.
const TILES_HOST = "https://tiles-prod.getcache.org";

import { fetchFireDiscV2, type FireFetchV2Result } from "./fireFetchV2";

/** Narrows to the 200 branch, throwing loudly if it was a 304. */
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
	// header lookup must be case-insensitive — servers aren't obliged to spell it "ETag", and an exact-case match would pass on a fluke the network wouldn't reproduce.
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

// must run in beforeEach, not once at module load — without it every test below dies on "no tiles host configured" (real 27 Aug 2026 failure), and module resets between files could leave a later test with a null host.
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
		// a v1 Worker answers ?v=2 with a bare FeatureCollection and no points member — rendering that as empty would be the dangerous lie.
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
		// "the Worker looked and found nothing" is a legitimate answer — only a FAILURE must throw, never a genuine all-clear.
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
		// absent clusters/outlines become empty collections so setData always gets something valid — never undefined, which would throw at paint.
		mockFetch(v2Body({ clusters: undefined, outlines: undefined }));
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(JSON.parse(disc.clustersJson)).toEqual(FC());
		expect(JSON.parse(disc.outlinesJson)).toEqual(FC());
	});
});

describe("freshness comes from the SERVER's clock", () => {
	it("prefers X-Fetched-At over our own clock", async () => {
		// the edge may serve a cached slice — our own clock would overstate freshness by up to the cache TTL, so the "Last checked" number would lie.
		mockFetch(v2Body(), { headers: { "X-Fetched-At": "1799999999000" } });
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.fetchedAt).toBe(1_799_999_999_000);
	});

	it("falls back to our clock when the header is missing", async () => {
		// CORS Expose-Headers trap: a custom header reads as null unless explicitly exposed; route exposes it today, don't crash if that changes.
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
		// a field phone on lie-fi leaves a bare fetch pending forever, stalling the bake pass behind it.
		mockFetch(v2Body());
		await fetchFireDiscV2(-121.78, 49.3);
		expect(lastInit()?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("conditional GET — a 304 is a SUCCESS, not a failure", () => {
	it("resolves (does not throw) on a 304 and reports not-modified", async () => {
		// res.ok is false for a 304 — the naive "if (!res.ok) throw" ordering would turn the happy path into an error, and only against a warm edge cache, so never in local testing. The 304 branch must come FIRST.
		mockFetch("", { status: 304 });
		const r = await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(r.notModified).toBe(true);
	});

	it("reports zero bytes for a 304, so the cellular tally stays honest", async () => {
		// a 304 is bodiless — counting it as a full disc would make the data-usage number report bytes that never crossed the wire.
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
		// a first fetch after upgrade has no etag — it must go out unconditional, never as If-None-Match: undefined, which an intermediary may answer with a 304 we can't back.
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
		// a cross-origin response hides ETag unless Access-Control-Expose-Headers lists it — missing must degrade to "ask unconditionally next time", not break the fetch.
		mockFetch(v2Body());
		const { disc } = fresh(await fetchFireDiscV2(-121.78, 49.3));
		expect(disc.etag).toBeUndefined();
	});

	it("still bounds a 304 with the abort signal", async () => {
		// conditional does not mean unbounded — a 304 that takes 20s on lie-fi must abort exactly like a 200 would.
		mockFetch("", { status: 304 });
		await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(lastInit()?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("the safety invariant survives the conditional-GET change", () => {
	it("a 500 STILL throws, even with an etag in hand", async () => {
		// guards against widening "304 is fine" into "any non-2xx is fine" — a 5xx must keep throwing so the caller keeps its last good cache instead of painting an empty all-clear map.
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
		// the breaker counts attempts, not bytes — a refresh loop spinning on 304s is still a runaway loop and must stay visible to it.
		const { guardPackDownload } = await import(
			"../../../lib/onPhone/store/downloadGuard"
		);
		vi.mocked(guardPackDownload).mockClear();
		mockFetch("", { status: 304 });
		await fetchFireDiscV2(-121.78, 49.3, 500, '"abc123"');
		expect(guardPackDownload).toHaveBeenCalledTimes(1);
	});
});
