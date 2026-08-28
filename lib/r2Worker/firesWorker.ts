/**
 * fires.ts — NASA FIRMS active-fire hotspots, fetched per-area and returned as
 * trimmed GeoJSON.
 *
 * ── Why this lives on the Worker, not the phone ──
 * Same reason as /pack: the phone makes ONE request to us, and we do the fan-out
 * (three satellites) in-datacenter. It also keeps the FIRMS MAP_KEY off every
 * device — the key is a Worker secret, never in the app bundle.
 *
 * ── Why the Area API, not the bulk world CSV ──
 * The bulk /archive/FIRMS folder needs a full Earthdata Login ACCOUNT; the Area
 * API needs only the MAP_KEY, and it takes a bbox — so NASA does the geographic
 * filtering and we pull ~360 KB instead of a world file we'd throw 99% of away.
 *
 * ── The freshness difference from /pack ──
 * Tiles are immutable (max-age=1yr). Hotspots are worthless at ~6 h old, so this
 * route caches ~1 h and every record carries the fetch time. That timestamp is
 * NOT decoration: it drives the "as of Xh ago" stamp the field user reads before
 * trusting the dots. Keep it wired end to end.
 *
 * This file is PURE LOGIC over an injected fetch — no R2, no caching, no
 * Response building (index.ts owns all of that), so it stays unit-testable.
 */

/** FIRMS Area API base. CSV flavour: /api/area/csv/{KEY}/{SOURCE}/{bbox}/{days} */
const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/**
 * The three VIIRS 375 m sensors, queried together. More satellites = more passes
 * per day = a fire is seen sooner. MODIS (1 km) is deliberately excluded: coarser
 * and noisier, and its `confidence` is a 0–100 number rather than VIIRS's l/n/h,
 * so mixing it would mean two confidence vocabularies in one layer.
 */
export const FIRMS_SOURCES = [
	"VIIRS_NOAA20_NRT",
	"VIIRS_SNPP_NRT",
	"VIIRS_NOAA21_NRT",
] as const;

/**
 * How many CALENDAR DAYS of FIRMS data to request (the API accepts 1–5).
 *
 * ⚠️ `1` DOES NOT MEAN "the last 24 hours" — it means "today, UTC". That
 * distinction blanked the entire layer in the field:
 *
 *   2026-08-08, southern BC, dozens of active fires burning.
 *     DAY_RANGE=1 → 0 rows.
 *     DAY_RANGE=2 → 5,080 rows, EVERY ONE stamped acq_date 2026-08-07.
 *
 * Just past UTC midnight, today's satellite passes have not been processed yet,
 * so "today" is genuinely empty and yesterday is excluded by the filter. The
 * layer therefore emptied itself every night at UTC midnight — 5pm in BC, the
 * middle of a working afternoon — and reported "no fires near you" over a
 * province that was on fire.
 *
 * So: request 2 days and let the CLIENT decide what is too old (every hotspot
 * carries its acquisition time, and the age ramp already fades them out). Fetching
 * a day we might not draw is a few KB; not fetching one is a blank map.
 * Locked by a test in fires.test.ts. Do not "optimise" this back to 1.
 */
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
	/**
	 * Pixel footprint in km (the larger of scan/track). OPTIONAL — a feed
	 * without those columns still works, the popup just says less.
	 *
	 * This is the number that keeps the layer honest: a detection means "some
	 * part of this ~0.4 km cell was hot", NOT "this whole square is on fire".
	 */
	readonly px?: number;
	/** Day or Night overpass. Night detections have less solar contamination,
	 *  so they're the more trustworthy read. OPTIONAL, same reason as px. */
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

/**
 * Bounding box for a disc, in the Area API's `west,south,east,north` order —
 * which is also Mapbox's bounds order, so no conversion anywhere downstream.
 *
 * Longitude degrees shrink toward the poles, hence the /cos(lat) widening. At
 * high latitude cos(lat) → 0 and the span explodes, so clamp to the whole world
 * rather than emit a nonsense bbox (a planter at 60°N is a real case).
 */
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

/** l/n/h → enum. Anything unexpected is treated as the WEAKEST reading, never
 *  silently promoted — an unknown code must not masquerade as a confirmed fire. */
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

/**
 * `acq_date` (YYYY-MM-DD) + `acq_time` (UTC HHMM, often unpadded e.g. "153")
 * → epoch ms.
 *
 * Built from explicit UTC parts via Date.UTC — NOT by string-slicing an ISO
 * string, which is the repo's documented UTC date trap (local-timezone slicing
 * silently shifts the day and would mis-age every hotspot by up to 24 h).
 */
export function parseAcqTime(acqDate: string, acqTime: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acqDate.trim());
	if (m === null) return Number.NaN;
	const hhmm = acqTime.trim().padStart(4, "0");
	const hours = Number(hhmm.slice(0, 2));
	const mins = Number(hhmm.slice(2, 4));
	if (!Number.isFinite(hours) || !Number.isFinite(mins)) return Number.NaN;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hours, mins);
}

/**
 * Parse a FIRMS CSV into trimmed points inside the disc.
 *
 * Columns are read BY HEADER NAME, never by index. FIRMS's documented VIIRS
 * order is latitude, longitude, bright_ti4, scan, track, acq_date, acq_time,
 * satellite, confidence, version, bright_ti5, frp, type, daynight — but a feed
 * that adds or reorders a column would silently poison every coordinate if we
 * hardcoded positions. Header lookup fails loudly instead.
 *
 * We keep only lng/lat/time/confidence/frp — that trim is what gets a 500 km
 * disc down to ~60 bytes a point.
 */
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
	// OPTIONAL columns — looked up softly, never via col(), which throws.
	// These feed the tap popup ("how big is this pixel", "day or night pass")
	// and are nice-to-have context, NOT load-bearing like lat/lng/time. A feed
	// that drops one must degrade to a popup with less detail, never to a hard
	// failure that blanks the whole layer. `scan`/`track` are the pixel
	// footprint in km — the honest answer to "is the WHOLE square on fire?"
	// (it isn't; the detection is somewhere inside it).
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
		// The API returns the bbox; we want the DISC. Without this the corners
		// carry fires up to 40% further out than the stated radius.
		if (distanceKm(centreLng, centreLat, lng, lat) > radiusKm) continue;
		const t = parseAcqTime(f[iDate] ?? "", f[iTime] ?? "");
		if (!Number.isFinite(t)) continue;
		const frp = Number(f[iFrp]);
		// Pixel footprint: the larger of the two axes, rounded to 0.1 km. VIIRS
		// is nominally 375 m at nadir but stretches toward the swath edge, so
		// this genuinely varies and is worth showing rather than hardcoding.
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

/**
 * Two satellites can see the same fire minutes apart. Collapse detections that
 * land on the same ~375 m cell within the same hour, keeping the strongest FRP —
 * otherwise a single fire renders as a clump of dots and reads as far worse than
 * it is. Deliberately coarse: this de-duplicates one fire, it does not merge
 * genuinely separate nearby fires.
 */
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

/**
 * Fetch all three sensors for a disc and return one GeoJSON FeatureCollection.
 *
 * FAIL-LOUD (repo convention): if EVERY source fails we throw, so the route
 * answers 502 and the phone keeps its last good cache. What we must never do is
 * return an empty collection on a network error — that renders as "no fires
 * near you", which is the single most dangerous lie this layer could tell.
 *
 * A PARTIAL failure (one satellite down, others fine) is legitimate data and
 * returns normally; the caller gets `sourcesOk` to surface degraded coverage.
 */
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
			// An invalid/over-quota key returns 200 with an HTML or plaintext error
			// body, which would parse as "zero fires". Catch it as the failure it is.
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
				// Keys stay SHORT — this shape is repeated thousands of times per
				// disc, and it's the same vocabulary the phone reads back.
				// Optional keys are omitted entirely rather than sent as null:
				// absent means "the feed didn't say", which the popup handles.
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
