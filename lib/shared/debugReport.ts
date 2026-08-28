/**
 * debugReport.ts — ONE snapshot of everything worth knowing about the offline
 * map, as plain JSON. A screenshot plus one of these should be a smoking gun.
 *
 * ⛔ WHY GEOMETRY, NOT JUST BYTES
 *
 * OFFLINE_MAP_SPEC.md §9 rule 4: "Every offline bug this project has had was
 * the same shape: correct bytes in the wrong box. Feature counts and byte
 * totals all looked healthy throughout." So a report that says `64 KB · 3,286
 * features` is worthless on its own — that is exactly what the 45 km, 27.9 km
 * and 50 km bugs each printed while broken. The fields that FOUND those bugs
 * are the blob's CORNERS, its REACH in km, and its OFFSET from the pin, and
 * those are mandatory here.
 *
 * ⛔ ONE AREA AT A TIME — never a viewport query.
 *
 * Same rule: "Make sure it can never report another pin's data as this pin's —
 * the equivalent check in the previous attempt queried the whole viewport, so a
 * neighbouring pin's roads made it report success." Every BlobGeometryReport
 * below is built from ONE CoverageRecord and its own areaKey. There is no
 * bounds query anywhere in this file, and there must never be one.
 *
 * ⛔ NO APP IMPORTS. THIS FILE IS THE PORTABLE UNIT.
 *
 * Rule 5: "The offline map must not import app UI components, stores, or
 * utilities. Give it a narrow, explicit interface — it needs a list of
 * {lng, lat} and nothing else." So pins arrive as a PARAMETER; this module
 * never reaches for mapStore or TinyBase. debugReport.portability.test.ts
 * fails the build if that ever changes — which is what keeps this liftable
 * into rapper without archaeology.
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

/** The schema version of the emitted JSON. Bump when a field's MEANING changes
 *  (a rename or retype), so an old file is never silently misread as a new one. */
export const DEBUG_REPORT_SCHEMA = 1 as const;

export interface LngLatPin {
	lng: number;
	lat: number;
}

/** Full geometry for ONE area. Only the newest area gets this treatment; the
 *  rest are summarised (see AreaSummary) so the file stays paste-able. */
export interface BlobGeometryReport {
	areaKey: string;
	pin: LngLatPin;
	/** The cell this pin resolves to, as `z_ix_iy`. Note the z: a pin near a
	 *  tile edge is PROMOTED to a shallower tile so its radius fits, so this is
	 *  not always BLOB_TILE_Z. Reading the constant instead of the real z is the
	 *  "address and geometry disagree" bug in miniature. */
	cell: string;
	cellZoom: number;
	/** [w,s], [e,s], [e,n], [w,n] — the box the blob was actually served in. */
	corners: [number, number][];
	box: { w: number; s: number; e: number; n: number };
	/** How far the box reaches from the pin, per edge. Compare against
	 *  gridRadiusKm: a reach of ~55 km against a promised 30 km is the bug. */
	reachKm: { n: number; s: number; e: number; w: number };
	/** Pin → centre-of-box, in km. THE detector. ~0 is healthy; tens of km is
	 *  the 45/27.9/50 km class of bug the spec names. */
	offsetKm: number;
	bytes: number;
	photoBytes: number;
	lineBytes: number;
	lineCount: number;
	hasPhoto: boolean;
	hasLines: boolean;
	/** The blob-geometry signature this area was built under. `null` means the
	 *  record predates versioning — treated as stale by the reconcile. */
	blobVersion: string | null;
	lastTouched: string;
}

/** One compact line per area. No corners array — that is what keeps a few
 *  hundred areas inside a file you can paste into a chat. offsetKm survives
 *  the squeeze because scanning it down the list is how a SYSTEMIC
 *  mis-boxing shows up (every area wrong the same way). */
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
		/** "(unconfigured)" when no app called configureTilesHost() — a real
		 *  state worth seeing in a report, not an absent field. */
		tilesHost: string;
		/** WHICH worker served this session — production / localDev.
		 *  Without it a report is ambiguous: identical-looking bad output from
		 *  the two could be different bugs. */
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
		/** Kept as a FIELD, not panel prose: performance.memory reports this
		 *  realm only. On the offline route the workers hold more than the page,
		 *  which is precisely why an 800 MB defect hid for weeks. */
		note: string;
	};
	/** Which map layers were visible when this was captured. A heap number
	 *  without this is uninterpretable — "310 MB" means nothing until you know
	 *  whether satellite was on. */
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
	/** The newest area, in full. "The latest blob." */
	latest: BlobGeometryReport | null;
	areas: AreaSummary[];
	/** Pins known to the caller but with NO coverage record — i.e. features the
	 *  bake has not covered. Empty is healthy; a long list on a settled app is
	 *  itself the finding. */
	uncoveredPins: LngLatPin[];
}

export const HEAP_NOTE =
	"main thread only — workers NOT counted; see DevTools → Memory for the total";

/** Geometry for ONE record, derived from ITS OWN key alone. */
export function geometryFor(rec: CoverageRecord): BlobGeometryReport {
	// cellOf may PROMOTE an edge pin to a shallower zoom; cellBox reads c.z, so
	// box and address can never disagree here.
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

/** Live readings the panel already holds. Passed IN rather than read from a
 *  store, so this module stays free of Svelte state and stays portable. */
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
	/** Every pin the caller knows about. Rule 5's "list of {lng,lat} and
	 *  nothing else" — used ONLY to report which pins lack coverage. */
	pins?: LngLatPin[];
	/** The blob signature areas SHOULD hold, for the stale flag. */
	currentBlobVersion?: string | null;
}

/**
 * Build the whole report. Reads the coverage registry (its own IndexedDB) and
 * the work meter; everything else arrives via `live`.
 */
export async function collectDebugReport(
	live: LivePanelState = {},
): Promise<DebugReport> {
	const records = await allCoverage();
	// Newest first — "the latest blob" is the head of this list.
	// Same rule as OfflineBlobPanel's `focused`: bytes landed, newest bakedAt
	// (falling back to touch for records written before bakedAt existed).
	const sorted = records
		.filter((r) => r.hasPhoto || r.hasLines)
		.sort(
			(a, b) =>
				(b.bakedAt ?? b.lastTouched ?? 0) - (a.bakedAt ?? a.lastTouched ?? 0),
		);
	const version = live.currentBlobVersion ?? null;

	const usedBytes = sorted.reduce((n, r) => n + (r.bytes ?? 0), 0);

	// Which known pins have no record at all. Matched on the SAME 4dp key the
	// satellite baker writes, so this can't drift from how areas are stored.
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

/**
 * ONE blob's metadata + the live session's memory reading — NOTHING about the
 * other cached areas. `collectDebugReport`'s `areas` array is every blob on
 * the device (measured: 391 rows → a ~5,000-line file for a single export
 * tap); export json is scoped to "the one in the picture", not a device
 * inventory, so this is the shape that button actually calls.
 */
export interface FocusedBlobReport {
	schema: typeof DEBUG_REPORT_SCHEMA;
	capturedAt: string;
	route: string;
	env: DebugReport["env"];
	heap: DebugReport["heap"];
	/**
	 * PER LAYER, THE WHOLE STORY — the block you paste to an AI. Chris, 28 Aug
	 * 2026: "arrived, rejected, and god willing some kind of reason." So each
	 * layer says which download it rides on, what that download's circle reads
	 * right now, whether ITS data is actually in the focused blob, and why not
	 * in words. `arrived:false` with `status:"ok"` is the important row: the
	 * download landed but carried nothing for this layer (roads-only pack).
	 */
	layers: {
		key: string;
		label: string;
		on: boolean;
		feed: "sat" | "pack" | "fires" | null;
		status: CircuitState;
		arrived: boolean;
		reason: string;
		/** What is MEANT to accompany a blob for this layer, and where it
		 *  would live — so a reader can tell MISSING apart from NEVER-PART-
		 *  OF-THE-DEAL. Chris: "it should at least list the types of data
		 *  that's meant to accompany a blob… fires are false but that's
		 *  cause it's not based on pins at the moment." */
		expects: string;
	}[];
	/** The focused blob's full geometry — corners, reach, offset — same fields
	 *  `latest` carries in the full report. Null if nothing is cached yet. */
	blob: BlobGeometryReport | null;
	/** The work meter — timing rows, the circuits (grey/yellow/green/red per
	 *  download), the probes. ONE export, not two: this used to be a separate
	 *  "copy JSON" on the meter's footer, so a report of "the blob is wrong"
	 *  never said what the circuits read at the time. Chris, 28 Aug 2026:
	 *  "there shouldn't be TWO kinds." */
	meter: ReturnType<typeof meterSnapshot>;
	/** What the device holds, in one line, and the last five arrivals — so a
	 *  report says "396 areas, 106 MB, last five imports were…" instead of
	 *  leaving the reader to infer the state of the disk from one blob. */
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

/** Per layer: the data a blob is SUPPOSED to carry for it, and where. Kept
 *  as plain sentences — this is read by a person (or an AI) in a paste. */
const EXPECTS: Record<string, string> = {
	sat: "one satellite photo per pin, ~2 km around it, in IndexedDB gc-offlineSatellite (photoBytes)",
	vector:
		"z8 blob tiles of roads (+ water when the Worker ships it) for the 30 km disc, keyed pin/<lng>,<lat>/8/x/y in gc-offlineTiles (lineBytes, lineCount = tiles)",
	labels: "town + road labels inside the same z8 blob tiles — currently NOT shipped by the Worker (roads only)",
	camps: "campground / place POIs inside the same z8 blob tiles — currently NOT shipped by the Worker",
	hospitals: "hospital POIs inside the same z8 blob tiles — currently NOT shipped by the Worker",
	fires: `hotspots within FIRE_RADIUS_KM of the pin, in the fires store — per-pin fire refresh is ${FIRE_REFRESH_ENABLED ? "ON" : "OFF (FIRE_REFRESH_ENABLED=false in bakeService): fires are not baked per pin at the moment, so this row stays grey by design"}`,
};

/** Build a report scoped to ONE blob — the LAST SUCCESSFUL IMPORT, the same
 *  row the blob panel hoists as FOCUSED — instead of every area on the device. */
export async function collectFocusedBlobReport(
	live: LivePanelState = {},
): Promise<FocusedBlobReport> {
	const records = await allCoverage();
	// Same rule as OfflineBlobPanel's `focused`: bytes landed, newest bakedAt
	// (falling back to touch for records written before bakedAt existed).
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
			// WHAT THE FOCUSED BLOB ACTUALLY HOLDS FOR THIS LAYER. MEASURED 28 Aug
			// 2026 (decodeV4TileLayerStats on a fresh pack): the z8 blob tile has
			// ONE source layer, `roads` — the Worker's keepSetForZoom() strips
			// labels, POIs and water at the blob level. So every pack layer but
			// roads is "download landed, carried nothing for me" until the Worker
			// ships them. When that changes, this is the line to change.
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


/**
 * COMPACT JSON — readable, not sprawling. Objects whose values are all
 * primitives go on ONE line; everything else nests with two spaces. A 400-line
 * pretty-print of a report was mostly newlines; this is the same report at a
 * third the height, still diff-able, still greppable.
 */
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
