<!--
  MAP DEBUGGER — the visible breaker panel for BOTH maps. Renders NOTHING outside dev.
  ⚠️ DEBUG ROUTES ONLY — /offline/debug and /map/debug. Never on the plain /offline or /map a user opens.
  ⚠️ Gate is the ROUTE, not "dev only" — the whole app is dev while it's being built.
  ⚠️ N INSTANCES → STOP: another tab of this app is live, every memory number is the sum of both.
  ⚠️ RUNNING + QUEUED permanently → RUNAWAY: passes chain forever, memory climbs.
-->
<script lang="ts">
import "$rig/dev/devCard.css";
import { dev } from "$app/environment";
import { onMount } from "svelte";
import {
	workStats,
	payloadStats,
	resetWorkStats,
} from "./workMeter.svelte";
import { subscribeOfflineBake } from "../onPhone/bake/bakeService.svelte";
import {
	HEAP_NOTE,
	collectFocusedBlobReport,
	compactJson,
	debugReportFilename,
	type LngLatPin,
} from "./debugReport";
let bakeOn = $state(false);
let bakePend = $state(0);
let bakeFail = $state(0);
let bakeNote = $state("");
let bakeSecs = $state(0);
let bakeT0 = 0;
// stall threshold: past the client's 150s fetch deadline, it's not slow, it's stuck.
const STALL_AFTER_S = 150;

// ⛔ panel goes quiet after this no matter what the bake says — reassurance is short-lived, not running commentary; work continues silently past this point.
const HIDE_AFTER_S = 20;
let bakeTick: ReturnType<typeof setInterval> | undefined;

$effect(() => {
	const off = subscribeOfflineBake((st) => {
		if (st.downloading && !bakeOn) {
			// ⛔ only (re)start the clock if not already running — resetting bakeT0 on every downloading:true edge (one per area) froze the elapsed time at 0 during a busy queue.
			if (!bakeTick) {
				bakeT0 = Date.now();
				bakeSecs = 0;
				bakeTick = setInterval(() => {
					bakeSecs = Math.round((Date.now() - bakeT0) / 1000);
				}, 1000);
			}
		} else if (!st.downloading && bakeOn) {
			clearInterval(bakeTick);
			bakeTick = undefined;
			bakeSecs = 0;
		}
		bakeOn = st.downloading;
		bakePend = st.pending;
		bakeFail = st.failing;
		bakeNote = st.note;
	});
	return () => {
		clearInterval(bakeTick);
		off();
	};
});

interface Props {
	/** Which map this is, used to label the report. */
	route?: string;
	/** Every pin the host page knows about — passed IN on purpose; reading mapStore here would couple the debugger to TinyBase and cost the portability to move into rapper. */
	pins?: LngLatPin[];
	/** The blob signature areas SHOULD hold, so the export can flag stale ones. */
	blobVersion?: string | null;
	/** Which layers are on, for the export report's snapshot — toggle UI lives in OfflineConfigPanel; this only reads `on`, it doesn't render switches. */
	layers?: { key: string; on: boolean }[];
	/** DOCKED — render in-flow instead of fixed-to-viewport; default false suits the floating meter over a full-screen map, but a columned debug page needs docked since a fixed panel can't sit in a column. */
	docked?: boolean;
	/** Name of the area export json exports — debugReport.ts scopes `latest` to the newest-touched blob (OfflineBlobPanel marks that row FOCUSED); shown on the button so scope is clear before the tap. */
	focusedBlobName?: string | null;
}
let {
	docked = false,
	route = "map",
	pins = [],
	blobVersion = null,
	layers = [],
	focusedBlobName = null,
}: Props = $props();

// export json is scoped to ONE blob (the focused row), not a full device inventory — measured 391 areas would make a ~5,000-line file.
let exporting = $state(false);
let exportMsg = $state("");
/** Which action just completed, for the confirmation flash — separate from exportMsg's error text so a successful copy/save reads as a state change on the button. */
let justDid = $state<"copied" | "saved" | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flash(action: "copied" | "saved") {
	justDid = action;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => (justDid = null), 1800);
}

async function buildReport() {
	return collectFocusedBlobReport({
		route,
		heapNowMb: heap,
		heapLowMb: floor,
		heapPeakMb: peak,
		heapAtLoadMb: heap0,
		layers: layers.map((l) => ({ key: l.key, on: l.on })),
	});
}

let exportOpen = $state(false);

// tap-outside closes the export popup — bound only while open, matching SharePicker's behaviour on Get Cache.
$effect(() => {
	if (!exportOpen) return;
	function offClick(e: MouseEvent) {
		const t = e.target as HTMLElement | null;
		if (!t?.closest?.(".export-wrap")) exportOpen = false;
	}
	window.addEventListener("click", offClick, true);
	return () => window.removeEventListener("click", offClick, true);
});

async function copyJson() {
	if (exporting) return;
	exporting = true;
	exportMsg = "";
	try {
		const json = compactJson(await buildReport());
		await navigator.clipboard.writeText(json);
		flash("copied");
	} catch (err) {
		// fail LOUD (spec rule 3) — a silent no-op here reads as "nothing to export", a different and more alarming finding.
		exportMsg = err instanceof Error ? err.message : "copy failed";
	} finally {
		exporting = false;
	}
}

async function downloadJson() {
	if (exporting) return;
	exporting = true;
	exportMsg = "";
	try {
		const json = compactJson(await buildReport());
		const url = URL.createObjectURL(
			new Blob([json], { type: "application/json" }),
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = debugReportFilename();
		a.click();
		// revoke on next task, not synchronously — revoking immediately can cancel the download in some browsers before it reads the blob.
		setTimeout(() => URL.revokeObjectURL(url), 0);
		flash("saved");
	} catch (err) {
		exportMsg = err instanceof Error ? err.message : "export failed";
	} finally {
		exporting = false;
		setTimeout(() => (exportMsg = ""), 2500);
	}
}

let now = $state(Date.now());
let open = $state(true);
let host: HTMLElement | undefined = $state();

/** Live JS heap (Chromium only) — GARBAGE-INCLUSIVE, NOT actual RAM cost; useful only for its TREND. Browser Task Manager's Memory Footprint is the authoritative number. */
interface MemoryInfo {
	usedJSHeapSize: number;
	totalJSHeapSize: number;
}
function heapMb(): number | null {
	const m = (performance as Performance & { memory?: MemoryInfo }).memory;
	return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
}
let heap = $state<number | null>(null);
// heap at first paint — lets the panel show DRIFT instead of a bare number you'd have to remember the start of.
let heap0 = $state<number | null>(null);

/** PEAK + FLOOR — the numbers that actually characterise this route: offline map's problem isn't resting cost, it's the interaction SPIKE (measured ~475MB on zoom vs ~150-200MB online), which a live instantaneous read can't catch. */
let peak = $state<number | null>(null);
let floor = $state<number | null>(null);
/** Running mean of every sample this session (design handoff's "avg" bar) — kept as sum/count rather than storing every sample twice. */
let heapSum = 0;
let heapCount = 0;
let heapAvg = $state<number | null>(null);
/** Session heap trace for the sparkline — {t, mb} at 1Hz (finer is wasted on a ~300px line), capped so an all-day tab doesn't grow this forever. */
const TRACE_MAX = 300;
let heapTrace = $state<{ t: number; mb: number }[]>([]);
let peakAt = $state<number | null>(null);

function resetPeaks(): void {
	peak = heap;
	floor = heap;
	heap0 = heap;
	heapSum = heap ?? 0;
	heapCount = heap === null ? 0 : 1;
	heapAvg = heap;
	heapTrace = heap === null ? [] : [{ t: Date.now(), mb: heap }];
	peakAt = heap === null ? null : Date.now();
}

// one cheap tick a second so in-flight durations count up — nothing else here schedules work; the panel must never be part of what it measures.
onMount(() => {
	if (!dev) return;
	// sampling at 4Hz not 1Hz — a zoom spike lasts a couple seconds and a 1s sampler would walk past the peak it exists to catch.
	const id = setInterval(() => {
		now = Date.now();
		const h = heapMb();
		heap = h;
		if (h === null) return;
		if (heap0 === null) heap0 = h;
		if (peak === null || h > peak) {
			peak = h;
			peakAt = Date.now();
		}
		if (floor === null || h < floor) floor = h;
		heapSum += h;
		heapCount += 1;
		heapAvg = Math.round(heapSum / heapCount);
	}, 250);
	// 1Hz trace sampler, separate from the 4Hz peak-catcher above — sparkline draws the session's SHAPE, not every 250ms wobble.
	const traceId = setInterval(() => {
		const h = heapMb();
		if (h === null) return;
		heapTrace = [...heapTrace.slice(-(TRACE_MAX - 1)), { t: Date.now(), mb: h }];
	}, 1000);
	return () => {
		clearInterval(id);
		clearInterval(traceId);
	};
});

/** heapTrace mapped onto a 300×44 viewBox — same box the sparkline SVG uses. */
const sparkPoints = $derived.by(() => {
	if (heapTrace.length < 2) return "";
	const mbs = heapTrace.map((s) => s.mb);
	const lo = Math.min(...mbs);
	const hi = Math.max(...mbs, lo + 1); // +1 guards a flat trace (hi===lo)
	const n = heapTrace.length;
	return heapTrace
		.map((s, i) => {
			const x = (i / (n - 1)) * 300;
			const y = 40 - ((s.mb - lo) / (hi - lo)) * 36;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
});

/** Where the peak sample sits along the sparkline (viewBox x) — drives the red dot + dashed guide; null when the peak has scrolled off (TRACE_MAX). */
const peakSparkX = $derived.by(() => {
	if (peakAt === null || heapTrace.length < 2) return null;
	const idx = heapTrace.findIndex((s) => s.t === peakAt);
	if (idx === -1) return null;
	return (idx / (heapTrace.length - 1)) * 300;
});

// portal to <body> — `.mobile-preview-frame`'s `contain: layout` makes it the containing block for position:fixed, trapping a "fixed" panel inside the phone frame; CSS alone can't escape it.
// ⚠️ not when docked — the portal exists to escape the phone frame; yanking a docked meter's node to <body> takes it out of its rail and looks like the panel disappearing.
$effect(() => {
	if (docked || !dev || !host || typeof document === "undefined") return;
	document.body.appendChild(host);
	return () => host?.remove();
});

const rows = $derived(workStats());
const pays = $derived(payloadStats());
/** Total KB pushed into the Mapbox worker for re-parsing since load. */
const payTotalKb = $derived(pays.reduce((n, p) => n + p.totalKb, 0));

function secs(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Same shape as secs(): roll up to the bigger unit once it reads better. */
function fmtKb(kb: number): string {
	if (kb <= 0) return "—";
	return kb < 1024 ? `${kb}KB` : `${(kb / 1024).toFixed(1)}MB`;
}
</script>

{#if dev}
	<div class="meter dev-card" class:docked={docked} class:collapsed={!open} bind:this={host}>
		<div class="head-row dev-card__head">
			<button
				class="head"
				onclick={() => (open = !open)}
				title="Offline work meter — counts what runs while you sit still"
			>
				<span class="dev-card__title">CURRENT SESSION</span> {open ? "▾" : "▸"}
			</button>
			<!-- ONE trigger (Get Cache's SharePicker shape), hand-built because the open-core boundary bans importing $lib/mobile components into this child. -->
			<div class="export-wrap">
				<button
					class="export-trigger"
					class:did={justDid !== null}
					class:on={exportOpen}
					onclick={() => (exportOpen = !exportOpen)}
					disabled={exporting}
					aria-haspopup="menu"
					aria-expanded={exportOpen}
					title="Export as JSON — the focused blob, layers, heap, the work meter (circuits, timings, probes), recent imports: one file"
				>
					{#if justDid !== null}
						<span class="et-ok">✓</span>
					{:else if exporting}
						<span class="et-ok">…</span>
					{:else}
						<!-- share/upload glyph, same silhouette as the Get Cache export icon on /inbox. -->
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 14v4.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V14"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
						<span class="et-label">json</span>
					{/if}
				</button>

				{#if exportOpen}
					<!-- blob name lives HERE, once, as the popup's heading — not stamped on every button face. -->
					<div class="export-menu" role="menu">
						{#if focusedBlobName}
							<div class="em-head">{focusedBlobName}</div>
						{/if}
						<button
							class="em-opt em-opt--active"
							onclick={() => {
								exportOpen = false;
								copyJson();
							}}
						>
							copy json
						</button>
						<button
							class="em-opt"
							onclick={() => {
								exportOpen = false;
								downloadJson();
							}}
						>
							download
						</button>
						{#if exportMsg}
							<div class="em-err">{exportMsg}</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		{#if heap !== null}
			<!-- "main thread only" — performance.memory excludes Workers, which hold MORE on this route (measured: page 321MB vs workers 164MB idle, workers +258MB on a zoom vs page +86); DevTools → Memory → Total JS heap size includes workers. -->
			<div class="heap" title={HEAP_NOTE}>
				<div class="heap-head">
					<span class="heap-title">MEMORY</span>
					<span class="heap-note">resets on refresh · or new blob load</span>
				</div>

				{#each [{ cls: "now", lbl: "now", v: heap }, { cls: "avg", lbl: "avg", v: heapAvg }, { cls: "peak", lbl: "peak", v: peak }] as row (row.cls)}
					{#if row.v !== null}
						<div class="memrow {row.cls}">
							<span class="lbl">{row.lbl}</span>
							<div class="track">
								<div
									class="fill"
									style="width:{peak ? Math.max(4, (row.v / peak) * 100) : 0}%"
								></div>
							</div>
							<span class="val">{row.v} MB</span>
						</div>
					{/if}
				{/each}

				{#if sparkPoints}
					<div class="sparkwrap">
						<svg viewBox="0 0 300 44" preserveAspectRatio="none">
							<polyline points={sparkPoints} fill="none" stroke={"#6fb3d9"} stroke-width="2" />
							{#if peakSparkX !== null}
								{@const py =
									40 -
									((peak! - Math.min(...heapTrace.map((s) => s.mb))) /
										(Math.max(...heapTrace.map((s) => s.mb), Math.min(...heapTrace.map((s) => s.mb)) + 1) -
											Math.min(...heapTrace.map((s) => s.mb)))) *
										36}
								<circle cx={peakSparkX} cy={py} r="3.5" fill="#e2553f" />
								<line
									x1={peakSparkX}
									y1={py}
									x2={peakSparkX}
									y2="44"
									stroke="#e2553f"
									stroke-width="1"
									stroke-dasharray="2,3"
								/>
							{/if}
						</svg>
						<div class="sparklabel">
							<span>session start</span>
							<span class="spike">peak spike</span>
							<span>now</span>
						</div>
					</div>
				{/if}
				<button class="mini zero-btn" onclick={resetPeaks}>zero</button>
			</div>
		{/if}

		{#if open}
			<!-- LIVE — shown whether or not any pass has completed; answers "is it still going, and for how long?" -->
			<div class="bake-live" class:on={bakeOn && bakeSecs < HIDE_AFTER_S}>
				{#if bakeOn && bakeSecs >= HIDE_AFTER_S && bakeSecs < STALL_AFTER_S}
					<!-- ⛔ quiet — work is still happening; saying so on a loop reads as "broken" (it isn't) and can't be acted on. -->
					<strong class="dim">working…</strong>
				{:else if bakeOn && bakeSecs >= STALL_AFTER_S}
					<!-- ⛔ say it's stuck — a spinner that never stops is a lie; after this long it isn't coming, naming it is the point. -->
					<strong class="fail">⚠️ stalled</strong>
					<span class="secs">{bakeSecs}s</span>
					{#if bakePend > 0}<span class="dim">· {bakePend} queued</span>{/if}
				{:else if bakeOn}
					<strong>⏳ downloading</strong>
					<span class="secs">{bakeSecs}s</span>
					{#if bakePend > 0}<span class="dim">· {bakePend} queued</span>{/if}
				{:else}
					<strong class="dim">idle</strong>
					{#if bakePend > 0}<span class="dim">· {bakePend} queued</span>{/if}
				{/if}
				{#if bakeFail > 0}
					<span class="fail">· {bakeFail} failing</span>
				{/if}
			</div>
			{#if bakeNote}
				<div class="hint bake-note">{bakeNote}</div>
			{/if}

			{#if rows.length === 0}
				<!-- "bake boots ~20s" explainer is a TOOLTIP not standing text — it's true on every render, so as standing text it only cost height. -->
				<div
					class="empty"
					title="waiting for first pass — bake boots ~20s after load"
				>
					no bake pass has run yet
				</div>
				<div class="foot">
					<span class="dim">run counts</span>
					<button onclick={resetWorkStats}>clear counts</button>
				</div>
			{:else}
				<table>
					<tbody>
						{#each rows as r (r.name)}
							<tr class:hot={r.startedAt !== null}>
								<td class="name">{r.name}</td>
								<td class="num">{r.runs}</td>
								<td class="num">{secs(r.lastMs)}</td>
								<td class="num dim" title="worst run">{secs(r.maxMs)}</td>
								<td class="flags">
									{#if r.startedAt !== null}
										<span class="run">▶ {secs(now - r.startedAt)}</span>
									{/if}
									{#if r.queued}<span class="q">QUEUED</span>{/if}
									{#if r.skips > 0}
										<span class="skip" title={r.lastSkip}>
											{r.skips} skipped
										</span>
									{/if}
									{#if r.errors > 0}<span class="err">{r.errors}✕</span>{/if}
								</td>
							</tr>
							{#if r.skips > 0 && r.lastSkip}
								<tr>
									<td colspan="5" class="why">
										↳ last skip: {r.lastSkip}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
				<div class="foot">
					<span class="dim">runs · last · worst</span>
					<button onclick={resetWorkStats}>reset</button>
				</div>
			{/if}

			<!-- PAYLOADS — bytes handed to Mapbox's worker to re-parse; rendered outside the rows/empty branch since a wall rebuild pushes data regardless of tracked ops. -->
			{#if pays.length > 0}
				<div class="paysec">
					<div class="payhead">
						setData → mapbox worker
						<span class="dim">{fmtKb(payTotalKb)} total re-parsed</span>
					</div>
					<table>
						<tbody>
							{#each pays as p (p.name)}
								<tr>
									<td class="name">{p.name.replace("v4-", "").replace("-geo", "")}</td>
									<td class="num" title="sends since load">×{p.sends}</td>
									<td class="num" title="last payload">{fmtKb(p.lastKb)}</td>
									<td class="num dim" title="largest payload">{fmtKb(p.maxKb)}</td>
									<td class="num dim" title="total re-parsed since load">
										{fmtKb(p.totalKb)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<div class="foot">
						<span class="dim">sends · last · biggest · total</span>
					</div>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
/* Tokens and the card shell live in devCard.css (.dev-card). */

/* DOCKED — in the flow, for a page that lays panels out in columns; everything else (colours, type, borders) is shared, only positioning differs. */
.meter.docked {
	position: static;
	left: auto;
	top: auto;
	width: 100%;
	box-sizing: border-box;
	/* undoes base .meter's max-width:420px — that cap is for the FLOATING instrument (must stay small, not cover the map), not this one which uses the rail's full width. */
	max-width: none;
}

.meter {
	/* fixed to the VIEWPORT not the phone frame — inside the frame it sat under the shovel/tab bar unreadable; top-left keeps it clear of the phone and DevTools. */
	position: fixed;
	left: 10px;
	top: 10px;
	z-index: 99999;
	max-width: 420px;
	pointer-events: auto;
}
.head {
	/* Look comes from .dev-card__title inside; this is just the button reset. */
	display: flex;
	align-items: center;
	gap: 6px;
	background: none;
	border: 0;
	color: var(--gold);
	font: inherit;
	padding: 0;
	cursor: pointer;
	white-space: nowrap;
}
table {
	border-collapse: collapse;
	margin-top: 4px;
}
td {
	padding: 1px 5px 1px 0;
	white-space: nowrap;
	vertical-align: top;
}
.name {
	color: var(--blue);
}
.num {
	text-align: right;
	font-variant-numeric: tabular-nums;
}
.dim {
	color: var(--muted);
}
tr.hot .name {
	color: var(--gold);
}
.flags {
	display: flex;
	gap: 5px;
}
.run {
	color: var(--gold);
}
.q {
	color: var(--amber);
	font-weight: 700;
}
.err {
	color: var(--red);
}
.empty {
	color: var(--muted);
	margin-top: 3px;
}
.hint {
	color: var(--muted2);
	font-size: 11px;
	margin-top: 2px;
	max-width: 100%;
	white-space: normal;
}
/* MEMORY block — three bar rows (now/avg/peak) + a session sparkline, matched to the design handoff's .memrow/.sparkwrap layout. */
.heap {
	margin-top: 16px;
}
.heap-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 10px;
	margin-bottom: 10px;
}
.heap-title {
	font-size: 11px;
	font-weight: 800;
	letter-spacing: 0.1em;
	color: var(--muted);
}
.heap-note {
	font-size: 10px;
	color: var(--muted2);
}
.memrow {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 7px;
}
.memrow .lbl {
	width: 30px;
	font-size: 10.5px;
	font-weight: 800;
	letter-spacing: 0.05em;
	color: var(--muted);
	text-transform: uppercase;
}
.memrow .track {
	flex: 1;
	height: 14px;
	background: var(--panel3);
	border-radius: 4px;
	position: relative;
	overflow: hidden;
	border: 1px solid var(--border);
}
.memrow .fill {
	position: absolute;
	left: 0;
	top: 0;
	height: 100%;
	border-radius: 3px;
}
.memrow.now .fill {
	background: var(--blue);
}
.memrow.avg .fill {
	background: var(--muted2);
}
.memrow.peak .fill {
	background: var(--red);
}
.memrow .val {
	width: 58px;
	text-align: right;
	font-weight: 700;
	font-size: 13px;
	color: var(--text);
	font-variant-numeric: tabular-nums;
}
.memrow.peak .val {
	color: var(--red);
}
.memrow.now .val {
	color: var(--blue);
}
.sparkwrap {
	margin-top: 12px;
	padding: 10px 10px 6px;
	background: var(--panel3);
	border: 1px solid var(--border);
	border-radius: 8px;
}
.sparkwrap svg {
	display: block;
	width: 100%;
	height: 44px;
}
.sparklabel {
	display: flex;
	justify-content: space-between;
	font-size: 9.5px;
	color: var(--muted2);
	margin-top: 4px;
}
.sparklabel .spike {
	color: var(--red);
}
.mini {
	background: none;
	border: 0;
	color: var(--muted);
	font: inherit;
	text-decoration: underline;
	cursor: pointer;
	padding: 0;
}
.zero-btn {
	margin-top: 8px;
}
/* skip is amber not red — refusing to run is often CORRECT; it earns attention because it explains an empty panel, not because it's a fault. */
.skip {
	color: var(--amber);
}
.why {
	color: var(--muted);
	font-size: 11px;
	padding-bottom: 3px;
}
/* payload section separated by a rule — answers a different question from the timing rows above it (bytes re-parsed, not ms spent). */
.paysec {
	margin-top: 6px;
	padding-top: 4px;
	border-top: 1px solid var(--border);
}
.payhead {
	display: flex;
	justify-content: space-between;
	gap: 10px;
	color: var(--text);
	margin-bottom: 2px;
}
.foot {
	display: flex;
	justify-content: space-between;
	gap: 10px;
	margin-top: 4px;
	padding-top: 8px;
	border-top: 1px solid var(--border);
}
.foot button {
	background: none;
	border: 0;
	color: var(--muted);
	font: inherit;
	cursor: pointer;
	padding: 0;
	text-decoration: underline;
}

/* LIVE BAKE ROW — answers "is anything happening right now?"; dim when idle so it never competes with the numbers, lit while working. */
.bake-live {
	display: flex;
	align-items: baseline;
	gap: 0.35em;
	padding: 10px 0 0;
	font-variant-numeric: tabular-nums;
}
.bake-live.on strong {
	color: var(--gold);
}
.bake-live .secs {
	color: var(--gold);
	font-weight: 700;
}
.bake-live .fail {
	color: var(--red);
}
.bake-note {
	padding-bottom: 0.25rem;
}
.head-row {
	flex-wrap: wrap;
	gap: 8px 10px;
}
.head-row .head {
	flex: 1 1 auto;
	min-width: 0;
}
.export-wrap {
	flex: 0 0 auto;
	position: relative;
	display: inline-flex;
}
/* OUTLINED icon button (Get Cache export affordance) — gold ink on hairline, not fill; fill is reserved for the DEFAULT choice in the popup, so the loud element is the commit, not the opener. */
.export-trigger {
	flex: 0 0 auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 30px;
	gap: 6px;
	padding: 0 10px;
	border-radius: 9px;
	border: 1px solid #e8b923;
	background: transparent;
	color: #e8b923;
	cursor: pointer;
	font: inherit;
	transition:
		background 80ms ease,
		transform 80ms ease;
}
.export-trigger svg {
	width: 18px;
	height: 18px;
	display: block;
}
.export-trigger:hover:not(:disabled),
.export-trigger.on {
	background: rgba(232, 185, 35, 0.14);
}
.export-trigger:active:not(:disabled) {
	transform: translateY(1px);
}
.export-trigger:disabled {
	opacity: 0.55;
	cursor: default;
}
.export-trigger .et-label {
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.04em;
}
.export-trigger .et-ok {
	font-weight: 800;
	font-size: 14px;
	line-height: 1;
}
/* popup of formats, anchored under the trigger, in-flow not portaled — the panel is fixed-position and never clips here, so SharePicker's portal machinery isn't warranted. */
.export-menu {
	position: absolute;
	top: calc(100% + 8px);
	right: 0;
	z-index: 40;
	display: flex;
	flex-direction: column;
	gap: 5px;
	padding: 0.5rem;
	border-radius: 10px;
	background: rgba(10, 10, 10, 0.95);
	border: 1px solid rgba(232, 185, 35, 0.5);
	box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
	white-space: nowrap;
	animation: export-menu-in 120ms ease-out;
}
/* The blob name, ONCE — as the popup's heading. */
.em-head {
	font-family: "JetBrains Mono", ui-monospace, monospace;
	font-size: 9.5px;
	font-weight: 600;
	color: var(--muted);
	padding: 0 2px 2px;
}
.em-opt {
	text-align: left;
	padding: 0.5rem 0.9rem;
	border-radius: 8px;
	border: 1px solid transparent;
	background: transparent;
	color: #e8b923;
	font-family: "Inter", -apple-system, sans-serif;
	font-size: 12.5px;
	font-weight: 700;
	cursor: pointer;
}
.em-opt:hover {
	background: rgba(232, 185, 35, 0.14);
}
/* DEFAULT choice wears full gold — same gradient/bevel as Get Cache's .rt-gold-btn, hand-matched since the open-core boundary bans importing it. */
.em-opt--active {
	background: linear-gradient(180deg, #f5d565 0%, #e8b923 100%);
	border-color: transparent;
	color: #1a1405;
	box-shadow:
		0 2px 0 #b8901c,
		0 6px 14px rgba(232, 185, 35, 0.25),
		inset 0 1px 0 rgba(255, 255, 255, 0.45);
}
.em-opt--active:hover {
	background: linear-gradient(180deg, #f5d565 0%, #e8b923 100%);
}
/* fail LOUD (spec rule 3) — error keeps its home now the button face no longer carries the message. */
.em-err {
	font-size: 10px;
	color: var(--red, #e2553f);
	max-width: 200px;
	white-space: normal;
	padding: 0 2px;
}
@keyframes export-menu-in {
	from {
		opacity: 0;
	}
	to {
		opacity: 1;
	}
}
/* confirmation flash — quick green pulse so copy/download registers as a state change, not just an easy-to-miss word swap; reminds you the JSON is still on your clipboard after it fades. */
.export-trigger.did {
	animation: export-flash 1.8s ease-out;
}
@keyframes export-flash {
	0% {
		background: rgba(127, 191, 106, 0.9);
		border-color: #6fbf6a;
		color: #0d1a0c;
	}
	70% {
		background: rgba(127, 191, 106, 0.9);
		border-color: #6fbf6a;
		color: #0d1a0c;
	}
	100% {
		background: transparent;
		border-color: #e8b923;
		color: #e8b923;
	}
}
</style>
