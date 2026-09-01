// ⚠️ failure MUST throw — an empty list on network error reads as "no fires near you".
// ⚠️ NEVER let a fetch hang — lie-fi leaves a bare fetch pending forever; hence the AbortController timeout.

import { guardPackDownload } from "../../../onPhone/store/downloadGuard";
import { firesUrl } from "../tilesHost";
import {
	FIRE_RADIUS_KM,
	type FireHotspot,
} from "../../../shared/fireContract";

const FIRE_TIMEOUT_MS = 20_000;

export interface FireFetchResult {
	hotspots: FireHotspot[];
	/** X-Fetched-At — ⚠️ not our clock, which overstates freshness by up to the cache TTL */
	fetchedAt: number;
	/** X-Sources-Ok — satellites that reported, of three */
	sourcesOk: number;
	/** response size in bytes */
	bytes: number;
}

interface FireGeoJSON {
	type: string;
	features?: Array<{
		geometry?: { coordinates?: [number, number] };
		properties?: {
			t?: number;
			c?: string;
			frp?: number;
			/** pixel footprint km; day/night pass — optional */
			px?: number;
			dn?: string;
		};
	}>;
}

function toConfidence(raw: unknown): FireHotspot["c"] {
	// ⚠️ unknown codes fall to the WEAKEST reading — never silently promoted.
	return raw === "high" ? "high" : raw === "nominal" ? "nominal" : "low";
}

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
			// ⚠️ never default px to 0 — "unknown" and "0" are different claims.
			...(Number.isFinite(f.properties?.px)
				? { px: f.properties?.px as number }
				: {}),
			...(f.properties?.dn === "D" || f.properties?.dn === "N"
				? { dn: f.properties.dn as "D" | "N" }
				: {}),
		});
	}

	// ⚠️ own clock only when the header is missing — a custom header reads null unless CORS-exposed.
	const headerAt = Number(res.headers.get("X-Fetched-At"));
	const sourcesOk = Number(res.headers.get("X-Sources-Ok"));

	return {
		hotspots,
		fetchedAt: Number.isFinite(headerAt) && headerAt > 0 ? headerAt : Date.now(),
		sourcesOk: Number.isFinite(sourcesOk) && sourcesOk > 0 ? sourcesOk : 3,
		bytes: text.length,
	};
}
