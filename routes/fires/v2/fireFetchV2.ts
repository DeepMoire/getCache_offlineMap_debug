/**
 * fireFetchV2 — asks the Worker for ONE render-ready disc; the phone stores the three strings and hands them straight to setData().
 *
 * ⚠️ A FAILURE MUST THROW — returning an empty list on a network error renders as "no fires near you", the most dangerous lie this layer can tell; the caller keeps its last good cache.
 * ⚠️ NEVER HANG — a field phone on lie-fi leaves a bare fetch pending forever, hence the explicit AbortController timeout.
 * A 304 is a THIRD outcome (`{ notModified: true }`), not a failure — see `FireFetchV2Result`.
 */

import { guardPackDownload } from "../../../lib/onPhone/store/downloadGuard";
import {
	FIRE_V2_RADIUS_KM,
	FIRE_V2_VERSION,
	type FireDiscV2,
} from "./fireCacheV2";

// don't hardcode the host — a second spelling is exactly the drift tilesHost.ts prevents (roads from staging + fires from prod reads as "it works sometimes").
import { firesUrl } from "../../../lib/r2Worker/local_dev/tilesHost";

/** Wall-clock cap for one fetch — generous for a cold Worker on a slow link, short enough a wedged request can't stall the queue behind it. */
const FIRE_V2_TIMEOUT_MS = 20_000;

/** What the Worker returns for ?v=2 — every member is already render-ready. ⚠️ Do not add a derivation step on the phone; that's the mistake v1 made until the layer cost 4 GB. */
interface FireV2Payload {
	/** GeoJSON FeatureCollection — individual detections, urban-filtered. */
	points?: unknown;
	/** GeoJSON FeatureCollection — pre-aggregated clusters with `count`. */
	clusters?: unknown;
	/** GeoJSON FeatureCollection — outline polygons. */
	outlines?: unknown;
}

/** A 200 — a fresh disc arrived, replace what you had. */
export interface FireFetchV2Fresh {
	readonly notModified: false;
	readonly disc: FireDiscV2;
	/** Response size, for the cellular-gate tally. */
	readonly bytes: number;
}

/** A 304 — the Worker confirmed the caller's stored disc is still current. ⚠️ This is a SUCCESS, not an error — never route it through the failure path. */
export interface FireFetchV2NotModified {
	readonly notModified: true;
	/** A 304 is bodiless; the headers are all that crossed the wire. */
	readonly bytes: 0;
}

/**
 * ⚠️ `notModified` is a required literal, not optional — an optional `disc?` would let a caller write `result.disc.pointsJson` and crash only on the 304 path, which only surfaces against a warm edge cache and would sail through local testing.
 * ⚠️ On notModified, callers must touch `fetchedAt` only — never rewrite or invent the payload — otherwise a stable disc re-asks on every pass forever.
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
 * Fetches one disc; throws on any failure.
 *
 * ⚠️ The breaker LATCHES for the session once tripped — every later call rethrows without attempting anything; treat that as TERMINAL, never "retry next pass" (v1 flooded the console and pinned the heap doing so).
 */
export async function fetchFireDiscV2(
	lng: number,
	lat: number,
	radiusKm: number = FIRE_V2_RADIUS_KM,
	lastEtag?: string,
): Promise<FireFetchV2Result> {
	// counts ATTEMPTS not bytes — a 304 still counts, or a refresh loop spinning on 304s would be invisible to the circuit-breaker.
	guardPackDownload({ route: "fires", lng, lat, km: radiusKm });

	// NO HOST, NO REQUEST — firesUrl() is null until configureTilesHost() runs at boot; interpolating null would fetch the literal "null?lng=..." and read as "fires are broken" instead of "boot didn't configure the worker".
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
				// only sent when we hold an etag — must never become If-None-Match: undefined, which some intermediaries answer with a spurious 304 we can't back.
				...(lastEtag ? { headers: { "If-None-Match": lastEtag } } : {}),
			},
		);
		// ⚠️ ORDER MATTERS: 304 must be checked BEFORE !res.ok — res.ok is false for 304, so checking ok first would turn the success case into a thrown error that only appears against a warm edge cache.
		if (res.status === 304) return { notModified: true, bytes: 0 };
		if (!res.ok) throw new Error(`fires endpoint responded ${res.status}`);
		text = await res.text();
	} finally {
		// runs on the 304 return too — timeout clears on EVERY exit path; conditional does not mean unbounded.
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
		// a v1 Worker answers ?v=2 with a bare FeatureCollection and no points member — fail LOUDLY, an empty fire layer is indistinguishable from "no fires near you".
		throw new Error(
			"fires endpoint did not return a v2 payload (no `points` FeatureCollection) — " +
				"the Worker is likely still on v1; v2 requires the render-ready route",
		);
	}
	const clusters = asCollection(parsed.clusters);
	const outlines = asCollection(parsed.outlines);

	// prefer the server's stamp, fall back to ours if missing — CORS Expose-Headers trap means a custom header reads null unless exposed; route exposes it today, don't crash if that stops.
	const headerAt = Number(res.headers.get("X-Fetched-At"));
	const sourcesOk = Number(res.headers.get("X-Sources-Ok"));
	// ETag needs no Expose-Headers entry same-origin, but this is CROSS-origin — it reads null unless Access-Control-Expose-Headers lists it (same trap as X-Fetched-At); missing just degrades to "no conditional GET next time".
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
			// re-serialized from the PARSED members, never sliced out of text — a substring of the original body could carry members we never validated.
			pointsJson: JSON.stringify(parsed.points),
			clustersJson: clusters ? JSON.stringify(parsed.clusters) : EMPTY_FC,
			outlinesJson: outlines ? JSON.stringify(parsed.outlines) : EMPTY_FC,
			pointCount: points.features.length,
			// spread so the etag key is absent (not undefined) when the Worker sends none — IndexedDB round-trips an explicit undefined and {...stored} would carry a dead key forward.
			...(etag ? { etag } : {}),
		},
	};
}
