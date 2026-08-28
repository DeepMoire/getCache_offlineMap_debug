/**
 * fireFetchV2 — ask the Worker for ONE render-ready disc.
 *
 * ── THE CONTRACT, AND WHY IT IS THE WHOLE POINT ──
 * v1 asked for raw detections and rebuilt geometry on the phone. v2 asks for
 * the finished article: points, clusters and outlines, already deduped, already
 * urban-filtered, already in Mapbox's shape. The phone stores three strings and
 * hands them to `setData()`.
 *
 * That single change is what removes v1's union pass, hull builder, urban
 * classifier, supersede test and five memo layers — not because they were
 * optimized, but because there is no longer any raw data on the phone to run
 * them ON. See the header of `fireCacheV2.ts` for the measurements.
 *
 * ── Two rules carried over from v1 verbatim ──
 * 1. A FAILURE MUST THROW. Returning an empty list on a network error renders
 *    as "no fires near you" — the most dangerous lie this layer can tell. The
 *    caller catches, backs off, and KEEPS the last good cache.
 * 2. NEVER HANG. A field phone on lie-fi (connected, no throughput) leaves a
 *    bare fetch pending forever; un-timed fetches are a documented cause of
 *    past field failures. Hence the explicit AbortController timeout.
 *
 * ── CONDITIONAL GET (`If-None-Match` / 304) ──
 * A disc is ~180 KB gzipped, the phone re-asks every 20 minutes, and the
 * Worker's edge cache holds the same bytes for ~an hour — so most re-asks
 * inside that window transfer a byte-identical payload. Passing the stored
 * disc's `etag` as `lastEtag` turns those into a bodiless 304.
 *
 * A 304 is a THIRD outcome, alongside "fresh disc" and "threw": it is the
 * server affirming the caller's cache is current, which is a stronger freshness
 * statement than a 200, not a weaker one. It is returned as
 * `{ notModified: true }` — see `FireFetchV2Result` for the caller contract and
 * why the discriminant is required rather than optional.
 *
 * Rules 1 and 2 are untouched by this: a 5xx, a network error and a timeout all
 * still throw, and the AbortController still bounds a 304 exactly as it bounds
 * a 200.
 */

import { guardPackDownload } from "../../../lib/onPhone/store/downloadGuard";
import {
	FIRE_V2_RADIUS_KM,
	FIRE_V2_VERSION,
	type FireDiscV2,
} from "./fireCacheV2";

// Was a hardcoded "https://tiles-prod.getcache.org/fires" — a second spelling of
// the host, which is exactly the drift tilesHost.ts exists to prevent (roads
// from staging + fires from production reads as "it works sometimes").
import { firesUrl } from "../../../lib/r2Worker/local_dev/tilesHost";

/**
 * Wall-clock cap for one fetch. Generous enough for a cold Worker doing three
 * upstream NASA calls on a slow link, short enough that a wedged request cannot
 * stall the bake pass queued behind it.
 */
const FIRE_V2_TIMEOUT_MS = 20_000;

/**
 * What the Worker returns for `?v=2`.
 *
 * Every member is ALREADY RENDER-READY. If a future need arises for something
 * derived — a new cluster tier, a different filter — it is added HERE and
 * computed on the Worker. **Do not add a derivation step on the phone.** That
 * is the mistake v1 made once per feature until the layer cost 4 GB.
 */
interface FireV2Payload {
	/** GeoJSON FeatureCollection — individual detections, urban-filtered. */
	points?: unknown;
	/** GeoJSON FeatureCollection — pre-aggregated clusters with `count`. */
	clusters?: unknown;
	/** GeoJSON FeatureCollection — outline polygons. */
	outlines?: unknown;
}

/**
 * A 200 — a fresh disc arrived, replace what you had.
 *
 * `notModified` is a REQUIRED literal, not an optional flag, so a caller cannot
 * reach for `.disc` without first narrowing. See `FireFetchV2Result`.
 */
export interface FireFetchV2Fresh {
	readonly notModified: false;
	readonly disc: FireDiscV2;
	/** Response size, for the cellular-gate tally. */
	readonly bytes: number;
}

/**
 * A 304 — the Worker confirmed the caller's stored disc is still current.
 *
 * ⚠️ THIS IS A SUCCESS, NOT AN ERROR. It is the strongest possible statement
 * about freshness: the server looked and said "what you hold is what I have".
 * Never route it through the failure path.
 */
export interface FireFetchV2NotModified {
	readonly notModified: true;
	/** A 304 is bodiless; the headers are all that crossed the wire. */
	readonly bytes: 0;
}

/**
 * ── THE CALLER CONTRACT ──
 * A discriminated union on a REQUIRED boolean, deliberately. An optional
 * `disc?` field would let a caller write `result.disc.pointsJson` and get a
 * runtime crash on the 304 path — the branch that, by definition, only shows up
 * against a warm edge cache and would therefore sail through local testing.
 * Here TypeScript refuses to compile that.
 *
 * The intended shape when this is wired (no caller exists yet):
 *
 * ```ts
 * const stored = await readFireDisc(key);
 * const r = await fetchFireDiscV2(lng, lat, radiusKm, stored?.etag);
 * if (r.notModified) {
 *   // Our copy is confirmed current. Touch fetchedAt ONLY — never rewrite the
 *   // payload, and never invent a new one. `stored` is non-null here because
 *   // an etag was only sent if we had one to send.
 *   await writeFireDisc(key, { ...stored!, fetchedAt: Date.now() });
 * } else {
 *   await writeFireDisc(key, r.disc);
 * }
 * ```
 *
 * Touching `fetchedAt` on a 304 is what makes the TTL mean "confirmed current"
 * rather than "last time bytes moved" — without it a stable disc would re-ask
 * on every single pass forever, which is the opposite of the point.
 */
export type FireFetchV2Result = FireFetchV2Fresh | FireFetchV2NotModified;

/** A FeatureCollection with a countable `features` array, or null. */
function asCollection(v: unknown): { features: unknown[] } | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as { type?: unknown; features?: unknown };
	if (o.type !== "FeatureCollection" || !Array.isArray(o.features)) return null;
	return { features: o.features };
}

const EMPTY_FC = '{"type":"FeatureCollection","features":[]}';

/**
 * Fetch one disc. Throws on any failure (rule 1 above).
 *
 * `guardPackDownload` is the same session circuit-breaker the tile downloader
 * trips against, so a runaway bake loop cannot hammer this endpoint either.
 *
 * ⚠️ The breaker LATCHES for the session once tripped — every later call
 * rethrows without attempting anything. Treat that error as TERMINAL, never as
 * "retry next pass": doing so in v1 flooded the console and pinned the heap.
 * See the `latched-breaker-is-terminal-not-retryable` memory.
 */
export async function fetchFireDiscV2(
	lng: number,
	lat: number,
	radiusKm: number = FIRE_V2_RADIUS_KM,
	lastEtag?: string,
): Promise<FireFetchV2Result> {
	// The breaker counts ATTEMPTS, not bytes. A 304 is a request we made and the
	// Worker served, so it belongs in the tally exactly like a 200 — a refresh
	// loop that spun on 304s would otherwise be invisible to the circuit-breaker.
	guardPackDownload({ route: "fires", lng, lat, km: radiusKm });

	// NO HOST, NO REQUEST. firesUrl() answers null until configureTilesHost()
	// has run (hooks.client.ts does it at boot). Interpolating null would fetch
	// the literal "null?lng=..." against the current origin — a 404 that reads
	// as "fires are broken" rather than "boot did not configure the worker".
	const firesEndpoint = firesUrl();
	if (firesEndpoint === null) {
		throw new Error(
			"no tiles host configured — configureTilesHost() must run before fetching fires.",
		);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FIRE_V2_TIMEOUT_MS);
	let res: Response;
	let text: string;
	try {
		res = await fetch(
			`${firesEndpoint}?lng=${lng}&lat=${lat}&km=${Math.round(radiusKm)}&v=2`,
			{
				signal: controller.signal,
				// Only sent when we actually hold an etag. An empty/absent value must
				// never become `If-None-Match: undefined`, which some intermediaries
				// answer with a spurious 304 — and a 304 we cannot back with a stored
				// disc is unrecoverable at the caller.
				...(lastEtag ? { headers: { "If-None-Match": lastEtag } } : {}),
			},
		);
		// ⚠️ ORDER MATTERS: 304 BEFORE the !res.ok guard.
		// `res.ok` is only true for 200–299, so a 304 fails it. Checking `ok` first
		// would turn the success case this whole feature exists to produce into a
		// thrown error — and one that only appears against a warm edge cache.
		if (res.status === 304) return { notModified: true, bytes: 0 };
		if (!res.ok) throw new Error(`fires endpoint responded ${res.status}`);
		text = await res.text();
	} finally {
		// Runs on the 304 return too — the timeout is cleared on EVERY exit path.
		// A 304 that takes 20 s still aborts; conditional does not mean unbounded.
		clearTimeout(timer);
	}

	let parsed: FireV2Payload;
	try {
		parsed = JSON.parse(text) as FireV2Payload;
	} catch {
		throw new Error("fires endpoint returned a non-JSON body");
	}

	const points = asCollection(parsed.points);
	if (!points) {
		// A v1 Worker answers `?v=2` with a bare FeatureCollection and no `points`
		// member. Fail LOUDLY rather than rendering an empty layer, because an
		// empty fire layer is indistinguishable from "no fires near you" — see
		// the `no-silent-fallbacks` memory. The caller keeps its last good cache.
		throw new Error(
			"fires endpoint did not return a v2 payload (no `points` FeatureCollection) — " +
				"the Worker is likely still on v1; v2 requires the render-ready route",
		);
	}
	const clusters = asCollection(parsed.clusters);
	const outlines = asCollection(parsed.outlines);

	// Prefer the server's stamp; fall back to ours only if the header is missing.
	// A custom header reads as null unless the route exposes it — the CORS
	// Expose-Headers trap. The route does expose it; don't crash if it stops.
	const headerAt = Number(res.headers.get("X-Fetched-At"));
	const sourcesOk = Number(res.headers.get("X-Sources-Ok"));
	// `ETag` is a standard response header, so it needs no Expose-Headers entry
	// for same-origin — but this is CROSS-origin (tiles-prod.getcache.org), and the
	// CORS-safelist covers request headers, not response ones. It reads as null
	// unless the route lists it in Access-Control-Expose-Headers, the same trap
	// X-Fetched-At sits behind. Missing simply means "no conditional GET next
	// time", which degrades to today's behaviour rather than breaking.
	const etag = res.headers.get("ETag") ?? undefined;

	return {
		notModified: false,
		bytes: text.length,
		disc: {
			version: FIRE_V2_VERSION,
			fetchedAt:
				Number.isFinite(headerAt) && headerAt > 0 ? headerAt : Date.now(),
			center: [lng, lat],
			radiusKm,
			sourcesOk: Number.isFinite(sourcesOk) && sourcesOk > 0 ? sourcesOk : 3,
			// Re-serialized from the PARSED members, never sliced out of `text`:
			// the phone must store exactly what it will hand to `setData()`, and a
			// substring of the original body could carry members we never validated.
			pointsJson: JSON.stringify(parsed.points),
			clustersJson: clusters ? JSON.stringify(parsed.clusters) : EMPTY_FC,
			outlinesJson: outlines ? JSON.stringify(parsed.outlines) : EMPTY_FC,
			pointCount: points.features.length,
			// Stored so the NEXT fetch for this disc can be conditional. Spread so
			// the key is absent (not `undefined`) when the Worker sent no ETag —
			// IndexedDB round-trips an explicit `undefined`, and `{...stored}` would
			// then carry a dead key forward.
			...(etag ? { etag } : {}),
		},
	};
}
