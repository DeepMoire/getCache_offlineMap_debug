/**
 * fires.test.ts — locks the parsing + safety rules of the FIRMS hotspot fetch.
 *
 * The load-bearing tests here are the LIES tests: a network failure, a bad key,
 * or an HTML error body must never surface as "zero fires near you". Everything
 * else is arithmetic.
 */

import { describe, expect, it } from "vitest";
import {
	bboxForRadius,
	DAY_RANGE,
	dedupeFires,
	distanceKm,
	fetchFires,
	firmsUrl,
	parseAcqTime,
	parseFiresCsv,
} from "./firesWorker";

/**
 * The header the LIVE Area API actually returns (captured 2026-08-07), which is
 * NOT what the docs describe: the real feed carries an extra `instrument` column
 * and has no `type`. That mismatch is precisely why fires.ts looks columns up by
 * NAME — index-based parsing would have silently read `instrument` as
 * `confidence` here. Keep this fixture byte-accurate to the live feed.
 */
const HEADER =
	"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";

/** One row matching HEADER exactly (14 fields, `instrument` present, no `type`). */
const row = (
	lat: number,
	lng: number,
	date = "2026-08-07",
	time = "1830",
	conf = "n",
	frp = "12.5",
): string =>
	`${lat},${lng},320.1,0.4,0.36,${date},${time},N20,VIIRS,${conf},2.0NRT,290.3,${frp},D`;

const OTTAWA: [number, number] = [-75.7, 45.4];

describe("parseAcqTime", () => {
	it("builds UTC epoch ms from date + HHMM", () => {
		expect(parseAcqTime("2026-08-07", "1830")).toBe(
			Date.UTC(2026, 7, 7, 18, 30),
		);
	});

	it("pads an unpadded time — FIRMS emits '153' for 01:53", () => {
		expect(parseAcqTime("2026-08-07", "153")).toBe(Date.UTC(2026, 7, 7, 1, 53));
	});

	it("does NOT shift the day (the UTC date trap)", () => {
		// Late-UTC on the 7th must stay the 7th regardless of the host timezone —
		// an ISO-slice implementation would roll this to the 6th west of GMT.
		const t = parseAcqTime("2026-08-07", "2350");
		expect(new Date(t).getUTCDate()).toBe(7);
		expect(new Date(t).getUTCHours()).toBe(23);
	});

	it("returns NaN on a malformed date rather than a wrong time", () => {
		expect(parseAcqTime("07/08/2026", "1830")).toBeNaN();
	});
});

describe("bboxForRadius", () => {
	it("returns west,south,east,north — the Area API + Mapbox order", () => {
		const [w, s, e, n] = bboxForRadius(OTTAWA[0], OTTAWA[1], 500);
		expect(w).toBeLessThan(OTTAWA[0]);
		expect(e).toBeGreaterThan(OTTAWA[0]);
		expect(s).toBeLessThan(OTTAWA[1]);
		expect(n).toBeGreaterThan(OTTAWA[1]);
	});

	it("widens longitude with latitude — a degree of lng is shorter up north", () => {
		const equator = bboxForRadius(0, 0, 500);
		const north = bboxForRadius(0, 60, 500);
		expect(north[2] - north[0]).toBeGreaterThan(equator[2] - equator[0]);
	});

	it("clamps at the poles instead of emitting an exploded bbox", () => {
		const [w, s, e, n] = bboxForRadius(0, 89.99, 500);
		expect(w).toBeGreaterThanOrEqual(-180);
		expect(e).toBeLessThanOrEqual(180);
		expect(s).toBeGreaterThanOrEqual(-90);
		expect(n).toBeLessThanOrEqual(90);
	});
});

describe("parseFiresCsv", () => {
	it("parses rows and flips CSV lat,lng into GeoJSON lng,lat", () => {
		const csv = [HEADER, row(45.5, -75.6)].join("\n");
		const out = parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500);
		expect(out).toHaveLength(1);
		expect(out[0].coordinates).toEqual([-75.6, 45.5]);
		expect(out[0].confidence).toBe("nominal");
		expect(out[0].frp).toBe(12.5);
	});

	it("returns [] for a header-only body (no fires in the bbox)", () => {
		expect(parseFiresCsv(HEADER, OTTAWA[0], OTTAWA[1], 500)).toEqual([]);
	});

	it("trims the bbox corners down to the DISC", () => {
		// ~700 km east — inside the 500 km bbox's corner, outside the disc.
		const csv = [HEADER, row(45.4, -66.7)].join("\n");
		expect(parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500)).toHaveLength(0);
	});

	it("parses a VERBATIM live row (captured from the real API 2026-08-07)", () => {
		// Copied byte-for-byte from a real response. The live feed's `instrument`
		// column sits exactly where the docs put `confidence` — index-based parsing
		// would read "VIIRS" as the confidence and silently downgrade every fire.
		const live = [
			HEADER,
			"45.34053,-73.52417,305.66,0.4,0.44,2026-08-07,629,N20,VIIRS,n,2.0NRT,289.95,0.93,N",
		].join("\n");
		const out = parseFiresCsv(live, -73.5, 45.3, 500);
		expect(out).toHaveLength(1);
		expect(out[0].coordinates).toEqual([-73.52417, 45.34053]);
		expect(out[0].confidence).toBe("nominal"); // NOT "low" from misreading "VIIRS"
		expect(out[0].frp).toBe(0.93);
		expect(out[0].t).toBe(Date.UTC(2026, 7, 7, 6, 29)); // "629" → 06:29 UTC
	});

	it("reads columns BY NAME, surviving a reordered feed", () => {
		const reordered = "acq_date,acq_time,longitude,latitude,confidence,frp";
		const csv = [reordered, "2026-08-07,1830,-75.6,45.5,h,9.1"].join("\n");
		const out = parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500);
		expect(out[0].coordinates).toEqual([-75.6, 45.5]);
		expect(out[0].confidence).toBe("high");
	});

	it("throws — not silently mis-parses — if a required column vanishes", () => {
		const csv = ["latitude,acq_date,acq_time,confidence,frp", "45.5,2026-08-07,1830,n,1"].join("\n");
		expect(() => parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500)).toThrow(/longitude/);
	});

	it("maps VIIRS l/n/h and never promotes an unknown code", () => {
		const csv = [
			HEADER,
			row(45.5, -75.6, "2026-08-07", "1830", "l"),
			row(45.5, -75.61, "2026-08-07", "1830", "h"),
			row(45.5, -75.62, "2026-08-07", "1830", "???"),
		].join("\n");
		const out = parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500);
		expect(out.map((f) => f.confidence)).toEqual(["low", "high", "low"]);
	});

	it("skips rows with unparseable coordinates", () => {
		const csv = [HEADER, row(Number.NaN, -75.6), row(45.5, -75.6)].join("\n");
		expect(parseFiresCsv(csv, OTTAWA[0], OTTAWA[1], 500)).toHaveLength(1);
	});
});

describe("dedupeFires", () => {
	it("collapses the same fire seen by two satellites, keeping the strongest FRP", () => {
		const t = Date.UTC(2026, 7, 7, 18, 30);
		const out = dedupeFires([
			{ coordinates: [-75.6001, 45.5001], t, confidence: "nominal", frp: 10 },
			{ coordinates: [-75.6002, 45.5002], t: t + 60_000, confidence: "high", frp: 25 },
		]);
		expect(out).toHaveLength(1);
		expect(out[0].frp).toBe(25);
	});

	it("keeps genuinely separate fires apart", () => {
		const t = Date.UTC(2026, 7, 7, 18, 30);
		const out = dedupeFires([
			{ coordinates: [-75.6, 45.5], t, confidence: "nominal", frp: 10 },
			{ coordinates: [-75.9, 45.9], t, confidence: "nominal", frp: 10 },
		]);
		expect(out).toHaveLength(2);
	});
});

describe("distanceKm", () => {
	it("is ~0 for a point against itself", () => {
		expect(distanceKm(-75.7, 45.4, -75.7, 45.4)).toBeCloseTo(0, 5);
	});

	it("matches a known separation (Ottawa→Toronto ≈ 350 km)", () => {
		expect(distanceKm(-75.7, 45.4, -79.4, 43.7)).toBeGreaterThan(330);
		expect(distanceKm(-75.7, 45.4, -79.4, 43.7)).toBeLessThan(370);
	});
});

describe("firmsUrl", () => {
	it("builds the documented Area API path with a west,south,east,north bbox", () => {
		const u = firmsUrl("KEY123", "VIIRS_NOAA20_NRT", [-80, 40, -70, 50], 1);
		expect(u).toBe(
			"https://firms.modaps.eosdis.nasa.gov/api/area/csv/KEY123/VIIRS_NOAA20_NRT/-80.0000,40.0000,-70.0000,50.0000/1",
		);
	});
});

describe("DAY_RANGE — the UTC-midnight blackout", () => {
	it("asks for MORE THAN ONE calendar day", () => {
		// FIRMS's day range is a CALENDAR-DAY filter, not a rolling 24 h window.
		// With DAY_RANGE=1, "today UTC" is genuinely empty for the first hours
		// after midnight (satellite passes aren't processed yet) and yesterday is
		// excluded — so the layer blanked itself nightly at UTC midnight, which is
		// 5pm in BC. Measured 2026-08-08 over southern BC: 1 day → 0 rows;
		// 2 days → 5,080 rows, every one stamped 2026-08-07, while dozens of
		// fires were burning. Requesting a day we might not draw costs a few KB;
		// not requesting it costs the whole feature.
		expect(DAY_RANGE).toBeGreaterThanOrEqual(2);
	});

	it("stays inside the Area API's documented 1–5 range", () => {
		expect(DAY_RANGE).toBeLessThanOrEqual(5);
	});

	it("puts the day range in the URL, so the fetch actually asks for it", () => {
		// Guards the wiring, not just the constant: a correct DAY_RANGE that never
		// reaches the URL would reproduce the blackout exactly.
		const u = firmsUrl("KEY123", "VIIRS_NOAA20_NRT", [-80, 40, -70, 50]);
		expect(u.endsWith(`/${DAY_RANGE}`)).toBe(true);
	});
});

describe("fetchFires — must never lie about zero fires", () => {
	const okCsv = [HEADER, row(45.5, -75.6)].join("\n");
	const res = (body: string, status = 200): Response =>
		new Response(body, { status });

	it("merges sources and reports how many succeeded", async () => {
		const r = await fetchFires("K", OTTAWA[0], OTTAWA[1], 500, async () =>
			res(okCsv),
		);
		expect(r.sourcesOk).toBe(3);
		// Same fire from all three satellites → deduped to one dot.
		expect(r.collection.features).toHaveLength(1);
		expect(r.collection.features[0].geometry.coordinates).toEqual([-75.6, 45.5]);
	});

	it("THROWS when every source fails — never an empty collection", async () => {
		await expect(
			fetchFires("K", OTTAWA[0], OTTAWA[1], 500, async () => res("nope", 500)),
		).rejects.toThrow(/all FIRMS sources failed/);
	});

	it("THROWS on an HTML body — a bad/over-quota key returns 200 + HTML", async () => {
		await expect(
			fetchFires("BAD", OTTAWA[0], OTTAWA[1], 500, async () =>
				res("<html>Invalid MAP_KEY</html>"),
			),
		).rejects.toThrow(/all FIRMS sources failed/);
	});

	it("survives a PARTIAL outage — one satellite down is still real data", async () => {
		let n = 0;
		const r = await fetchFires("K", OTTAWA[0], OTTAWA[1], 500, async () => {
			n++;
			return n === 1 ? res("boom", 503) : res(okCsv);
		});
		expect(r.sourcesOk).toBe(2);
		expect(r.collection.features).toHaveLength(1);
	});

	it("stamps fetchedAt — the staleness stamp depends on it", async () => {
		const before = Date.now();
		const r = await fetchFires("K", OTTAWA[0], OTTAWA[1], 500, async () =>
			res(okCsv),
		);
		expect(r.fetchedAt).toBeGreaterThanOrEqual(before);
	});
});

/**
 * The tap-popup columns. These are OPTIONAL by design: they add detail to the
 * hotspot card ("how big is this pixel", "day or night pass") but must never be
 * load-bearing. A feed that drops one has to degrade to a plainer popup, never
 * to a hard failure that blanks the whole layer — the same fail-open rule the
 * rest of this file follows for anything that isn't lat/lng/time.
 */
describe("optional popup columns — px (footprint) and dn (day/night)", () => {
	it("takes the LARGER of scan/track as the pixel footprint", () => {
		// The fixture row carries scan=0.4, track=0.36.
		const [f] = parseFiresCsv(`${HEADER}\n${row(45, -76)}`, -76, 45, 100);
		expect(f.px).toBe(0.4);
	});

	it("carries the day/night flag through", () => {
		const [f] = parseFiresCsv(`${HEADER}\n${row(45, -76)}`, -76, 45, 100);
		expect(f.dn).toBe("D");
	});

	it("parses fine when scan/track/daynight are ABSENT — popup just says less", () => {
		// A feed trimmed to the load-bearing columns only.
		const lean = "latitude,longitude,acq_date,acq_time,confidence,frp";
		const leanRow = "45,-76,2026-08-07,1830,n,12.5";
		const out = parseFiresCsv(`${lean}\n${leanRow}`, -76, 45, 100);
		expect(out).toHaveLength(1);
		expect(out[0].px).toBeUndefined();
		expect(out[0].dn).toBeUndefined();
		// The load-bearing fields still arrived.
		expect(out[0].frp).toBe(12.5);
		expect(out[0].confidence).toBe("nominal");
	});

	it("omits dn rather than passing through a junk value", () => {
		const hdr = "latitude,longitude,acq_date,acq_time,confidence,frp,daynight";
		const junk = "45,-76,2026-08-07,1830,n,12.5,X";
		const [f] = parseFiresCsv(`${hdr}\n${junk}`, -76, 45, 100);
		expect(f.dn).toBeUndefined();
	});

	it("omits px when the footprint columns are unparseable", () => {
		const hdr = "latitude,longitude,acq_date,acq_time,confidence,frp,scan,track";
		const junk = "45,-76,2026-08-07,1830,n,12.5,,abc";
		const [f] = parseFiresCsv(`${hdr}\n${junk}`, -76, 45, 100);
		expect(f.px).toBeUndefined();
	});
});
