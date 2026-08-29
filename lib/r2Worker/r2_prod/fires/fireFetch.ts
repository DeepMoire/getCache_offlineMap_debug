/**
 * ⚠️ Two rules this file enforces: 1) A FAILURE MUST THROW — an empty list on error renders as "no fires near you", the most dangerous lie this layer can tell. 2) NEVER hang — an un-timed fetch on lie-fi is a documented cause of past field failures, hence the explicit AbortController timeout.
 */

import { guardPackDownload } from "../../../onPhone/store/downloadGuard";
import { firesUrl } from "../tilesHost";
import {
	FIRE_RADIUS_KM,
	type FireHotspot,
} from "../../../shared/fireContract";

const FIRE_TIMEOUT_MS = 20_000;

export interface FireFetchResult {
	hotspots: FireHotspot[];
	/** Server's fetch time (X-Fetched-At) — the edge may serve a cached slice, so
	 *  trusting our own clock would overstate freshness by up to the cache TTL. */
	fetchedAt: number;
	/** How many of the three satellites reported (X-Sources-Ok). */
	sourcesOk: number;
	/** Response size, for the cellular-gate tally. */
	bytes: number;
}

/** Minimal shape we require back; anything else is a malformed response. */
interface FireGeoJSON {
	type: string;
	features?: Array<{
		geometry?: { coordinates?: [number, number] };
		properties?: {
			t?: number;
			c?: string;
			frp?: number;
			/** Pixel footprint km + day/night pass — optional, popup-only. */
			px?: number;
			dn?: string;
		};
	}>;
}

function toConfidence(raw: unknown): FireHotspot["c"] {
	// Unknown codes fall to the WEAKEST reading — never silently promoted.
	return raw === "high" ? "high" : raw === "nominal" ? "nominal" : "low";
}

// ⚠️ guardPackDownload is the same session circuit-breaker the tile downloader trips against, so a runaway bake loop can't hammer this endpoint either.
export async function fetchAreaFires(
	lng: number,
	lat: number,
	radiusKm: number = FIRE_RADIUS_KM,
): Promise<FireFetchResult> {
	guardPackDownload({ route: "fires", lng, lat, km: radiusKm });

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FIRE_TIMEOUT_MS);
	let res: Response;
	let text: string;
	const firesEndpoint = firesUrl();
	if (firesEndpoint === null) {
		clearTimeout(timer);
		throw new Error(
			"no tiles host configured — call configureTilesHost(<origin>) at app boot before fetching fires.",
		);
	}
	try {
		res = await fetch(
			`${firesEndpoint}?lng=${lng}&lat=${lat}&km=${Math.round(radiusKm)}`,
			{ signal: controller.signal },
		);
		if (!res.ok) {
			throw new Error(`fires endpoint responded ${res.status}`);
		}
		text = await res.text();
	} finally {
		clearTimeout(timer);
	}

	let parsed: FireGeoJSON;
	try {
		parsed = JSON.parse(text) as FireGeoJSON;
	} catch {
		throw new Error("fires endpoint returned a non-JSON body");
	}
	if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
		throw new Error("fires endpoint returned a malformed FeatureCollection");
	}

	const hotspots: FireHotspot[] = [];
	for (const f of parsed.features) {
		const c = f.geometry?.coordinates;
		const t = f.properties?.t;
		if (!Array.isArray(c) || c.length !== 2) continue;
		if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
		if (typeof t !== "number" || !Number.isFinite(t)) continue;
		hotspots.push({
			coordinates: [c[0], c[1]],
			t,
			c: toConfidence(f.properties?.c),
			frp: Number.isFinite(f.properties?.frp) ? (f.properties?.frp as number) : 0,
			// ⚠️ Never default px to a number — "unknown footprint" and "footprint is 0" are different claims.
			...(Number.isFinite(f.properties?.px)
				? { px: f.properties?.px as number }
				: {}),
			...(f.properties?.dn === "D" || f.properties?.dn === "N"
				? { dn: f.properties.dn as "D" | "N" }
				: {}),
		});
	}

	// ⚠️ Fall back to our own clock only if the header is missing — a custom header reads as null when not explicitly CORS-exposed.
	const headerAt = Number(res.headers.get("X-Fetched-At"));
	const sourcesOk = Number(res.headers.get("X-Sources-Ok"));

	return {
		hotspots,
		fetchedAt: Number.isFinite(headerAt) && headerAt > 0 ? headerAt : Date.now(),
		sourcesOk: Number.isFinite(sourcesOk) && sourcesOk > 0 ? sourcesOk : 3,
		bytes: text.length,
	};
}
