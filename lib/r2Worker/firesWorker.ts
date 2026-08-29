/**
 * fires.ts — NASA FIRMS active-fire hotspots, fetched per-area, returned as trimmed GeoJSON.
 * ⚠️ FIRMS MAP_KEY is a Worker secret — never put it in the app bundle.
 * ⚠️ fetchedAt is not decoration — it drives the "as of Xh ago" staleness stamp; keep it wired end to end.
 * Pure logic over an injected fetch — no R2/caching/Response building (that's index.ts).
 */

/** FIRMS Area API base. CSV flavour: /api/area/csv/{KEY}/{SOURCE}/{bbox}/{days} */
const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/** The three VIIRS 375m sensors, queried together — MODIS deliberately excluded: coarser, and its 0–100 confidence scale doesn't match VIIRS l/n/h. */
export const FIRMS_SOURCES = [
	"VIIRS_NOAA20_NRT",
	"VIIRS_SNPP_NRT",
	"VIIRS_NOAA21_NRT",
] as const;

/** ⚠️ DAY_RANGE=1 means "today, UTC", not "last 24h" — blanked the whole layer nightly at UTC midnight (5pm BC) while fires burned. Never drop below 2; locked by a test in fires.test.ts. */
export const DAY_RANGE = 2;

/** Default disc radius. ~785,000 km² — the smoke shed, not just the block. */
export const DEFAULT_RADIUS_KM = 500;

/** Hard ceiling so a hand-edited URL can't ask us to pull a continent. */
export const MAX_RADIUS_KM = 800;

/** VIIRS confidence is CATEGORICAL (l/n/h) — not the MODIS 0–100 scale. */
export type FireConfidence = "low" | "nominal" | "high";

export interface FireFeature {
	/** [lng, lat] — GeoJSON order, not the CSV's lat-first order. */
	readonly coordinates: readonly [number, number];
	/** Acquisition time, UTC epoch ms. Drives the age-colour ramp. */
	readonly t: number;
	readonly confidence: FireConfidence;
	/** Fire radiative power, megawatts. */
	readonly frp: number;
	/** Pixel footprint km (larger of scan/track), OPTIONAL. A detection means part of this ~0.4km cell was hot, NOT that the whole square is on fire. */
	readonly px?: number;
	/** Day or Night overpass — night detections have less solar contamination, so are more trustworthy. OPTIONAL. */
	readonly dn?: "D" | "N";
}

export interface FireCollection {
	readonly type: "FeatureCollection";
	readonly features: ReadonlyArray<{
		readonly type: "Feature";
		readonly geometry: { readonly type: "Point"; readonly coordinates: readonly [number, number] };
		readonly properties: {
			readonly t: number;
			readonly c: FireConfidence;
			readonly frp: number;
			readonly px?: number;
			readonly dn?: "D" | "N";
		};
	}>;
}

const EARTH_RADIUS_KM = 6371;

/** Bbox order matches Mapbox bounds (no conversion needed); clamps at poles where cos(lat)→0 would otherwise explode the span. */
export function bboxForRadius(
	lng: number,
	lat: number,
	km: number,
): [number, number, number, number] {
	const latDelta = (km / EARTH_RADIUS_KM) * (180 / Math.PI);
	const cosLat = Math.cos((lat * Math.PI) / 180);
	const lngDelta = Math.abs(cosLat) < 0.01 ? 180 : latDelta / cosLat;
	return [
		Math.max(-180, lng - lngDelta),
		Math.max(-90, lat - latDelta),
		Math.min(180, lng + lngDelta),
		Math.min(90, lat + latDelta),
	];
}

/** Great-circle distance in km (haversine) — trims the bbox corners to a disc. */
export function distanceKm(
	aLng: number,
	aLat: number,
	bLng: number,
	bLat: number,
): number {
	const toRad = Math.PI / 180;
	const dLat = (bLat - aLat) * toRad;
	const dLng = (bLng - aLng) * toRad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** l/n/h → enum. Unknown codes are treated as WEAKEST, never silently promoted to a confirmed fire. */
function parseConfidence(raw: string): FireConfidence {
	switch (raw.trim().toLowerCase()) {
		case "h":
		case "high":
			return "high";
		case "n":
		case "nominal":
			return "nominal";
		default:
			return "low";
	}
}

/** ⚠️ Built via Date.UTC from explicit parts, NOT ISO-string-slicing — that's the repo's UTC date trap (local-timezone slicing silently shifts the day by up to 24h). */
export function parseAcqTime(acqDate: string, acqTime: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acqDate.trim());
	if (m === null) return Number.NaN;
	const hhmm = acqTime.trim().padStart(4, "0");
	const hours = Number(hhmm.slice(0, 2));
	const mins = Number(hhmm.slice(2, 4));
	if (!Number.isFinite(hours) || !Number.isFinite(mins)) return Number.NaN;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hours, mins);
}

/** ⚠️ Columns read BY HEADER NAME, never by index — a reordered/extended feed would silently poison every coordinate if hardcoded; header lookup fails loudly instead. */
export function parseFiresCsv(
	csv: string,
	centreLng: number,
	centreLat: number,
	radiusKm: number,
): FireFeature[] {
	const lines = csv.trim().split("\n");
	if (lines.length < 2) return []; // header only = no fires in this bbox

	const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
	const col = (name: string): number => {
		const i = header.indexOf(name);
		if (i === -1) {
			throw new Error(
				`FIRMS CSV missing expected column "${name}" — header was: ${header.join(",")}`,
			);
		}
		return i;
	};
	const iLat = col("latitude");
	const iLng = col("longitude");
	const iDate = col("acq_date");
	const iTime = col("acq_time");
	const iConf = col("confidence");
	const iFrp = col("frp");
	// OPTIONAL columns, looked up softly (not via col(), which throws) — a feed missing them degrades the popup, never blanks the layer.
	const soft = (name: string): number => header.indexOf(name);
	const iScan = soft("scan");
	const iTrack = soft("track");
	const iDayNight = soft("daynight");

	const out: FireFeature[] = [];
	for (let i = 1; i < lines.length; i++) {
		const row = lines[i].trim();
		if (row === "") continue;
		const f = row.split(",");
		const lat = Number(f[iLat]);
		const lng = Number(f[iLng]);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		// API returns the bbox; we want the DISC — without this, corners carry fires up to 40% past the stated radius.
		if (distanceKm(centreLng, centreLat, lng, lat) > radiusKm) continue;
		const t = parseAcqTime(f[iDate] ?? "", f[iTime] ?? "");
		if (!Number.isFinite(t)) continue;
		const frp = Number(f[iFrp]);
		// Pixel footprint = larger axis, rounded to 0.1km — VIIRS is 375m at nadir but stretches toward the swath edge, so this genuinely varies.
		const scan = iScan === -1 ? Number.NaN : Number(f[iScan]);
		const track = iTrack === -1 ? Number.NaN : Number(f[iTrack]);
		const px =
			Number.isFinite(scan) && Number.isFinite(track)
				? Math.round(Math.max(scan, track) * 10) / 10
				: undefined;
		const dn = iDayNight === -1 ? "" : (f[iDayNight] ?? "").trim().toUpperCase();
		out.push({
			coordinates: [lng, lat],
			t,
			confidence: parseConfidence(f[iConf] ?? ""),
			frp: Number.isFinite(frp) ? frp : 0,
			...(px === undefined ? {} : { px }),
			...(dn === "D" || dn === "N" ? { dn: dn as "D" | "N" } : {}),
		});
	}
	return out;
}

/** Collapses detections on the same ~375m cell within the same hour, keeping strongest FRP — else one fire renders as a clump of dots. */
export function dedupeFires(features: readonly FireFeature[]): FireFeature[] {
	const best = new Map<string, FireFeature>();
	for (const f of features) {
		const key = [
			f.coordinates[0].toFixed(3),
			f.coordinates[1].toFixed(3),
			Math.floor(f.t / 3_600_000),
		].join("|");
		const prev = best.get(key);
		if (prev === undefined || f.frp > prev.frp) best.set(key, f);
	}
	return [...best.values()];
}

/** Build one Area API URL. Exported for the test; the key never gets logged. */
export function firmsUrl(
	mapKey: string,
	source: string,
	bbox: readonly [number, number, number, number],
	days: number = DAY_RANGE,
): string {
	const area = bbox.map((n) => n.toFixed(4)).join(",");
	return `${FIRMS_BASE}/${mapKey}/${source}/${area}/${days}`;
}

/** ⚠️ FAIL-LOUD: if every source fails, throw (never return an empty collection — that lies as "no fires near you"). A partial failure (one satellite down) is legitimate data and returns normally via sourcesOk. */
export async function fetchFires(
	mapKey: string,
	lng: number,
	lat: number,
	radiusKm: number,
	fetchImpl: typeof fetch = fetch,
): Promise<{ collection: FireCollection; sourcesOk: number; fetchedAt: number }> {
	const bbox = bboxForRadius(lng, lat, radiusKm);

	const results = await Promise.allSettled(
		FIRMS_SOURCES.map(async (source) => {
			const res = await fetchImpl(firmsUrl(mapKey, source, bbox));
			if (!res.ok) {
				throw new Error(`FIRMS ${source} responded ${res.status}`);
			}
			const body = await res.text();
			// Invalid/over-quota key returns 200 with an HTML/plaintext error body, which would parse as zero fires — catch it as the failure it is.
			if (body.trimStart().startsWith("<") || !body.includes("latitude")) {
				throw new Error(
					`FIRMS ${source} returned a non-CSV body (bad key or quota?)`,
				);
			}
			return parseFiresCsv(body, lng, lat, radiusKm);
		}),
	);

	const ok = results.filter(
		(r): r is PromiseFulfilledResult<FireFeature[]> => r.status === "fulfilled",
	);
	if (ok.length === 0) {
		const why = results
			.map((r) => (r.status === "rejected" ? String(r.reason) : ""))
			.filter(Boolean)
			.join("; ");
		throw new Error(`all FIRMS sources failed: ${why}`);
	}

	const merged = dedupeFires(ok.flatMap((r) => r.value));
	return {
		collection: {
			type: "FeatureCollection",
			features: merged.map((f) => ({
				type: "Feature" as const,
				geometry: { type: "Point" as const, coordinates: f.coordinates },
				// Keys stay SHORT (repeated thousands of times per disc); optional keys omitted rather than sent as null — absent means "feed didn't say".
				properties: {
					t: f.t,
					c: f.confidence,
					frp: f.frp,
					...(f.px === undefined ? {} : { px: f.px }),
					...(f.dn === undefined ? {} : { dn: f.dn }),
				},
			})),
		},
		sourcesOk: ok.length,
		fetchedAt: Date.now(),
	};
}
