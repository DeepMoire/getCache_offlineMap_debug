/**
 * THE SUMMARY MUST SAY IN ENGLISH WHAT THE SECTIONS SAY IN FIELDS.
 *
 * summarizeFocusedReport is a pure derivation over a finished report — these
 * feed it canned reports (shaped on a real 31 Aug 2026 export) and check the
 * sentences a non-technical reader gets, especially the two states of
 * timeToDownload: measured this session vs served from disk.
 */
import { describe, expect, it } from "vitest";
import { summarizeFocusedReport, type FocusedBlobReport } from "./debugReport";

type Body = Omit<FocusedBlobReport, "summary">;

function cannedReport(overrides: Partial<Body> = {}): Body {
	const base = {
		schema: 1,
		capturedAt: "2026-08-31T16:42:06.700Z",
		route: "debug/map",
		env: {
			tilesHost: "https://tiles-prod.getcache.org",
			workerTarget: "production",
			blobTileZ: 8,
			gridRadiusKm: 30,
			userAgent: "test",
			devicePixelRatio: 2,
		},
		heap: { nowMb: 46, lowMb: 46, peakMb: 59, sinceLoadMb: -13, note: "" },
		layers: [
			layer("sat", "Satellite", "sat"),
			layer("vector", "Roads/water", "pack"),
			layer("labels", "Labels", "pack"),
			layer("fires", "Fires", "fires"),
		],
		meter: {
			at: "2026-08-31T16:42:06.700Z",
			work: [],
			payloads: [],
			focus: null,
			circuits: [],
			paints: [
				{ key: "sat", count: 1, at: 0, drawnAt: 0, atIso: "", drawnAtIso: "" },
				{ key: "vector", count: 1162, at: 0, drawnAt: 0, atIso: "", drawnAtIso: "" },
				{ key: "labels", count: 0, at: 0, drawnAt: null, atIso: "", drawnAtIso: null },
				{ key: "fires", count: 0, at: 0, drawnAt: null, atIso: "", drawnAtIso: null },
			],
			probes: { production: true, r2Dev: true, localDev: false },
		},
		disk: {
			areas: 9,
			bytes: 6290394,
			recentImports: [
				{
					areaKey: "-76.0584,42.0722",
					// 25 min before capturedAt
					bakedAt: "2026-08-31T16:16:45.900Z",
					bytes: 796516,
					tiles: 4,
					photo: true,
				},
			],
		},
		blob: {
			areaKey: "-76.0584,42.0722",
			pin: { lng: -76.05837, lat: 42.07223 },
			cell: "8_73_94",
			cellZoom: 8,
			corners: [],
			box: { w: 0, s: 0, e: 0, n: 0 },
			reachKm: { n: 0, s: 0, e: 0, w: 0 },
			offsetKm: 0,
			bytes: 796516,
			photoBytes: 61374,
			lineBytes: 735142,
			lineCount: 4,
			hasPhoto: true,
			hasLines: true,
			blobVersion: "v",
			lastTouched: "2026-08-31T16:16:45.900Z",
		},
		...overrides,
	};
	return base as unknown as Body;
}

function layer(key: string, label: string, feed: string, transitMs: number | null = null) {
	return {
		key,
		label,
		on: true,
		feed,
		status: "idle",
		arrived: true,
		onScreen: false,
		askedAt: null,
		arrivedAt: null,
		drawnAt: null,
		transitMs,
		paintLagMs: null,
		paintedCount: null,
		reason: "",
		expects: "",
	};
}

describe("summarizeFocusedReport", () => {
	it("reports download durations per feed when this session measured them", () => {
		const r = cannedReport({
			layers: [
				layer("sat", "Satellite", "sat", 912),
				layer("vector", "Roads/water", "pack", 1834),
				// second pack layer must NOT duplicate the pack feed's entry
				layer("labels", "Labels", "pack", 1834),
			],
		} as Partial<Body>);
		const s = summarizeFocusedReport(r);
		expect(s.timeToDownload).toBe(
			"satellite photo 0.9s · road pack 1.8s (ask → bytes on disk, this session)",
		);
	});

	it("says served-from-disk, with the age of the newest area, when nothing downloaded", () => {
		const s = summarizeFocusedReport(cannedReport());
		expect(s.timeToDownload).toContain("nothing downloaded since this page loaded");
		expect(s.timeToDownload).toContain("25 min ago");
	});

	it("puts the on-disk total and painted layers in human units", () => {
		const s = summarizeFocusedReport(cannedReport());
		expect(s.onDisk).toContain("9 areas cached, 6.0 MB");
		expect(s.onScreen).toContain("Satellite (1)");
		expect(s.onScreen).toContain("Roads/water (1,162)");
		expect(s.onScreen).toContain("nothing to draw for Labels, Fires");
		expect(s.workers).toBe("prod reachable · dev reachable · local not running");
		expect(s.memory).toBe("46 MB now, peaked at 59 MB (main thread only)");
	});

	it("never claims NOT reachable for a tier that was simply not probed", () => {
		const r = cannedReport();
		(r.meter as { probes: Record<string, boolean> }).probes = {};
		const s = summarizeFocusedReport(r);
		expect(s.workers).toBe("prod not checked · dev not checked · local not checked");
	});
});
