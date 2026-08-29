/**
 * debugReport.ts — ONE snapshot of the offline map's state, as plain JSON.
 * ⛔ report geometry (corners/reach/offset), not just bytes — byte-only reports hid the 45/27.9/50km bugs.
 * ⛔ never a viewport query — build each report from ONE CoverageRecord/areaKey only, or a neighboring pin's data can leak in.
 * ⛔ no app imports (mapStore, TinyBase, etc.) — pins arrive as a parameter; debugReport.portability.test.ts enforces this.
 */
import {
	BLOB_TILE_Z,
	GRID_RADIUS_KM,
	cellBox,
	cellOf,
	cellKey,
} from "../contract/grid";
import { FIRE_REFRESH_ENABLED } from "./bakeFlags";
import { circuitOf, type CircuitState } from "./workMeter.svelte";
import { LAYER_TOGGLES } from "../onPhone/render/wallLegend";
import { meterSnapshot } from "./workMeter.svelte";
import { kmBetween } from "./kmGeo";
import {
	OFFLINE_BUDGET_BYTES,
	allCoverage,
	type CoverageRecord,
} from "../onPhone/store/coverageRegistry";
import {
	getWorkerTarget,
	tilesHost,
	type WorkerTarget,
} from "../r2Worker/local_dev/tilesHost";
import {
	payloadStats,
	workStats,
	type PayloadStat,
	type WorkStat,
} from "./workMeter.svelte";

/** Schema version of the emitted JSON — bump when a field's MEANING changes, or an old file gets silently misread as new. */
export const DEBUG_REPORT_SCHEMA = 1 as const;

export interface LngLatPin {
	lng: number;
	lat: number;
}

export interface BlobGeometryReport {
	areaKey: string;
	pin: LngLatPin;
	/** Cell this pin resolves to (z_ix_iy) — z can differ from BLOB_TILE_Z (edge pins promote to a shallower tile); read c.z, not the constant. */
	cell: string;
	cellZoom: number;
	/** [w,s], [e,s], [e,n], [w,n] — the box the blob was actually served in. */
	corners: [number, number][];
	box: { w: number; s: number; e: number; n: number };
	/** Reach from pin per edge, km — compare to gridRadiusKm; ~55km against a promised 30km is the bug. */
	reachKm: { n: number; s: number; e: number; w: number };
	/** Pin → centre-of-box, km — THE detector; ~0 is healthy, tens of km is the 45/27.9/50km bug class. */
	offsetKm: number;
	bytes: number;
	photoBytes: number;
	lineBytes: number;
	lineCount: number;
	hasPhoto: boolean;
	hasLines: boolean;
	/** Blob-geometry signature this area was built under; null means it predates versioning and is treated as stale. */
	blobVersion: string | null;
	lastTouched: string;
}

/** Compact per-area line (no corners array) — offsetKm is kept because scanning it down the list reveals systemic mis-boxing. */
export interface AreaSummary {
	areaKey: string;
	lng: number;
	lat: number;
	offsetKm: number;
	bytes: number;
	lineCount: number;
	hasPhoto: boolean;
	hasLines: boolean;
	/** blobVersion missing or != the version this area should hold. */
	stale: boolean;
	lastTouched: string;
}

export interface DebugReport {
	schema: typeof DEBUG_REPORT_SCHEMA;
	capturedAt: string;
	route: string;
	env: {
		/** "(unconfigured)" when no app called configureTilesHost(). */
		tilesHost: string;
		/** Which worker served this session (production/localDev) — without it, identical bad output from either could be different bugs. */
		workerTarget: WorkerTarget;
		blobTileZ: number;
		gridRadiusKm: number;
		userAgent: string;
		devicePixelRatio: number;
	};
	heap: {
		nowMb: number | null;
		lowMb: number | null;
		peakMb: number | null;
		sinceLoadMb: number | null;
		/** performance.memory reports the main-thread realm only — on the offline route the workers hold more, which hid an 800MB defect for weeks. */
		note: string;
	};
	/** Layers visible when captured — a heap number is uninterpretable without knowing e.g. whether satellite was on. */
	layers: { key: string; on: boolean }[];
	bake: {
		on: boolean;
		pending: number;
		failing: number;
		secs: number;
		stalled: boolean;
		note: string;
	};
	work: WorkStat[];
	payloads: PayloadStat[];
	budget: { usedBytes: number; totalBytes: number; areas: number };
	/** The newest area, in full — "the latest blob." */
	latest: BlobGeometryReport | null;
	areas: AreaSummary[];
	/** Pins with no coverage record (bake hasn't covered them yet) — empty is healthy; a long list on a settled app is itself the finding. */
	uncoveredPins: LngLatPin[];
}

export const HEAP_NOTE =
	"main thread only — workers NOT counted; see DevTools → Memory for the total";

/** Geometry for ONE record, derived from ITS OWN key alone. */
export function geometryFor(rec: CoverageRecord): BlobGeometryReport {
	// cellOf may PROMOTE an edge pin to a shallower zoom; cellBox reads c.z, so box and address can never disagree here.
	const c = cellOf(rec.lng, rec.lat);
	const b = cellBox(c);
	const centre: [number, number] = [(b.w + b.e) / 2, (b.s + b.n) / 2];
	const pin: [number, number] = [rec.lng, rec.lat];

	return {
		areaKey: rec.areaKey,
		pin: { lng: rec.lng, lat: rec.lat },
		cell: cellKey(c),
		cellZoom: c.z,
		corners: [
			[b.w, b.s],
			[b.e, b.s],
			[b.e, b.n],
			[b.w, b.n],
		],
		box: { w: b.w, s: b.s, e: b.e, n: b.n },
		reachKm: {
			n: kmBetween(pin, [rec.lng, b.n]),
			s: kmBetween(pin, [rec.lng, b.s]),
			e: kmBetween(pin, [b.e, rec.lat]),
			w: kmBetween(pin, [b.w, rec.lat]),
		},
		offsetKm: kmBetween(pin, centre),
		bytes: rec.bytes ?? 0,
		photoBytes: rec.photoBytes ?? 0,
		lineBytes: rec.lineBytes ?? 0,
		lineCount: rec.lineCount ?? 0,
		hasPhoto: !!rec.hasPhoto,
		hasLines: !!rec.hasLines,
		blobVersion: rec.blobVersion ?? null,
		lastTouched: new Date(rec.lastTouched).toISOString(),
	};
}

function summarise(rec: CoverageRecord, currentVersion: string | null): AreaSummary {
	const g = geometryFor(rec);
	return {
		areaKey: g.areaKey,
		lng: g.pin.lng,
		lat: g.pin.lat,
		offsetKm: g.offsetKm,
		bytes: g.bytes,
		lineCount: g.lineCount,
		hasPhoto: g.hasPhoto,
		hasLines: g.hasLines,
		stale:
			g.blobVersion === null ||
			(currentVersion !== null && g.blobVersion !== currentVersion),
		lastTouched: g.lastTouched,
	};
}

/** Live readings the panel already holds, passed IN (not read from a store) so this module stays free of Svelte state and portable. */
export interface LivePanelState {
	route?: string;
	heapNowMb?: number | null;
	heapLowMb?: number | null;
	heapPeakMb?: number | null;
	heapAtLoadMb?: number | null;
	bakeOn?: boolean;
	bakePending?: number;
	bakeFailing?: number;
	bakeSecs?: number;
	bakeStalled?: boolean;
	bakeNote?: string;
	layers?: { key: string; on: boolean }[];
	/** Every pin the caller knows about — used ONLY to report which pins lack coverage. */
	pins?: LngLatPin[];
	/** The blob signature areas SHOULD hold, for the stale flag. */
	currentBlobVersion?: string | null;
}

/** Build the whole report — reads the coverage registry (its own IndexedDB) and the work meter; everything else arrives via `live`. */
export async function collectDebugReport(
	live: LivePanelState = {},
): Promise<DebugReport> {
	const records = await allCoverage();
	// Newest first (bakedAt, falling back to lastTouched) — matches OfflineBlobPanel's `focused` sort, so "the latest blob" agrees.
	const sorted = records
		.filter((r) => r.hasPhoto || r.hasLines)
		.sort(
			(a, b) =>
				(b.bakedAt ?? b.lastTouched ?? 0) - (a.bakedAt ?? a.lastTouched ?? 0),
		);
	const version = live.currentBlobVersion ?? null;

	const usedBytes = sorted.reduce((n, r) => n + (r.bytes ?? 0), 0);

	// Known pins with no record — matched on the SAME 4dp key the satellite baker writes, so this can't drift from how areas are stored.
	const haveKeys = new Set(sorted.map((r) => r.areaKey));
	const uncoveredPins = (live.pins ?? []).filter(
		(p) => !haveKeys.has(`${p.lng.toFixed(4)},${p.lat.toFixed(4)}`),
	);


	return {
		schema: DEBUG_REPORT_SCHEMA,
		capturedAt: new Date().toISOString(),
		route: live.route ?? "unknown",
		env: {
			tilesHost: tilesHost() ?? "(unconfigured)",
			workerTarget: getWorkerTarget(),
			blobTileZ: BLOB_TILE_Z,
			gridRadiusKm: GRID_RADIUS_KM,
			userAgent:
				typeof navigator === "undefined" ? "" : navigator.userAgent,
			devicePixelRatio:
				typeof window === "undefined" ? 1 : window.devicePixelRatio,
		},
		heap: {
			nowMb: live.heapNowMb ?? null,
			lowMb: live.heapLowMb ?? null,
			peakMb: live.heapPeakMb ?? null,
			sinceLoadMb:
				live.heapNowMb != null && live.heapAtLoadMb != null
					? live.heapNowMb - live.heapAtLoadMb
					: null,
			note: HEAP_NOTE,
		},
		layers: live.layers ?? [],
		bake: {
			on: live.bakeOn ?? false,
			pending: live.bakePending ?? 0,
			failing: live.bakeFailing ?? 0,
			secs: live.bakeSecs ?? 0,
			stalled: live.bakeStalled ?? false,
			note: live.bakeNote ?? "",
		},
		work: workStats(),
		payloads: payloadStats(),
		budget: {
			usedBytes,
			totalBytes: OFFLINE_BUDGET_BYTES,
			areas: sorted.length,
		},
		latest: sorted.length > 0 ? geometryFor(sorted[0]) : null,
		areas: sorted.map((r) => summarise(r, version)),
		uncoveredPins,
	};
}

/** ONE blob's metadata + memory — NOT the whole device (collectDebugReport's areas array can be ~5,000 lines for 391 areas); this is what the export button actually calls. */
export interface FocusedBlobReport {
	schema: typeof DEBUG_REPORT_SCHEMA;
	capturedAt: string;
	route: string;
	env: DebugReport["env"];
	heap: DebugReport["heap"];
	/** Per-layer story for the focused blob — feed, circuit status, whether arrived, and why not; arrived:false + status:"ok" means the download landed but carried nothing for this layer. */
	layers: {
		key: string;
		label: string;
		on: boolean;
		feed: "sat" | "pack" | "fires" | null;
		status: CircuitState;
		arrived: boolean;
		reason: string;
		/** What's meant to accompany a blob for this layer & where — lets a reader tell MISSING apart from never-part-of-the-deal. */
		expects: string;
	}[];
	/** Focused blob's full geometry (corners, reach, offset) — same shape as `latest` in the full report; null if nothing cached yet. */
	blob: BlobGeometryReport | null;
	/** Work meter — timing rows, circuits (grey/yellow/green/red per download), probes; folded into this one export instead of a separate "copy JSON". */
	meter: ReturnType<typeof meterSnapshot>;
	/** Device totals + last five imports, so a report states disk state instead of making the reader infer it from one blob. */
	disk: {
		areas: number;
		bytes: number;
		recentImports: {
			areaKey: string;
			bakedAt: string;
			bytes: number;
			tiles: number;
			photo: boolean;
		}[];
	};
}

/** Per layer: the data a blob is SUPPOSED to carry, and where — plain sentences meant to be pasted and read directly. */
const EXPECTS: Record<string, string> = {
	sat: "one satellite photo per pin, ~2 km around it, in IndexedDB gc-offlineSatellite (photoBytes)",
	vector:
		"z8 blob tiles of roads (+ water when the Worker ships it) for the 30 km disc, keyed pin/<lng>,<lat>/8/x/y in gc-offlineTiles (lineBytes, lineCount = tiles)",
	labels: "town + road labels inside the same z8 blob tiles — currently NOT shipped by the Worker (roads only)",
	camps: "campground / place POIs inside the same z8 blob tiles — currently NOT shipped by the Worker",
	hospitals: "hospital POIs inside the same z8 blob tiles — currently NOT shipped by the Worker",
	fires: `hotspots within FIRE_RADIUS_KM of the pin, in the fires store — per-pin fire refresh is ${FIRE_REFRESH_ENABLED ? "ON" : "OFF (FIRE_REFRESH_ENABLED=false in bakeService): fires are not baked per pin at the moment, so this row stays grey by design"}`,
};

/** Build a report scoped to ONE blob — the LAST SUCCESSFUL IMPORT, the same row the blob panel hoists as FOCUSED — instead of every area on the device. */
export async function collectFocusedBlobReport(
	live: LivePanelState = {},
): Promise<FocusedBlobReport> {
	const records = await allCoverage();
	// Same rule as OfflineBlobPanel's `focused`: bytes landed, newest bakedAt (falling back to lastTouched for older records).
	const sorted = records
		.filter((r) => r.hasPhoto || r.hasLines)
		.sort(
			(a, b) =>
				(b.bakedAt ?? b.lastTouched ?? 0) - (a.bakedAt ?? a.lastTouched ?? 0),
		);

	return {
		schema: DEBUG_REPORT_SCHEMA,
		capturedAt: new Date().toISOString(),
		route: live.route ?? "unknown",
		env: {
			tilesHost: tilesHost() ?? "(unconfigured)",
			workerTarget: getWorkerTarget(),
			blobTileZ: BLOB_TILE_Z,
			gridRadiusKm: GRID_RADIUS_KM,
			userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
			devicePixelRatio:
				typeof window === "undefined" ? 1 : window.devicePixelRatio,
		},
		heap: {
			nowMb: live.heapNowMb ?? null,
			lowMb: live.heapLowMb ?? null,
			peakMb: live.heapPeakMb ?? null,
			sinceLoadMb:
				live.heapNowMb != null && live.heapAtLoadMb != null
					? live.heapNowMb - live.heapAtLoadMb
					: null,
			note: HEAP_NOTE,
		},
		layers: LAYER_TOGGLES.map((t) => {
			const on = live.layers?.find((l) => l.key === t.key)?.on ?? true;
			const feed = t.feed ?? null;
			const c = feed ? circuitOf(feed) : undefined;
			const status: CircuitState = c?.state ?? "idle";
			const top = sorted[0];
			// z8 blob tile currently holds only the "roads" source layer (Worker's keepSetForZoom strips labels/POIs/water) — update packHoldsThisLayer when that changes.
			const packHoldsThisLayer = t.key === "vector";
			const arrived =
				feed === "sat"
					? top?.hasPhoto === true
					: feed === "pack"
						? packHoldsThisLayer && top?.hasLines === true && (top.lineCount ?? 0) > 0
						: feed === "fires"
							? status === "ok"
							: false;
			let reason: string;
			if (!feed) reason = "no download feeds this layer";
			else if (feed === "pack" && !packHoldsThisLayer)
				reason = `pack holds a roads layer only — the Worker ships no ${t.label} data in the z8 blob (worker/src/packBuilder.ts keepSetForZoom)`;
			else if (status === "err") reason = `${feed} download broke: ${c?.note || "no detail"}`;
			else if (status === "transit") reason = `${feed} request is out, nothing back yet`;
			else if (status === "idle" && arrived) reason = "on disk from an earlier session — not requested since this page loaded";
			else if (status === "idle") reason = `never requested — nothing has asked the ${feed} download yet`;
			else if (!arrived) reason = `${feed} download landed (${c?.note || "ok"}) but the focused blob holds no ${t.label} data`;
			else reason = `arrived — ${c?.note || "ok"}`;
			const expects = EXPECTS[t.key] ?? "—";
			return { key: t.key, label: t.label, on, feed, status, arrived, reason, expects };
		}),
		meter: meterSnapshot(),
		disk: {
			areas: records.length,
			bytes: records.reduce((n, r) => n + (r.bytes || 0), 0),
			recentImports: sorted.slice(0, 5).map((r) => ({
				areaKey: r.areaKey,
				bakedAt: new Date(r.bakedAt ?? r.lastTouched ?? 0).toISOString(),
				bytes: r.bytes,
				tiles: r.lineCount ?? 0,
				photo: r.hasPhoto,
			})),
		},
		blob: sorted.length > 0 ? geometryFor(sorted[0]) : null,
	};
}

/** Stable filename for a saved report. */
export function debugReportFilename(at = new Date()): string {
	return `getcache-debug-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}


/** Compact JSON — primitive-only objects render on one line, everything else nests with two spaces (cuts pretty-print height ~3x while staying diffable). */
export function compactJson(v: unknown, indent = ""): string {
	const isLeaf = (x: unknown) =>
		x === null || typeof x !== "object";
	if (isLeaf(v)) return JSON.stringify(v);
	const pad = indent + "  ";
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		if (v.every(isLeaf)) return JSON.stringify(v);
		return "[\n" + v.map((x) => pad + compactJson(x, pad)).join(",\n") + "\n" + indent + "]";
	}
	const entries = Object.entries(v as Record<string, unknown>);
	if (entries.length === 0) return "{}";
	if (entries.every(([, x]) => isLeaf(x) || (Array.isArray(x) && x.every(isLeaf)))) {
		return "{ " + entries.map(([k, x]) => JSON.stringify(k) + ": " + JSON.stringify(x)).join(", ") + " }";
	}
	return (
		"{\n" +
		entries.map(([k, x]) => pad + JSON.stringify(k) + ": " + compactJson(x, pad)).join(",\n") +
		"\n" + indent + "}"
	);
}
