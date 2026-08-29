/** ⛔ offlineBakeService — bakes/downloads/evicts every feature's blob APP-WIDE the moment it's touched, independent of the /mobile/offlinev4 viewer; the viewer only VIEWS, never bakes. (See OFFLINE_PLAN.md "Reconcile", [[cross-module-state-use-applier-pattern]].) */

import { isDownloadGuardTripped } from "../store/downloadGuard";

import { FIRE_REFRESH_ENABLED } from "../../shared/bakeFlags";
import { registerWipeStopper } from "../store/wipe";
import {
	allCoverage,
	backfillCoverageMirror,
	type CoverageRecord,
	dropCoverage,
	EST_AREA_BYTES,
	noteCoverage,
	OFFLINE_BUDGET_BYTES,
} from "../store/coverageRegistry";
import {
	deleteVectorAt,
	getVectorFeaturesAt,
	getVectorKeys,
} from "../store/tombstones/legacyVectorCleanup";
import {
	BAKE_RADIUS_KM,
	BAKE_VERSION,
	bakeSatelliteImage,
	deleteSatImage,
	getSatImageByKey,
	getSatKeys,
	satImageKey,
	satImageMeta,
} from "../satellite/satelliteImage";
import { MAP_HOME_CENTER } from "../../shared/homeCentre";
import { vlog } from "../../shared/verboseLog";
import type { HostPorts } from "../../shared/hostPorts";
import { needsFireDisc, needsMapBlob, snapLiveAnchor } from "../../shared/liveAnchor";
import { checkDownloadGate, noteDownloadedBytes } from "../offlineDownloadGate";
import {
	areaCentreCovered,
	areaTilesPresent,
	areaTilesPresentIn,
	downloadV4Area,
	getAllTileKeys,
	PACK_FORMAT_VERSION,
	purgeEmptyTilesOnce,
} from "../../r2Worker/local_dev/roads/packDownload";
import { GRID_RADIUS_KM } from "../../contract/blob";
import { BLOB_TILE_Z } from "../../contract/grid";
import { FIRE_RADIUS_KM } from "../../shared/fireContract";
import { purgeDeadRoadRasters } from "../store/tombstones/purgeRoadRasters";
import { beginWork, noteQueued, noteSkip , noteCircuit } from "../../shared/workMeter.svelte";

/** BLOB_VERSION — signature of a complete blob (ring geometry + pack format + satellite radius/bake version); derived, not hand-bumped, so any input change forces old pins to re-download under the new shape. */
export const BLOB_VERSION = [
	`pf${PACK_FORMAT_VERSION}`,
	// Deliberately NOT a km cell size — a slippy tile narrows with latitude, so a fixed number would lie everywhere but one parallel.
	`cell@${BLOB_TILE_Z}r${GRID_RADIUS_KM}km`,
	`sat${BAKE_RADIUS_KM}km`,
	`bake${BAKE_VERSION}`,
].join("|");

export interface OfflineBakeStatus {
	/** The active-map spinner note ("Saving offline map…" / ""). */
	note: string;
	/** Bumps whenever on-disk data changed (download/evict) — the viewer re-decodes + re-mounts photos on each bump. */
	generation: number;
	/** TRUE while a pass is actively fetching missing blobs (not just idling). */
	downloading: boolean;
	/** How many areas the CURRENT pass still has to download (counts down live). */
	pending: number;
	/** How many areas' photo bakes are in backoff (source throttling); non-zero at idle = broken features waiting to retry. */
	failing: number;
	/** WHERE the current download is ([lng,lat] or null when idle) — the waiting animation anchors here, not the map centre. */
	at: [number, number] | null;
}
let status: OfflineBakeStatus = {
	note: "",
	generation: 0,
	downloading: false,
	pending: 0,
	failing: 0,
	at: null,
};
const listeners = new Set<(s: OfflineBakeStatus) => void>();

/** Subscribe to bake status — fires immediately with current status, then on every change; returns an unsubscribe fn. */
export function subscribeOfflineBake(
	fn: (s: OfflineBakeStatus) => void,
): () => void {
	listeners.add(fn);
	fn(status);
	return () => listeners.delete(fn);
}
function emit(): void {
	for (const fn of listeners) fn(status);
}
function setNote(note: string): void {
	if (status.note === note) return;
	status = { ...status, note };
	emit();
}
/** Update the live activity counters (downloading / pending / failing). */
function setActivity(
	downloading: boolean,
	pending: number,
	failing: number,
	at: [number, number] | null = status.at,
): void {
	if (
		status.downloading === downloading &&
		status.pending === pending &&
		status.failing === failing &&
		status.at === at
	)
		return;
	status = { ...status, downloading, pending, failing, at };
	emit();
}

/** Publish WHERE the current download is, so the UI can sit over it. */
function setAt(at: [number, number] | null): void {
	if (status.at === at) return;
	status = { ...status, at };
	emit();
}
function bumpGeneration(): void {
	status = { ...status, generation: status.generation + 1 };
	emit();
}

/** THE HOST PORT — the engine's entire view of the app (see hostPorts.ts); null until startOfflineBakeService runs, read as "no places yet" rather than thrown. */
let ports: HostPorts | null = null;

let reconciling = false;
let rerun = false;
let backfilled = false;

// Reconcile-pass scratch: coverage keyed by areaKey (so ensureAreaData can probe disk), and areaKey → newest feature touch time.
let covByKey = new Map<string, CoverageRecord>();
let touchByKey = new Map<string, number>();

// SATELLITE BACKOFF — a failed photo bake gets an exponential cooldown (cap 15min) so retries don't keep hammering a throttled source; does NOT gate roads, only the photo.
const satCooldown = new Map<string, { until: number; fails: number }>();
// FIRE BACKOFF — same shape, separate map: a throttled photo source must not suppress fires, and a fire-source outage must not stall photo bakes.
const fireCooldown = new Map<string, { until: number; fails: number }>();
// THIS PASS's live position (null = unknown/not permitted) — read once at the top of bakeAll and reused by the fire pass.
let liveFix: [number, number] | null = null;
// Did THIS pass change anything on disk (download/bake/eviction)? Drives the generation bump that tells the viewer to re-decode.
let passChanged = false;

/** ⛔ Tally is CUMULATIVE across an entire run (not per pass/slice) and prints nothing unconditionally — a recurring 20s tick has nothing new to say each time; see reportRun. Opt-in detail: localStorage.rtVerbose = 'wall'. */
const pass = {
	slices: 0,
	areas: 0,
	tiles: 0,
	bytes: 0,
	ms: 0,
	empty: 0,
	cacheHits: 0,
	builds: new Set<string>(),
};
/** True while the next bakeAll is a CONTINUATION of the current run, not a new one. */
let resumingRun = false;
function resetPassTally(): void {
	pass.slices = 0;
	pass.areas = 0;
	pass.tiles = 0;
	pass.bytes = 0;
	pass.ms = 0;
	pass.empty = 0;
	pass.cacheHits = 0;
	pass.builds.clear();
}
/** Print the RUN report — only once the conveyor drained AND did something; `more` means another slice is queued, so reporting then would just report the time-slicing. */
function reportRun(more: boolean): void {
	if (more) return; // mid-run: the next slice keeps accumulating into `pass`
	if (pass.areas === 0) return; // fully baked: silence is the correct report
	const mb = (pass.bytes / 1e6).toFixed(1);
	// `empty` areas are NORMAL (ocean/wilderness); ALL-empty is the tell that the Worker is answering wrong.
	const allEmpty = pass.empty === pass.areas;
	const emptyNote =
		pass.empty > 0 ? ` · ${pass.empty} empty` : "";
	const build = pass.builds.size ? ` · ${[...pass.builds].join("+")}` : "";
	const cache = pass.cacheHits ? ` · ${pass.cacheHits} cached` : "";
	const slices = pass.slices > 1 ? ` · ${pass.slices} slices` : "";
	const line = `${pass.areas} area(s), ${pass.tiles} tiles, ${mb} MB in ${(pass.ms / 1000).toFixed(1)}s${cache}${build}${slices}${emptyNote}`;

	// ⛔ A heartbeat is not a report — this line is opt-in only (localStorage.rtVerbose = 'wall'); a recurring 20s tick has nothing new to say by printing unconditionally.
	vlog("wall", line);

	// ⛔ ONE line per pass at console.warn, ALWAYS (not opt-in) — vlog()/console.log is hidden by DevTools "Custom levels" filters, which cost a full day of silent-looking real work going unseen. [[no-silent-fallbacks]]
	console.warn(`[roads] pass done — ${line}`);

	// The one exception that's genuinely news: EVERY area came back empty — the Worker is answering wrong (a missing tile renders and throws nothing otherwise).
	if (allEmpty) {
		console.warn(
			`[roads] ⚠️ ALL ${pass.areas} area(s) came back EMPTY — the Worker returned no tiles (${build.trim() || "unknown build"})`,
		);
	}
}

// LIE-FI GUARDS (regression, July-6 field failure): weak-signal fetches used to hang 30–75s and starve the map — enforced in kickBake via BOOT DELAY (20s) and TIMEOUT BACKOFF (60s doubling, cap 5min).
const BOOT_BAKE_DELAY_MS = 20_000;
/** How long ONE pass may spend downloading before stopping cleanly — measured 81s unbounded (87% of tab allocation, heap never idle); 5s lands 1–3 areas per pass. */
const BAKE_PASS_BUDGET_MS = 5_000;
/** A budget-paused pass has work LEFT, so it must not wait the full 20s — long enough for the main thread and GC to breathe. */
const BUDGET_RESUME_MS = 1_500;
const TIMEOUT_BACKOFF_START_MS = 60_000;
const TIMEOUT_BACKOFF_CAP_MS = 300_000;
let bootBakeAt = 0; // no kicks before this timestamp
let timeoutBackoffUntil = 0;
let nextTimeoutBackoffMs = TIMEOUT_BACKOFF_START_MS;
let passSawTimeout = false; // did THIS pass hit a TimeoutError/AbortError?
// The download circuit breaker latches for the session — announce it once, not on every 20s tick.
let guardTripAnnounced = false;

/** AbortSignal.timeout → "TimeoutError"; a manual abort → "AbortError". */
function isTimeoutErr(err: unknown): boolean {
	const name = (err as { name?: string } | null)?.name;
	return name === "TimeoutError" || name === "AbortError";
}

/** Ensure ONE area's blob (photo + tiles) is on disk and recorded — idempotent (cached if present), keyed by AREA not map, so pins sharing an area bake once. */
async function ensureAreaData(
	center: [number, number],
	corridor: boolean,
): Promise<void> {
	const key = satImageKey(center);
	const [lng, lat] = center;
	let photoBytes = 0;
	let lineBytes = 0;
	let lineCount = 0;
	let hasPhoto = false;
	let hasLines = false;
	const prevCov = covByKey.get(key);

	// Photo and tiles are two INDEPENDENT fetches, overlapped via Promise.all instead of serial (photo alone is ~10s); each task writes only its own outer vars, so no race.
	//
	// CORRIDOR (line features): skip the satellite entirely — roads-only ribbon via downloadV4Area's `corridor` flag; a corridor area is "complete" with NO photo.
	const satTask = (async (): Promise<void> => {
		if (corridor) return;
		// BACKOFF: if this area's photo bake recently failed, leave it alone until the cooldown lapses — roads still download.
		const cd = satCooldown.get(key);
		if (cd && cd.until > Date.now()) return;
		const hadPhoto = prevCov?.hasPhoto === true;
		noteCircuit("sat", "transit", "", key);
		let sat: Awaited<ReturnType<typeof bakeSatelliteImage>>;
		try {
			sat = await bakeSatelliteImage(center);
		} catch (err) {
			noteCircuit("sat", "err", err instanceof Error ? err.message : String(err), key);
			throw err;
		}
		if (sat) {
			noteCircuit("sat", "ok", `${(sat.blob.size / 1024).toFixed(0)} KB`, key);
			hasPhoto = true;
			photoBytes = sat.blob.size;
			satCooldown.delete(key); // success → clear any backoff
			if (!hadPhoto) passChanged = true; // a photo that wasn't there before
		} else {
			// Bake FAILED (throttled/empty) — exponential backoff 30s→15m cap so the source can recover.
			noteCircuit("sat", "err", "photo bake returned nothing (throttled / empty)", key);
			const fails = (cd?.fails ?? 0) + 1;
			satCooldown.set(key, {
				fails,
				until:
					Date.now() + Math.min(900_000, 30_000 * 2 ** Math.min(fails - 1, 5)),
			});
		}
	})();

	const tilesTask = (async (): Promise<void> => {
		// Do NOT trust the registry flag — verify tiles are really on disk (a DB bump/eviction can delete them while hasLines lingers); re-download whenever gone (self-heal).
		let tilesValid = false;
		const versionCurrent = prevCov?.blobVersion === BLOB_VERSION;
		if (prevCov?.hasLines && versionCurrent) {
			// Loose probe (any disc key) — a strict centre probe thrashes on edge-sparse areas (data far from pin) causing re-download every pass.
			//
			// lineCount===0 must be EXPLICIT — undefined means "unknown" and must fall through to the probe; collapsing unknown→0 would mark a never-verified area complete forever.
			tilesValid =
				prevCov.lineCount === 0 || (await areaTilesPresent(lng, lat));
		} else {
			// NO RECORD or STALE version → STRICT centre probe; adopt only if a CURRENT neighbour already covers it (dedup for clustered stale areas), else re-download.
			tilesValid = await areaCentreCovered(lng, lat);
		}
		if (tilesValid) {
			hasLines = true;
			lineBytes = prevCov?.lineBytes ?? 0;
			lineCount = prevCov?.lineCount ?? 0;
		} else if (typeof navigator !== "undefined" && navigator.onLine === false) {
			// OFFLINE — skip quietly (area stays un-recorded for the next ONLINE pass); throwing here would abort the whole pass and starve the rest.
		} else {
			// ⛔ Per-area logging used to print 3 lines × dozens of areas (mostly identical) — now summarized once in the pass tally; per-area detail via localStorage.rtVerbose='wall'.
			vlog(
				"wall",
				`downloading 30 km blob @ ${lng.toFixed(4)},${lat.toFixed(4)}…`,
			);
			setAt([lng, lat]);
			const t0 = Date.now();
			// Timed via beginWork (runs/last/worst per named slot, already rendered by the meter) — a blob arrival is just another slot, not a second timing mechanism.
			const doneRoads = beginWork("roads");
			let dl: Awaited<ReturnType<typeof downloadV4Area>>;
			try {
				dl = await downloadV4Area(lng, lat, undefined, corridor);
			} catch (err) {
				doneRoads(true); // count it as a failed run, not a missing one
				throw err;
			}
			doneRoads();
			setAt(null);
			const ms = Date.now() - t0;
			vlog(
				"wall",
				`ARRIVED: ${dl.downloaded} tiles, ${(dl.bytes / 1e6).toFixed(2)} MB, ${ms} ms` +
					(dl.build ? ` · ${dl.build}` : "") +
					(dl.cache ? ` · cache ${dl.cache}` : "") +
					(dl.diag ? ` · ${dl.diag}` : ""),
			);
			// Fold into the pass tally — printed ONCE when the pass ends.
			pass.areas++;
			pass.tiles += dl.downloaded;
			pass.bytes += dl.bytes;
			pass.ms += ms;
			if (dl.downloaded === 0) pass.empty++;
			if (dl.cache === "HIT") pass.cacheHits++;
			// WHICH WORKER BUILD answered — one build per pass is the norm; the Set only grows if a deploy lands mid-pass (itself worth seeing).
			if (dl.build) pass.builds.add(dl.build);
			hasLines = true; // covered (even if empty) so the record persists
			lineBytes = dl.bytes;
			lineCount = dl.downloaded;
			noteDownloadedBytes(dl.bytes); // tally toward the soft +100 MB cellular gate
			if (dl.downloaded > 0) {
				passChanged = true;
				// Nothing to invalidate any more — the road-raster (which used to go stale here) is gone; vectors ARE the tiles now, so they can't disagree with themselves.
			}
		}
	})();

	await Promise.all([satTask, tilesTask]);

	await noteCoverage(
		key,
		lng,
		lat,
		{
			hasPhoto,
			hasLines,
			bytes: photoBytes + lineBytes,
			photoBytes,
			lineBytes,
			lineCount,
			blobVersion: BLOB_VERSION,
			// "Last import" for the blob panel — only when bytes actually landed.
			...(hasPhoto || hasLines ? { bakedAt: Date.now() } : {}),
		},
		false,
		touchByKey.get(key), // prefer the area's real feature touch time for eviction order
	);
}

async function pruneArea(key: string): Promise<void> {
	await deleteSatImage(key);
	await deleteVectorAt(key);
	await ports?.fires?.delete(key); // an evicted area sheds ALL its data together
	await dropCoverage(key);
	passChanged = true;
}

/** ⛔ THE FIRE PASS runs OUTSIDE ensureAreaData's completion gate — fires are perishable (go stale hourly) unlike immutable tiles/photos, so they must not live inside a "runs until done, then never again" function (see tripwire 7). Runs for CORRIDOR areas too. Fires must fail alone, never break the map. */
async function refreshFires(
	centres: ReadonlyArray<[number, number]>,
): Promise<void> {
	// NO FIRE PORT → NO FIRE PASS — a host that omits `fires` (the rapper demo) gets a working map that never reaches for hotspots.
	const fires = ports?.fires;
	if (!fires) return;

	// OFFLINE — keep whatever we have; never clear on failure — stale dots beat an empty map that reads as "no fires near you".
	if (typeof navigator !== "undefined" && navigator.onLine === false) return;

	// ARRIVAL — ignores the TTL once; consumed (not just read) so a failed/skipped pass can't leave it armed and re-fetch every 20s.
	const onDemand = fires.takeArrival();

	for (const [lng, lat] of centres) {
		const key = satImageKey([lng, lat]);
		const cd = fireCooldown.get(key);
		if (cd && cd.until > Date.now()) continue;
		try {
			const prev = await fires.read(key);
			// TTL answers "gone stale?" not "did the user just arrive and ask?" — a 59-min-old record passing fireIsFresh silently handed an hour-old answer; `onDemand` covers that moment.
			if (prev && fires.isFresh(prev) && !onDemand) continue;
			// GEOGRAPHIC CONTAINMENT — a fire disc is 500km vs a 40km map area, so a neighbouring FRESH disc covering this centre (FIRE_TRIGGER_KM) is reused; only FRESH discs count, or a stale one could "cover" an area with nothing forever.
			//
			// ⚠️ An ARRIVAL refresh must pierce this gate too, or it would quietly undo the TTL bypass above. COVERAGE ONLY — reads centres, never full hotspot records (avoids holding tens of thousands of detections in heap).
			const coveringCentres = (await fires.coverage())
				.filter((c) => fires.isCoverageFresh(c))
				.map((e) => e.center);
			if (!onDemand && !needsFireDisc([lng, lat], coveringCentres)) continue;
			noteCircuit("fires", "transit");
			const r = await fires.fetchArea(lng, lat);
			await fires.write(key, {
				fetchedAt: r.fetchedAt,
				center: [lng, lat],
				radiusKm: FIRE_RADIUS_KM,
				sourcesOk: r.sourcesOk,
				// COPIED, not aliased — sharing the port's array with the cache entry would let a later mutation on either reach back into the other (the lossy-copy trap). [[quality704-autosave-lossy-copy-trap]]
				hotspots: [...r.hotspots],
			});
			fireCooldown.delete(key);
			noteCircuit("fires", "ok", `${r.hotspots.length} hotspots · ${r.sourcesOk}/3 sats`);
			noteDownloadedBytes(r.bytes); // tally toward the cellular gate
			passChanged = true; // new dots → tell the viewer to repaint
			vlog(
				"fire",
				`[v4 fire] downloaded ${r.hotspots.length} hotspots for ${key} (${(r.bytes / 1024).toFixed(1)} KB, ${r.sourcesOk}/3 satellites)`,
			);
		} catch (err) {
			noteCircuit("fires", "err", err instanceof Error ? err.message : String(err));
			// Same exponential backoff as the satellite bake (30s → 15m cap); the PREVIOUS record is deliberately left in place.
			const fails = (cd?.fails ?? 0) + 1;
			const backoff = Math.min(900_000, 30_000 * 2 ** Math.min(fails - 1, 5));
			fireCooldown.set(key, { fails, until: Date.now() + backoff });
			// codestyle-allow-swallow: not a swallow — this catch drives the retry backoff and warns by default; the layer keeps its last good hotspots.
			console.warn(
				`[v4 fire] fetch failed for ${key} (attempt ${fails}, retrying in ${Math.round(backoff / 1000)}s) — keeping cached hotspots`,
				err,
			);
		}
	}
}

/** THE FORMULA — every feature on every map, newest-touched first, gets its blob until the 1GB budget is full; anything past that (oldest, over budget) is evicted. NOT "the active map" — EVERY feature, always. */
async function bakeAll(): Promise<void> {
	// LATCHED BREAKER = DONE FOR THIS SESSION — bail at the door rather than fail per-area; only a reload resets the guard (downloadGuard.ts, by design).
	if (isDownloadGuardTripped()) {
		// Terminal — returns on EVERY subsequent tick; recorded via noteSkip so the panel reads "latched" rather than looking broken.
		noteSkip("bake", "download guard latched");
		// The breaker can latch mid-run — flush whatever was already fetched rather than losing it, and stop cleanly (prints once; tally is now empty).
		resumingRun = false;
		reportRun(false);
		resetPassTally();
		return;
	}
	if (reconciling) {
		rerun = true;
		noteQueued("bake"); // runaway tell — see workMeter
		noteSkip("bake", "already running");
		return;
	}
	reconciling = true;
	noteQueued("bake", false);
	const bakeDone = beginWork("bake");
	// Declared out here because the `finally` schedules the resume — see the TIME BUDGET note in the conveyor loop below.
	let budgetPaused = false;
	passChanged = false;
	passSawTimeout = false;
	// A RESUMED slice keeps accumulating into the SAME tally (see reportRun); only a genuinely fresh run resets counters.
	if (!resumingRun) resetPassTally();
	resumingRun = false;
	pass.slices++;
	liveFix = null; // stale fix from a previous pass must never leak into this one
	try {
		setNote("Saving offline map\u2026");
		// 1) EVERY area referenced by EVERY feature (deduped), with newest touch time; corridor=true only if EVERY referencing feature is a line (one point forces the full photo).
		const areas = new Map<
			string,
			{ c: [number, number]; corridor: boolean; t: number }
		>();
		const note = (c: [number, number], corridor: boolean, t: number): void => {
			const k = satImageKey(c);
			const prev = areas.get(k);
			areas.set(k, {
				c,
				corridor: prev ? prev.corridor && corridor : corridor,
				t: Math.max(t, prev?.t ?? 0),
			});
		};
		// EVERY place seeds a blob, plots included — a wall-to-wall planting block collapses into one disc via note()'s satImageKey dedup. WHICH rows are places is the HOST's business (hostPorts.ts).
		for (const p of ports?.places() ?? []) {
			const t = Date.parse(p.lastTouched) || 0;
			for (const c of p.anchors) note(c, p.corridor, t);
		}
		// The permanent demo blob — always present, treated as newest so it is never evicted.
		note(MAP_HOME_CENTER, false, Number.POSITIVE_INFINITY);

		// 1b) THE LIVE ANCHOR — a user with no features yet still gets covered at their live position (no prompt, see liveFix.ts); added LAST and gated on containment since note()'s ~11m key assumes anchors don't move.
		//
		// ⚠️ Containment is measured against WHAT IS ON DISK (covByKey), not just this pass's feature anchors — the live anchor is TRANSIENT (never re-noted), so measuring against features alone would report "outside coverage" forever.
		try {
			// Through the PORT — geolocation/permissions are the host's business; a host that omits `gps` gets no live anchor, and feature anchors alone are still a valid map.
			const fix = (await ports?.gps?.()) ?? null;
			if (fix) {
				liveFix = fix; // the fire pass reads this too (different radius)
				// Read the registry HERE rather than covByKey (that snapshot is taken later, step 3, and still holds the PREVIOUS pass's data) — one extra read measures against present truth.
				const stored = await allCoverage();
				const centres = [
					...[...areas.values()].map((a) => a.c),
					// STORED coverage — including the live blob baked on a previous pass.
					...stored.map((r) => [r.lng, r.lat] as [number, number]),
				];
				if (needsMapBlob(fix, centres)) {
					// Snapped, never raw — belt and braces behind containment; corridor:false since a point earns the full photo, newest-touched so it downloads first.
					note(snapLiveAnchor(fix), false, Date.now());
					vlog(
						"map",
						`[v4 live] outside coverage \u2014 baking a blob at your position ${snapLiveAnchor(
							fix,
						)
							.map((n) => n.toFixed(2))
							.join(",")}`,
					);
				}
			}
		} catch (err) {
			// codestyle-allow-swallow: the live anchor is a BONUS — a geolocation hiccup must never abort the pass and starve the user's actual features.
			console.warn("[v4 live] position unavailable this pass", err);
		}

		// 2) NEWEST-TOUCHED FIRST so a just-dropped pin downloads before everything.
		const ordered = [...areas.entries()].sort((a, b) => b[1].t - a[1].t);
		touchByKey = new Map(ordered.map(([k, v]) => [k, v.t]));

		// 3) DISK TRUTH — do NOT trust the registry (it can lie: "photo" with nothing stored); budget counting phantom bytes caused the 6%-coverage bug. The blob store IS the truth.
		//    METADATA ONLY — a version that read whole blobs for `blob.size` allocated 613 MB (97.3% of the profile) and OOM-crashed the tab. Never load pixels on a timer.
		const satKeys = new Set(await getSatKeys()); // ALL present photos (eviction truth)
		// FRESH = present AND baked by CURRENT BAKE_VERSION — an older-format photo is treated as a MISS so it re-bakes; eviction still uses the full satKeys set, so a stale photo is never silently dropped.
		const freshSat = new Set<string>();
		const photoBytes = new Map<string, number>();
		for (const { key, bytes, bakeVersion } of await satImageMeta()) {
			photoBytes.set(key, bytes);
			if (bakeVersion === BAKE_VERSION) freshSat.add(key);
		}
		// covByKey only HINTS ensureAreaData's tile probe; it never gates a decision.
		covByKey = new Map((await allCoverage()).map((r) => [r.areaKey, r]));
		// EVERY stored tile key loaded ONCE per pass — probed in memory (areaTilesPresentIn) instead of per-area IndexedDB opens, which were a real I/O storm at hundreds of areas every 20s.
		const tileKeys = await getAllTileKeys();

		// 4) Keep newest-first until ACTUAL bytes fill the budget — measured in REAL stored bytes so it can never fill on ghosts again; a present blob is zero work.
		// Total bytes ACTUALLY on disk (disk truth) — includes blobs the live map's own satellite cache shares this store with, so the 1GB budget can never be silently overrun.
		// THE CONVEYOR — walk newest-touched first, accumulating kept bytes; within budget = ensure both halves on disk, past it = skip (eviction drops it). A just-touched pin is always first, so it always fits and displaces the oldest.
		//
		// Regression this replaces: the old gate measured TOTAL disk bytes, so a disk full of old photos blocked every new pin's photo and nothing displaced ("stuck at 1GB").
		let keptBytes = 0;
		let gatePaused = false;
		let downloaded = 0; // areas actually fetched this pass (drives the live status)
		// THE TIME BUDGET — work one slice then STOP CLEANLY (never mid-ensureAreaData, which would leave a half-written area); measured 81s unbounded with the heap never idling. Progress is durable, so stopping costs only latency.
		const passDeadline = Date.now() + BAKE_PASS_BUDGET_MS;
		for (const [k, { c, corridor }] of ordered) {
			// Checked at the TOP (full slice for the area about to start) and only after ≥1 area landed — a pass must always make progress.
			if (downloaded > 0 && Date.now() > passDeadline) {
				budgetPaused = true;
				break;
			}
			// Newest-first budget line — corridors carry no photo, so they cost ~0 against the photo budget.
			const sizeGuess = corridor ? 0 : (photoBytes.get(k) ?? EST_AREA_BYTES);
			if (keptBytes + sizeGuess > OFFLINE_BUDGET_BYTES) continue; // older than the line → evicted below
			keptBytes += sizeGuess;
			// COMPLETE = both halves on disk (a corridor needs only tiles).
			const satOnDisk = corridor || freshSat.has(k);
			// ⛔ AN EMPTY AREA IS COMPLETE, NOT MISSING — areaTilesPresentIn honestly answers "no" forever for a server-empty area; without the lineCount===0 short-circuit below, the conveyor re-counted it as work every pass, forever.
			//
			// The gate asks the SAME question ensureAreaData asks — lineCount must be an EXPLICIT 0 (undefined = "never verified"), or an unknown area would be marked complete forever.
			const cov = covByKey.get(k);
			const serverHasNothing =
				cov?.blobVersion === BLOB_VERSION &&
				cov?.hasLines === true &&
				cov?.lineCount === 0;
			const tilesOnDisk =
				serverHasNothing || areaTilesPresentIn(tileKeys, c[0], c[1]);
			if (satOnDisk && tilesOnDisk) continue; // already COMPLETE -> zero work
			if (await checkDownloadGate()) {
				gatePaused = true; // user paused a heavy cellular download
				break;
			}
			// LIVE: we're actively fetching now (the page shows "⟳ downloading…").
			setActivity(true, ++downloaded, satCooldown.size);
			try {
				await ensureAreaData(c, corridor);
				// Replace the size ESTIMATE with the real baked photo size in keptBytes.
				if (!corridor) {
					const img = await getSatImageByKey(k);
					if (img && !photoBytes.has(k)) {
						keptBytes += img.blob.size - sizeGuess;
						photoBytes.set(k, img.blob.size);
						satKeys.add(k);
					}
				}
			} catch (err) {
				if (isTimeoutErr(err)) passSawTimeout = true;
				// TERMINAL vs TRANSIENT — the circuit breaker LATCHES for the session; treating it as "retry next pass" caused a console flood (identical stack every 20s, climbing memory). A latched breaker stops this pass and says so ONCE; only reload clears it.
				if (isDownloadGuardTripped()) {
					if (!guardTripAnnounced) {
						guardTripAnnounced = true;
						console.error(
							"[offline-bake] 🛑 download circuit breaker is LATCHED — " +
								"stopping all baking for this session. Reload the page to reset.",
							err,
						);
					}
					break;
				}
				console.warn("[offline-bake] area failed (retry next pass)", err);
			}
		}

		// 5) EVICT — only when the jar overflows. Under 1GB nothing is ever removed; past it the OLDEST-touched fall off (milk-shelf conveyor) until back under.
		// Orphans (shared satellite cache, deleted pin leftovers) are KEPT while under budget — deleting on sight caused the 578→206 swing bug. Skipped on a cellular pause.
		const kept = new Set<string>();
		// ⚠️ SAFETY GUARD against the "1GB → 70MB" collapse — NEVER evict before the host has HYDRATED, or a briefly-empty place list on cold reload makes every blob look unreferenced and the conveyor nukes nearly everything.
		//
		// ⚠️ ready(), NOT "places().length > 0" — a hydrated host with all pins deleted has zero places but must still evict; conflating them silently disabled the conveyor. budgetPaused/gatePaused also block eviction, since a stopped-early walk leaves keptBytes PARTIAL.
		if (!gatePaused && !budgetPaused && (ports?.ready() ?? false)) {
			const demoKey = satImageKey(MAP_HOME_CENTER);
			// Touch time: referenced areas use feature touch time, orphans use registry lastTouched (0 if none — the most disposable, ages out first). Demo never dies.
			const touchOf = (k: string): number => {
				if (k === demoKey) return Number.POSITIVE_INFINITY;
				const t = touchByKey.get(k);
				if (t !== undefined) return t;
				return covByKey.get(k)?.lastTouched ?? 0;
			};
			const sizeOf = (k: string): number =>
				photoBytes.get(k) ?? covByKey.get(k)?.bytes ?? EST_AREA_BYTES;
			const stored = [
				...new Set<string>([
					...satKeys,
					...(await getVectorKeys()),
					...(await allCoverage()).map((r) => r.areaKey),
				]),
			].sort((a, b) => touchOf(b) - touchOf(a)); // NEWEST first
			let total = 0;
			for (const k of stored) {
				total += sizeOf(k);
				if (total > OFFLINE_BUDGET_BYTES) {
					await pruneArea(k); // past the line = oldest, over budget -> conveyor drop
				} else {
					kept.add(k);
				}
			}

			// 6) MIRROR — force the ledger to match disk exactly (heals both "stored but unregistered" and "registered but not stored"); only writes when missing/stale, so free at steady state.
			const liveSat = new Set(await getSatKeys());
			// ⛔ LINES LIVE IN THE V4 TILE PILE — ask rt-tiles-v3, NOT the legacy rt-vectors (getVectorKeys, empty on any modern install). Using it here caused the "downloading the same blobs over and over" regression.
			// Same in-memory key set the download loop uses, so the mirror and skip check can no longer disagree about what's on disk.
			const liveTileKeys = await getAllTileKeys();
			for (const [k, { c }] of ordered) {
				if (!kept.has(k)) continue;
				const hasPhoto = liveSat.has(k);
				const hasLines = areaTilesPresentIn(liveTileKeys, c[0], c[1]);
				if (!hasPhoto && !hasLines) continue; // nothing actually on disk yet
				const rec = covByKey.get(k);
				const current =
					!!rec &&
					rec.hasPhoto === hasPhoto &&
					rec.hasLines === hasLines &&
					rec.blobVersion === BLOB_VERSION;
				if (current) continue;
				// CARRY the existing line accounting forward — this mirror only knows PRESENCE, never byte/count detail, so it must not invent either.
				//
				// lineCount is load-bearing — the skip check treats ===0 as "server confirmed empty"; `?? 0` on a missing count would silently claim that and kill the re-download self-heal, so absent lines leave it undefined ("unknown").
				const lineBytes = hasLines ? (rec?.lineBytes ?? 0) : 0;
				const lineCount = hasLines ? rec?.lineCount : undefined;
				await noteCoverage(
					k,
					c[0],
					c[1],
					{
						hasPhoto,
						hasLines,
						photoBytes: photoBytes.get(k) ?? 0,
						lineBytes,
						lineCount,
						bytes: (photoBytes.get(k) ?? 0) + lineBytes,
						// ⚠️ CARRY THE EXISTING STAMP — NEVER write BLOB_VERSION here. This mirror only knows PRESENCE (boolean), not WHICH RINGS — it shipped once and stamped 232 areas as current while holding zero z9 tiles, hiding the whole z9 ring for an evening. Only a REAL DOWNLOAD may write the version.
						blobVersion: rec?.blobVersion,
					},
					false,
					touchByKey.get(k),
				);
			}
		}

		// 6) FIRES — LAST, deliberately outside the completion gate above; the download loop `continue`s past complete areas, so anything perishable placed inside it would silently stop refreshing (see refreshFires' header).
		//
		// The live position is included even when it earned no map blob: a user inside their existing 40 km coverage still wants to know what is burning in the 500 km around them.
		try {
			const fireCentres = [...areas.entries()]
				.filter(([k]) => kept.has(k))
				.map(([, v]) => v.c);
			// SNAPPED, never raw — refreshFires keys by satImageKey (same ~11m round); a raw fix would mint a new fire record every few paces even though containment spared the map blob.
			const liveCentre = liveFix ? snapLiveAnchor(liveFix) : null;
			if (
				liveCentre &&
				!fireCentres.some(
					(c) => c[0] === liveCentre[0] && c[1] === liveCentre[1],
				)
			) {
				fireCentres.unshift(liveCentre); // where the user IS comes first
			}
			// TEMPORARY BISECT flag (pairs with FIRE_LAYER_ENABLED_ONLINE in MobMapPage.svelte). ⚠️ Fire has TWO halves (render + this fetch/store pass, which runs regardless of route) — disabling only one leaves the other running and invalidates any bisect.
			if (FIRE_REFRESH_ENABLED) await refreshFires(fireCentres);
		} catch (err) {
			// The overlay must fail alone — never let it mark the whole pass failed.
			console.warn("[v4 fire] refresh pass failed", err);
		}
	} catch (err) {
		if (isTimeoutErr(err)) passSawTimeout = true;
		console.warn("[offline-bake] bakeAll failed", err);
	} finally {
		bakeDone();
		setNote("");
		// IDLE now — report how many areas are still in photo-bake backoff; non-zero at idle means broken features waiting to retry.
		setActivity(false, 0, satCooldown.size);
		if (passChanged) bumpGeneration();
		// TIMEOUT BACKOFF — a timed-out fetch means lie-fi; kicking again in 20s just re-saturates it, so skip kicks for an escalating window until a timeout-free pass resets it.
		if (passSawTimeout) {
			timeoutBackoffUntil = Date.now() + nextTimeoutBackoffMs;
			console.warn(
				`[offline-bake] pass hit a network timeout — backing off ${Math.round(nextTimeoutBackoffMs / 1000)}s`,
			);
			nextTimeoutBackoffMs = Math.min(
				nextTimeoutBackoffMs * 2,
				TIMEOUT_BACKOFF_CAP_MS,
			);
		} else {
			timeoutBackoffUntil = 0;
			nextTimeoutBackoffMs = TIMEOUT_BACKOFF_START_MS;
		}
		reconciling = false;
		// THE DRAIN TEST — anything queued behind this slice means the run is still going, so the tally keeps filling and nothing prints yet.
		const moreComing = rerun || budgetPaused;
		resumingRun = moreComing;
		reportRun(moreComing);
		if (rerun) {
			rerun = false;
			kickBake(); // via kickBake so the coalesced re-run also honours backoff
		} else if (budgetPaused) {
			// Resume SOON but not immediately — an instant re-kick would rebuild the back-to-back chain this budget exists to break; the gap lets the main thread and GC breathe.
			setTimeout(kickBake, BUDGET_RESUME_MS);
		}
	}
}

/** ONE-TIME migration — backfills split photo/line byte fields for pre-existing areas (size panel read 0B without it); reads line payloads ONE AREA AT A TIME to bound peak heap. */
async function backfillCoverageSizes(): Promise<void> {
	if (backfilled) return;
	backfilled = true;
	try {
		const recs = await allCoverage();
		const need = recs.filter(
			(r) => (r.hasPhoto && !r.photoBytes) || (r.hasLines && !r.lineBytes),
		);
		if (!need.length) return;
		const photoBytesByKey = new Map<string, number>();
		if (need.some((r) => r.hasPhoto)) {
			for (const { key, bytes } of await satImageMeta()) {
				photoBytesByKey.set(key, bytes);
			}
		}
		for (const r of need) {
			const patch: {
				photoBytes?: number;
				lineBytes?: number;
				lineCount?: number;
			} = {};
			if (r.hasPhoto)
				patch.photoBytes = photoBytesByKey.get(r.areaKey) ?? r.photoBytes ?? 0;
			if (r.hasLines) {
				const feats = await getVectorFeaturesAt(r.areaKey); // one area only
				patch.lineBytes = JSON.stringify(feats).length;
				patch.lineCount = feats.length;
			}
			await noteCoverage(r.areaKey, r.lng, r.lat, patch, false);
		}
	} catch (err) {
		console.warn("[offline-bake] coverage size backfill failed", err);
	}
}

/** Run THE formula now (newest-first, budget in REAL stored bytes, oldest-over-budget evicted) — cheap to call on every change since a present blob is zero work. */
export function kickBake(): void {
	const now = Date.now();
	if (now < bootBakeAt) return; // boot delay — the start-scheduled timer runs the first pass
	if (now < timeoutBackoffUntil) return; // lie-fi backoff — see bakeAll's finally
	void bakeAll();
}

/** FIX NOW — the user's "heal everything" button; wipes all satellite cooldowns so every failed area is eligible to re-bake immediately. Does NOT bypass the coverage guard or budget. Returns count released. */
export function retryFailedBakes(): number {
	const n = satCooldown.size;
	satCooldown.clear();
	setActivity(status.downloading, status.pending, 0);
	void bakeAll();
	return n;
}

/** For the test seam. */
export async function reconcileOnceForTest(
	hostPorts?: HostPorts,
): Promise<void> {
	// Tests inject through the SAME door production uses — were this seam fake, every tripwire would bake nothing and go red.
	if (hostPorts) ports = hostPorts;
	await bakeAll();
}

let started = false;
let teardown: Array<() => void> = [];

/** ⚠️ Start ONCE from mobile layout onMount (idempotent). THE TRIGGER IS A PUSH — ports.onPlacesChanged, not a reactive $effect read, which silently failed to fire on a fresh pin drop. [[cross-module-state-use-applier-pattern]] */
export function startOfflineBakeService(hostPorts: HostPorts): () => void {
	if (started)
		return () => {
			/* already running — the first start's stop owns shutdown */
		};
	started = true;
	ports = hostPorts;

	// ONE-TIME: sweep 0-byte tiles from the pre-guard pack Worker (~19% of the pile on old devices) — runs BEFORE the first pass so all-empty discs re-download rather than reading as "covered". No-op on subsequent boots.
	void purgeEmptyTilesOnce();

	// ONE-TIME: reclaim the ~70MB of PNGs left behind by the deleted road raster — deleting the code does not delete the bytes (see purgeRoadRasters.ts).
	purgeDeadRoadRasters();

	void backfillCoverageSizes();
	// Seed the TinyBase cloud-mirror with every PRE-EXISTING baked area — new writes mirror themselves, this catches ones baked before the mirror existed.
	void backfillCoverageMirror();

	// BOOT DELAY — kickBake absorbs every kick for the first 20s, so boot + the map's own style/tile fetches get the pipe first on lie-fi; this timer runs the first pass.
	bootBakeAt = Date.now() + BOOT_BAKE_DELAY_MS;
	// ARRIVAL #1 — app open IS the ask; the first pass fetches fires even if the cached record is 5 minutes old.
	ports.fires?.arrival();
	const bootTimer = setTimeout(kickBake, BOOT_BAKE_DELAY_MS);
	teardown.push(() => clearTimeout(bootTimer));

	// EVERY map/feature change → SHALLOW pass (download only what's missing) — a just-dropped pin is newest so it downloads first; already-baked areas are skipped cheaply.
	teardown.push(ports.onPlacesChanged(kickBake));

	// Every 20s → re-run the formula, re-checking every blob against actual disk so a wiped/failed one self-heals — network is touched only for genuinely-missing blobs.
	const timer = setInterval(kickBake, 20000);
	teardown.push(() => clearInterval(timer));

	// ARRIVAL #2 — the app regaining focus (wake/return) is the same ask as opening it, so the TTL is bypassed here too.
	if (typeof document !== "undefined") {
		const onVisible = () => {
			if (document.visibilityState === "visible") {
				hostPorts.fires?.arrival();
				kickBake();
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		teardown.push(() =>
			document.removeEventListener("visibilitychange", onVisible),
		);
	}

	// ARRIVAL #3 — connectivity returns (the field moment). refreshFires bails while offline, so without this the next 20s tick finds a "fresh" record and skips — the arrival TTL alone gets most wrong.
	if (typeof window !== "undefined") {
		const onOnline = () => {
			hostPorts.fires?.arrival();
			kickBake();
		};
		window.addEventListener("online", onOnline);
		teardown.push(() => window.removeEventListener("online", onOnline));
	}

	// ⛔ Must call registerWipeStopper — the wipe button did nothing because it had ZERO callers repo-wide, so wipe.ts deleted databases this service was actively re-writing into (regression, 27 Aug 2026).
	teardown.push(registerWipeStopper(stopOfflineBakeService));

	return stopOfflineBakeService;
}

/** Tear down the service (test cleanup / full app teardown). */
export function stopOfflineBakeService(): void {
	for (const fn of teardown) fn();
	teardown = [];
	started = false;
	ports = null;
}
