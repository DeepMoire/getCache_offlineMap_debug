<!--
  PlotMapPopover (V2) — the map plot-pin popover. TWO modes, gated on whether the
  plot is already counted (THE RULE: create that way, don't edit that way):

    • CREATE (uncounted) — a plot you JUST dropped from the map. Embeds the
      editable Quality-704 plot-row DECK (the swipe-pill creator) right in the
      popover so you fill the count without leaving the map.
    • VIEW (counted) — an EXISTING plot. Read-only derived data; the gold "Edit"
      button opens the plot inside the quality704 FORM (edit happens there, never
      inline on the map).

  This is the live popover (MapDrawControls imports it as `PlotMapPopover`).
  Shares the floating-surface + gesture shell with FeatureMapPopover.
-->
<script lang="ts">
// iconPath — now the child's own copy in ../shared/icons (28 Aug 2026).
import { iconPath } from "../shared/icons";
import type { Feature } from "geojson";
import { onDestroy, onMount } from "svelte";
import { fade } from "svelte/transition";
// MapPopoverShell — same child, so a RELATIVE import (28 Aug 2026).
import MapPopoverShell from "../panels/MapPopoverShell.svelte";
// Icon, GoldButton — now come from the host through mapHostPorts as `ports.ui.*` (28 Aug 2026).
// Quality704Deck, FaultChip, CelebrateHost — now come from the host through
// mapHostPorts as `ports.q704.*` (28 Aug 2026).
// celebrate, atvShare — now come from the host through mapHostPorts `ports.q704.*` (28 Aug 2026).
// loadInspection — now comes from the host through mapHostPorts `ports.q704.loadInspection` (28 Aug 2026).
// plotByGpsKey, updateActivePlot, setActiveSpeciesChoices, plotFullCodeByGpsKey,
// getPendingDrop, pendingDropPinData — now come from the host through mapHostPorts
// `ports.q704.*`; PlotPinData → MapQ704PlotPinData from the contract (28 Aug 2026).
// activeMapNumbering — now comes from the host through mapHostPorts `ports.q704.*` (28 Aug 2026).
// copyToClipboard, reportSwallowed — now come from the host through mapHostPorts `ports.ui.*` (28 Aug 2026).
// PlotRow → MapQ704PlotRow, MapShareFormat — both from the contract; the old
// three-level relative climb out of the child to routes/quality704/q704 is gone (28 Aug 2026).
import type {
	MapHostPorts,
	MapQ704DeckExports,
	MapQ704PlotPinData,
	MapQ704PlotRow,
	MapShareFormat,
} from "../shared/mapHostPorts";

let {
	ports,
	feature = null,
	pendingPlotNo = null,
	bbox,
	containerWidth,
	containerHeight,
	onShare,
	onClose,
	onOpenInForm,
}: {
	// The host's door — icons, clipboard, and (optionally) the quality-704 plot
	// stores. `ports.q704` is OPTIONAL: a host with no inspections (the offline
	// debugger) leaves it out and this popover renders nothing. (28 Aug 2026)
	ports: MapHostPorts;
	// VIEW mode: an existing, counted plot's map feature (a real DB-backed pin).
	feature?: Feature | null;
	// CREATE mode: the in-flight pending drop's plot number. When set, there is NO
	// feature (a pin doesn't exist until the count is swiped + written); the deck
	// is seeded from the in-memory pending drop instead.
	pendingPlotNo?: number | null;
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	containerWidth: number;
	containerHeight: number;
	onShare: (format: MapShareFormat) => void;
	onClose: () => void;
	// Jump to the Quality 704 form, focused on this plot number.
	onOpenInForm: (plotNo: number) => void;
} = $props();

// The optional quality-704 group. `const` so the `{#if q704}` narrowing in the
// markup holds inside nested blocks; every store call below goes through it and
// no-ops (null / "") when the host has no inspections. (28 Aug 2026)
const q704 = $derived(ports.q704);
// `use:atvShare` needs a local action — bound here to the host's. (28 Aug 2026)
function atvShare(node: HTMLElement) {
	return q704 ? q704.atvShare(node) : undefined;
}

// NOTE — this popover NEVER discards a plot. Unmounting is not a data event: a
// store re-render can unmount+remount it freely and the plot rides through
// untouched. The ONLY discard is the host's explicit "cancel plot" gate; a
// leftover half-done plot is re-CONFRONTED (popover reopened) on the next map
// boot instead of silently deleted. (The old onDestroy "abandon" fail-safe here
// is what kept eating the first plot of the day.)
const mapFeatureKey = $derived((feature?.properties?.mapFeatureKey as string) ?? "");
// CREATE mode iff a pending plot number was passed (no feature — the pin doesn't
// exist until the count is written). VIEW mode otherwise (a real DB-backed pin).
const isCreate = $derived(pendingPlotNo != null);
// plotByGpsKey reads the TinyBase store imperatively — runes can't track it. So
// the persist $effect below bumps `plotVersion` after every committed write, and
// this re-derives. Without the bump, `counted` stayed frozen at its mount value:
// swiping a fresh plot to file never swapped the popover to the read-only card
// and never revealed the header Edit pencil until a full close/reopen.
let plotVersion = $state(0);
const plot = $derived.by<MapQ704PlotPinData | null>(() => {
	void plotVersion;
	if (!q704) return null;
	// CREATE: render the popover from the in-memory pending drop (no store row yet).
	if (isCreate) return q704.pendingDropPinData();
	// VIEW: an existing plot, read from the database via its pin.
	return mapFeatureKey ? q704.plotByGpsKey(mapFeatureKey) : null;
});

// Fallback number from the pin's own type key (`plot:N`) if the row lookup
// misses (e.g. the survey was already filed away) — the title still reads right.
// In CREATE mode the number is the pending drop's.
const pinPlotNo = $derived.by(() => {
	if (isCreate) return pendingPlotNo ?? 0;
	const k = (feature?.properties?.pinTypeKey as string) ?? "";
	const m = k.match(/^plot:(\d+)$/);
	return m ? Number(m[1]) : 0;
});
// The STORED survey-local number — the stable key used to match the right row
// in the live form and to deep-link "open in form". NOT shown to the user.
const plotNo = $derived(plot?.plotNo || pinPlotNo);
// The DYNAMIC per-map number the user SEES (pin label + title). It re-flows as
// surveys merge / plots delete. Falls back to the survey-local number if the
// plot can't be resolved (e.g. survey already filed away).
const displayNo = $derived(plot?.displayNo || plot?.plotNo || pinPlotNo);

// The plot NUMBER is the identity. The full Open LoCode (Plus Code) rides beneath
// the title as a faint, copyable sub-line — always shown when the plot has a GPS
// fix to encode. `copyLoCode` writes the FULL code to the clipboard.
const plotFullCode = $derived(q704 ? q704.plotFullCodeByGpsKey(mapFeatureKey) : "");
// The locally-varying TAIL of the full code — the 3 chars before the `+` through
// the end (e.g. 87G3H2PG+QFG → 2PG+QFG). Shown as a bright accent beside the plot
// number so the plot reads as "#33 · 2PG+QFG" at a glance; the full code stays on
// the copyable sub-line below.
const plotShortCode = $derived.by(() => {
	const plus = plotFullCode.indexOf("+");
	if (plus < 0) return "";
	return plotFullCode.slice(Math.max(0, plus - 3));
});
let loCodeCopied = $state(false);
let loCodeCopyFailed = $state(false); // clipboard blocked → the button flashes an ✕
let loCodeCopiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyLoCode() {
	if (!plotFullCode) return;
	const ok = await ports.ui.copyToClipboard(plotFullCode);
	loCodeCopied = ok;
	loCodeCopyFailed = !ok;
	if (loCodeCopiedTimer) clearTimeout(loCodeCopiedTimer);
	loCodeCopiedTimer = setTimeout(() => {
		loCodeCopied = false;
		loCodeCopyFailed = false;
		loCodeCopiedTimer = null;
	}, 1400);
}

const counted = $derived(plot != null && plot.planted != null);

// Derived plot state → drives the per-pill tints (mirrors the design mock).
// Nulls read as 0 for the maths; the raw value still renders in the pill.
const planted = $derived(plot?.planted ?? 0);
const spots = $derived(plot?.spots ?? 0);
const excess = $derived(plot?.excess ?? 0);
// Empty plantable spots — planted came up short of the spot count.
const short = $derived(Math.max(0, spots - planted));
const faultCount = $derived(plot?.faults.length ?? 0);
// Fault codes grouped for the chip strip — one chip per code, ·count badge
// when the same code was logged more than once (FaultChip renders both).
const faultGroups = $derived.by<[string, number][]>(() => {
	const m = new Map<string, number>();
	for (const code of plot?.faults ?? []) m.set(code, (m.get(code) ?? 0) + 1);
	return [...m.entries()];
});

// ── THE ONE SURVEY ──────────────────────────────────────────────────────────
// There is ONE survey (the ACTIVE inspection). The popover is a WINDOW onto it,
// not a second copy. So we load the ACTIVE inspection's rows VERBATIM — no
// invented trailing blank (that's what "inserted new ones" on open), no repair
// (repairing buries the bug). Whatever the store holds is what we render; if it's
// illegal (a buried null), assertThread in the deck THROWS so we see + fix it.
// The map-drop already reserved the highest-numbered plot as the empty active
// one, so the store already contains the single legal trailing null — we don't
// add another.
let block = $state({
	blockNo: "",
	treesPerHa: null as number | null,
	totalHa: null as number | null,
	speciesChoices: [] as string[],
});
let rows = $state<MapQ704PlotRow[]>([]);
let hydrated = $state(false);
let deck = $state<MapQ704DeckExports | null>(null);
// The deck region — the celebration arm's target (reward plays over the deck).
let rewardTargetEl = $state<HTMLElement | null>(null);

// THE CYCLE — the swipe-to-file hint — is owned ENTIRELY by the shared
// Quality704Deck (it runs decideCycle and drives its own swipe hook). The popover
// wires nothing: dropping the deck in IS dropping the whole cycle in.
// True while a plot row is in the edit spotlight — freezes the shell scroll so
// the spotlit row can't slide out from under the focus scrim.
let focusing = $state(false);
// Brief hold AFTER a swipe-to-file lifts the spotlight, so the just-filed GOLD
// pill stays visible for a beat before the popover swaps to the read-only card
// (without it the swap is instant the moment the count is written). The deck now
// lifts focus immediately on file, so this is what carries the "see it go gold"
// moment — NOT a grey limbo (the old 1s timer that read grey because the row was
// still spotlighted).
let justFiledHold = $state(false);
let justFiledTimer: ReturnType<typeof setTimeout> | null = null;
function onDeckFocusingChange(f: boolean) {
	const wasFocusing = focusing;
	focusing = f;
	// Spotlight just lifted on a now-counted plot → that was a file. Hold the gold
	// deck for a short beat, then let it swap to the read-only view. Read the
	// LIVE rows (not `counted`) — the persist $effect may not have flushed the
	// swipe's write to the store yet when this callback fires.
	const nowCounted = rows.some((r) => r.committed && r.planted != null);
	if (wasFocusing && !f && nowCounted) {
		justFiledHold = true;
		if (justFiledTimer) clearTimeout(justFiledTimer);
		justFiledTimer = setTimeout(() => {
			justFiledHold = false;
			justFiledTimer = null;
		}, 650);
	}
}

onDestroy(() => {
	if (justFiledTimer) clearTimeout(justFiledTimer);
	if (loCodeCopiedTimer) clearTimeout(loCodeCopiedTimer);
});

onMount(async () => {
	// No q704 host → nothing to load; stay un-hydrated so the write effects never run.
	if (!q704) return;
	const saved = await q704.loadInspection();
	const want = plot?.plotNo || pinPlotNo;
	if (saved) {
		block = { ...saved.block, speciesChoices: saved.block.speciesChoices ?? [] };
		// SINGLE-PLOT WINDOW: the popover edits exactly ONE plot — the pin you
		// tapped. Seed the deck with JUST that row (not the whole survey + its
		// trailing blank), so you can't fill an "add another" row that would create
		// a phantom plot with no GPS on top of this one. Add another plot = drop
		// another pin on the map.
		rows = saved.rows
			.filter((r) => r.plotNo === want)
			.map((r) => ({ ...r, committed: r.planted != null }));
	}
	// THE PENDING (uncounted, memory-only) DROP. By the constraint, a fresh drop is
	// NOT in the store — so loadInspection can't return it, and `rows` above comes up
	// empty. Seed the deck's single editable row FROM MEMORY instead. Nothing is
	// persisted; the deck edits this row in memory, and the swipe (r.committed) is the
	// FIRST + ONLY write, via updateActivePlot → promotion. (Without this the pill +
	// swipe track vanished for a just-dropped plot — the reader assumed a store row.)
	if (rows.length === 0) {
		const pend = q704.getPendingDrop();
		if (pend && pend.plotNo === want) {
			rows = [
				{
					id: pend.rowKey,
					plotNo: pend.plotNo,
					planted: null, // uncounted — the deck fills this, the swipe files it
					plantableSpotsOverride: null,
					faults: [],
					comment: "",
					// No pin yet — the pin (gpsFeatureKey) is minted by the promotion when
					// the count is swiped. The deck row carries none.
					openLocode: pend.gridCode || undefined,
					committed: false,
				},
			];
		}
	}
	hydrated = true;
	// Land focused on the tapped plot — spotlight it in the deck (in-place edit),
	// just like the page's ?focusPlot deep-link. The number comes from the pin.
	if (want) {
		const hit = rows.find((r) => r.plotNo === want);
		if (hit) {
			deck?.focusRow(hit.id);
			// A BLANK plot (fresh drop OR a re-confronted half-done one) → go
			// straight to the trees-planted pad. The count is the first question
			// every plot asks, so the popover asks it immediately instead of
			// making the user tap the empty plaque they were about to tap anyway.
			if (hit.planted == null && !hit.committed) deck?.openPlantedFor(hit.id);
		}
	}
});

// ── COMMIT-OR-CANCEL: a plot is only SAVED by swiping it (committed). ──────────
// The deck autosaves nothing here. We write a plot to the store ONLY once it's
// FILED (r.committed = true, set by the swipe-right gesture). So an entry you type
// but don't swipe lives only in the in-memory `rows` and is DISCARDED on cancel —
// "I don't want to leave a plot half done". Targeted per-plot writes (updateActivePlot),
// never the page's destructive persistInspection. Guarded by `hydrated`.
// IMPOSSIBLE-WRITE refusal: updateActivePlot returned "missing" — no ACTIVE row
// carries the number this popover is committing under (a duplicate-heal can bump
// the stored number out from under the mount-time snapshot in `rows`). The typed
// value stays visible in the in-memory deck; this flag raises the red refusal
// strip so it never RENDERS as filed while being memory-only.
let saveFailed = $state(false);
// Report each impossible-write plot number ONCE per popover mount — the commit
// effect re-runs on every rows edit and Sentry doesn't need a copy per keystroke.
const missingReported = new Set<number>();

$effect(() => {
	if (!hydrated || !q704) return;
	// Snapshot the committed rows' data OUTSIDE any state write, so this effect's
	// reactive dependency is ONLY the rows (never plotVersion). Writing plotVersion
	// unconditionally here re-triggered the render, which re-touched rows, which
	// re-ran this effect → effect_update_depth_exceeded (the map "freeze"). Now we
	// bump plotVersion ONLY when a write actually changed the store — a fixpoint,
	// so it settles after one pass instead of looping forever.
	let changed = false;
	let missing = false;
	for (const r of rows) {
		if (r.plotNo == null) continue; // the trailing blank has no number yet.
		if (!r.committed) continue; // UNCOMMITTED → buffered in memory, not saved.
		const outcome = q704.updateActivePlot(r.plotNo, {
			planted: r.planted,
			plantableSpotsOverride: r.plantableSpotsOverride,
			plantableSpots: r.plantableSpots,
			faults: [...r.faults],
			comment: r.comment,
			species: r.species?.map((s) => ({ ...s })),
		});
		if (outcome === "updated") changed = true;
		if (outcome === "missing") {
			// The write was IMPOSSIBLE — nothing was stored. Treating this like
			// "unchanged" is how a committed count rendered as filed but lived in
			// memory only (gone on restart). Keep the value on screen (the deck's
			// rows are untouched), raise the refusal strip, and leave a trace.
			missing = true;
			if (!missingReported.has(r.plotNo)) {
				missingReported.add(r.plotNo);
				ports.ui.reportSwallowed(
					"PlotMapPopoverV2:commit",
					new Error(
						`updateActivePlot: no ACTIVE row carries plot #${r.plotNo} — the committed count was NOT persisted`,
					),
					{ plotNo: r.plotNo, mapFeatureKey, gpsFeatureKey: r.gpsFeatureKey ?? "" },
				);
			}
		}
	}
	saveFailed = missing;
	// Re-derive `plot` (reads the store imperatively) ONLY on a real write. If
	// nothing changed, don't touch plotVersion — that's what stops the loop.
	if (changed) plotVersion += 1;
});

// Persist the survey's remembered species list whenever it grows. SEPARATE from the
// per-plot effect above: a species becomes a reusable dropdown choice the moment you
// type + commit it (rememberSpecies), BEFORE the plot is filed — so this must not
// wait on r.committed. The store setter no-ops when nothing changed, so re-runs are
// cheap. This is the write the page gets for free via persistInspection; the popover
// (targeted writes only) needs it explicitly, or per-map species never persist here.
$effect(() => {
	if (!hydrated || !q704) return;
	q704.setActiveSpeciesChoices([...block.speciesChoices]);
});


// The X just closes. The unfinished-plot gate (the gold "swipe / cancel plot"
// dialog) lives in the HOST (MapDrawControls.handlePlotPopoverClose, wired to
// onClose) so there's exactly ONE gate — tapping X and tapping outside both run
// it. This popover MUST NOT pop its own second dialog (it duplicated the host's).
function requestClose() {
	onClose();
}

</script>

<!-- No quality-704 host (ports.q704 absent) → render NOTHING. The offline
     debugger host has no inspections; the popover must never throw. (28 Aug 2026) -->
{#if q704}
<MapPopoverShell {bbox} {containerWidth} {containerHeight} isPoint={true} wide={true} scrollLocked={focusing}>
	<div class="plot-pop">
		<!-- Header: quality glyph + "Quality plot" + actions -->
		<div class="pp-hdr">
			<img class="pp-glyph" src={iconPath("quality")} alt="" />
			<span class="pp-kind">Quality plot</span>
			<span class="pp-spacer"></span>
			<!-- Edit → open this plot in the quality704 FORM. Appears the moment the
			     plot is counted (a swipe-to-file flips it live via plotVersion): per
			     the rule, an existing plot is never edited inline on the map —
			     editing happens in the form. In CREATE mode (a freshly-dropped
			     uncounted plot) the deck below is already editable, so no form
			     button is needed. ICON-ONLY (the app-wide edit pencil, no label) so
			     the header row never wraps. -->
			{#if counted}
				<span class="pp-edit">
					<ports.ui.GoldButton
						size="sm"
						ariaLabel="Edit plot in form"
						title="Edit"
						onclick={() => onOpenInForm(plotNo)}
					>
						{#snippet icon()}<ports.ui.Icon name="edit-tilt" size={18} />{/snippet}
					</ports.ui.GoldButton>
				</span>
			{/if}
			<!-- Share only exists for a COUNTED plot. In CREATE mode the plot is
			     half-done (session-only, no counts yet) — nothing to share. -->
			{#if counted}
				<button class="pp-icon" aria-label="Share plot" title="Share" use:atvShare onclick={() => onShare("getcache")}>
					<ports.ui.Icon name="share" size={18} />
				</button>
			{/if}
			<!-- No delete: a plot pin is the plot's key; it can't be deleted from
			     here (convention shared with the feature popover). -->
			<button class="rt-popover-close" aria-label="Close" title="Close" onclick={requestClose}><ports.ui.Icon name="close-x" /></button>
		</div>

		<!-- Title = the permanent plot NUMBER (read-only — it's the key). The
		     full Open LoCode (Plus Code) rides beneath as a faint sub-line with
		     a faint copy button — the number stays the identity. Status lives on
		     the PLOT DATA pills below (their colours + inline "+N over" etc.),
		     not in a separate chips row. -->
		<div class="pp-title" aria-label="Plot {displayNo}">
			<span class="pp-title-lead">Plot #</span>
			<span class="pp-title-no">{displayNo}</span>
			{#if plotShortCode}
				<span class="pp-title-code" aria-label="Plot code {plotShortCode}">
					<span class="pp-title-code-bar">|</span>&nbsp;{plotShortCode}
				</span>
			{/if}
			{#if plotFullCode}
				<div class="pp-locode-row">
					<span class="pp-locode">{plotFullCode}</span>
					<button
						type="button"
						class="pp-locode-copy"
						aria-label="Copy location code"
						title="Copy"
						onclick={copyLoCode}
					>
						{#if loCodeCopied}
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
								<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
							</svg>
							<span class="pp-locode-copy-text">COPIED</span>
						{:else if loCodeCopyFailed}
							<!-- Write failed — flash an ✕ so the tap never does nothing. -->
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
								<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
							</svg>
							<span class="pp-locode-copy-text">FAILED</span>
						{:else}
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
								<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2" />
								<path d="M5 15V5a2 2 0 012-2h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
							</svg>
							<span class="pp-locode-copy-text">COPY</span>
						{/if}
					</button>
				</div>
			{/if}
		</div>

		<!-- IMPOSSIBLE-WRITE refusal — the commit effect couldn't find this plot's
		     row (see saveFailed). The count the user typed is still on screen in
		     the deck below; this strip (the popover's red fault chrome) says it is
		     NOT saved. Reopening the pin re-resolves the plot's current number, so
		     close-and-retap is the retry. -->
		{#if saveFailed}
			<div class="pp-save-failed" role="alert">
				Couldn't save this plot's count — it's shown below but NOT saved yet.
				Close this plot and tap its pin again to retry.
			</div>
		{/if}

		<!-- TWO PATHS, gated on `counted` (the rule: create that way, don't edit
		     that way):
		       • UNCOUNTED — the plot you JUST dropped from the map. Show the
		         editable pill DECK so you fill its count right here (create mode).
		       • COUNTED — an EXISTING plot. View-only data; the gold "Edit" button
		         in the header opens it inside the quality704 form (edit mode there,
		         never inline). -->
		{#if !counted || focusing || justFiledHold}
			<!-- CREATE mode: the editable plot-row deck, focused on the fresh plot.
			     Held open while `focusing` even once the plot becomes counted, so a
			     swipe-right-to-file plays its gold beat + shade-close IN the deck before
			     the popover swaps to the read-only card (avoids a jarring mid-animation
			     swap the instant the count is written). -->
			<div class="pp-deck" bind:this={rewardTargetEl} in:fade={{ duration: 180 }} out:fade={{ duration: 160 }}>
				<q704.Quality704Deck
					bind:this={deck}
					bind:block
					bind:rows
					showHeader
					singlePlot
					mapNumberFor={(r) =>
						(r.gpsFeatureKey && q704.activeMapNumbering().get(r.gpsFeatureKey)) || 0}
					onFocusingChange={onDeckFocusingChange}
					onReward={() => q704.celebrate.onInputComplete()}
					autoRestoreMissed={false}
				/>
			</div>
		{:else if plot}
			<!-- VIEW-only: an already-counted plot. Derived cells, read-only. Tap
			     "Edit" (header) to change it — that opens the quality704 form. The
			     whole view cross-fades in as the editable deck fades out (a swipe-file
			     transitions editable → read-only smoothly, not an instant snap). -->
			<div class="pp-view" in:fade={{ duration: 220, delay: 120 }} out:fade={{ duration: 160 }}>
			<div class="pp-sect">PLOT DATA</div>
			<!-- FOUR pills, ONE line — Planted / Spots / Excess / Faults. No
			     Satisf./Unsat. pills and no "+N over" annotation: satisfactory
			     is derivable, unsat ≡ faults, and over ≡ excess — the pill's
			     colour alone carries the status. Fits as long as counts stay
			     under triple digits. -->
			<div class="pp-data">
				<div class="pp-cell" class:pp-cell--under={short > 0}>
					<span class="pp-k">Planted</span>
					<span class="pp-v">{plot.planted}</span>
				</div>
				<div class="pp-cell"><span class="pp-k">Spots</span><span class="pp-v">{plot.spots}</span></div>
				<div class="pp-cell" class:pp-cell--over={excess > 0}>
					<span class="pp-k">Excess</span>
					<span class="pp-v">{plot.excess}</span>
				</div>
				<div class="pp-cell" class:pp-cell--bad={faultCount > 0}>
					<span class="pp-k">Faults</span>
					<span class="pp-v">{faultCount}</span>
				</div>
			</div>
			{#if faultGroups.length > 0}
				<!-- The fault CODES, one small chip per code (·count when logged
				     more than once) — the same FaultChip the quality deck uses,
				     tightened via its CSS-var knobs to footnote size. -->
				<div class="pp-fault-strip">
					{#each faultGroups as [code, count] (code)}
						<q704.FaultChip {code} {count} />
					{/each}
				</div>
			{/if}
			{#if plot.comment.trim()}
				<div class="pp-comments">
					<div class="pp-sect">Comments</div>
					<p class="pp-comment-text">{plot.comment}</p>
				</div>
			{/if}
			</div>
		{/if}

		<!-- The unfinished-plot gate (gold "swipe / cancel plot") is the HOST's single
		     dialog (MapDrawControls), not duplicated here. -->
	</div>
</MapPopoverShell>

<!-- Reward arm — plays over the deck on every successful action (file / edit).
     CelebrateHost now portals into the phone frame at Z_HANDS (above the footer,
     clipped to the bezel), so no per-host zIndex is needed — it clears the popover
     surface AND the footer by default. -->
<q704.CelebrateHost target={rewardTargetEl} />
{/if}

<style>
	.plot-pop {
		position: relative; /* anchor for the discard-gate overlay */
		display: flex;
		flex-direction: column;
		gap: 8px;
		color: var(--rt-fg, #f3ead2);
	}

	/* Host the shared deck — the deck draws its own grey box border, so keep it
	   INSIDE the popover padding (no negative side margin, which used to push the
	   box's corners outside the shell and let the gold surface poke past them). */
	.pp-deck {
		margin: 4px 0 0;
	}

	/* ── header ── */
	.pp-hdr {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.pp-glyph {
		width: 39px;
		height: 39px;
		object-fit: contain;
		flex: 0 0 auto;
	}
	.pp-kind {
		font-family: var(--rt-font-display), sans-serif;
		font-weight: 700;
		/* Standard popover-header size (matches FeatureView2 title). */
		font-size: 1.05rem;
		letter-spacing: 0.02em;
		color: var(--rt-yellow, #ffd700);
	}
	.pp-spacer {
		flex: 1 1 auto;
	}
	.pp-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		/* As tall as the quality glyph (39px) so the action row isn't thin/cramped.
		   border-box so the 1.5px border counts INTO the 39px — matches the
		   border-box GoldButton Edit pill exactly (else the border added 3px). */
		box-sizing: border-box;
		width: 39px;
		height: 39px;
		border-radius: var(--rt-radius-sm, 8px);
		/* Brighter than the other actions: solid gold border + faint gold tint. */
		border: 1.5px solid var(--rt-gold-1, #f5d565);
		background: rgba(232, 185, 35, 0.12);
		color: var(--rt-gold-1, #f5d565);
		cursor: pointer;
	}

	/* The gold Edit pencil — ICON-ONLY (no label) so the header row never wraps.
	   A 39px SQUARE, same as the Share / glyph buttons, so the header reads as
	   one even band. Wrapper shrinks the shared GoldButton (default width:100%)
	   to its content so it sits inline beside Share + ×. */
	.pp-edit {
		display: inline-flex;
		flex: none;
	}
	.pp-edit :global(.gold-btn) {
		box-sizing: border-box;
		width: 39px;
		height: 39px;
		padding: 0;
	}
	/* Strip the shared GoldButton's badge chrome (fixed circle, border, bg) —
	   the bare pencil centers itself in the square. */
	.pp-edit :global(.gold-btn .badge) {
		width: auto;
		height: auto;
		border: none;
		border-radius: 0;
		background: none;
	}
	/* ── title (read-only plot number) ── */
	.pp-title {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px 8px;
		padding: 8px 12px;
		border-radius: var(--rt-radius-sm, 8px);
		background: rgba(0, 0, 0, 0.32);
		border: 1px solid var(--rt-border, rgba(232, 185, 35, 0.18));
	}
	.pp-title-lead {
		font-family: var(--rt-font-display), sans-serif;
		font-weight: 800;
		font-size: 1.5rem;
		line-height: 1;
		color: var(--rt-fg-context, #d9a679);
	}
	.pp-title-no {
		font-family: var(--rt-font-display), sans-serif;
		font-weight: 800;
		font-size: 1.5rem;
		line-height: 1;
		color: var(--rt-yellow, #ffd700);
	}
	/* Plot-code accent beside the number — the short, locally-varying tail of the
	   Open LoCode in the same gold display hue as the plot number, with a bright
	   leading bar. Reads as the plot's at-a-glance secondary id; the full code stays
	   on the sub-line. */
	.pp-title-code {
		font-family: var(--rt-font-display), sans-serif;
		font-weight: 800;
		font-size: 1.5rem;
		line-height: 1;
		letter-spacing: 0.01em;
		color: var(--rt-yellow, #ffd700);
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		margin-left: 8px;
	}
	/* Leading bar sits in the quiet context hue, with a space either side. */
	.pp-title-code-bar {
		color: var(--rt-fg-context, #d9a679);
		opacity: 0.85;
	}
	/* Full Open LoCode sub-line — a quiet mono row beneath the plot number, with a
	   faint copy button on the right (same hue as the text, just dim). */
	.pp-locode-row {
		flex-basis: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 2px;
	}
	.pp-locode {
		font-family: var(--rt-font-mono, ui-monospace, monospace);
		font-size: 0.72rem;
		letter-spacing: 0.01em;
		color: var(--rt-fg-context, #d9a679);
		opacity: 0.7;
	}
	/* ⛔ A REAL GOLD BUTTON WITH A LABEL — not a faint 14px glyph.
	   It was a bare icon at 0.45 opacity with no text, so it read as decoration
	   rather than an action and was repeatedly missed. Gold is this app's
	   "do-this" colour and every other action in the popover uses it; a copy
	   control that looks nothing like them is the odd one out, not the subtle
	   one. Same border + tint + hue as `.pp-share` so the row reads as one set. */
	.pp-locode-copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		box-sizing: border-box;
		padding: 0 10px;
		height: 28px;
		border-radius: var(--rt-radius-sm, 8px);
		border: 1.5px solid var(--rt-gold-1, #f5d565);
		background: rgba(232, 185, 35, 0.12);
		color: var(--rt-gold-1, #f5d565);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: background 120ms ease;
	}
	.pp-locode-copy:hover,
	.pp-locode-copy:active {
		background: rgba(232, 185, 35, 0.24);
	}
	/* The word, beside the glyph. Hidden from screen readers because the button
	   already carries an aria-label that says the same thing. */
	.pp-locode-copy-text {
		line-height: 1;
	}


	/* Read-only view wrapper — keeps the sect/data/comments spacing they had as
	   direct flex children of .plot-pop, now that they cross-fade as one block. */
	.pp-view {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* ── data ── */
	.pp-sect {
		font-family: var(--rt-font-display), sans-serif;
		font-size: 0.7rem;
		letter-spacing: 0.08em;
		color: var(--rt-fg-context, #d9a679);
		margin-top: 2px;
	}
	/* Compact PILL row — label + number side by side, ONE line (four pills
	   share the width; holds as long as counts stay under triple digits).
	   The pill's own colour IS the status. */
	.pp-data {
		display: flex;
		flex-wrap: nowrap;
		gap: 5px;
	}
	.pp-cell {
		display: inline-flex;
		/* Wrap INSIDE the pill when the popover is too narrow: the value drops
		   under its label (label-over-number) instead of pushing past the border.
		   Label and value each stay whole via nowrap on .pp-k / .pp-v. */
		flex-wrap: wrap;
		flex: 1 1 auto;
		min-width: 0;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 6px;
		padding: 7px 9px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.28);
		/* Neutral frame so every pill reads as a framed tile; the semantic
		   states swap this border for a coloured one. */
		border: 1px solid rgba(255, 255, 255, 0.18);
	}
	/* UNDER (missed spots) — rose. */
	.pp-cell--under {
		background: color-mix(in srgb, var(--rt-q704-under) 16%, rgba(0, 0, 0, 0.28));
		border-color: var(--rt-q704-under);
	}
	/* OVER (excess) — teal. */
	.pp-cell--over {
		background: color-mix(in srgb, var(--rt-q704-over) 16%, rgba(0, 0, 0, 0.28));
		border-color: var(--rt-q704-over);
	}
	/* BAD (Faults) — red. */
	.pp-cell--bad {
		background: color-mix(in srgb, var(--rt-q704-fault) 18%, rgba(0, 0, 0, 0.28));
		border-color: var(--rt-q704-fault);
	}
	/* IMPOSSIBLE-WRITE refusal strip — the same red fault chrome as .pp-cell--bad,
	   as a full-width line under the title. Loud by design: the value on screen is
	   NOT saved. */
	.pp-save-failed {
		padding: 7px 10px;
		border-radius: var(--rt-radius-sm, 8px);
		background: color-mix(in srgb, var(--rt-q704-fault) 18%, rgba(0, 0, 0, 0.28));
		border: 1px solid var(--rt-q704-fault);
		font-size: 0.82rem;
		line-height: 1.3;
		color: var(--rt-fg, #f3ead2);
	}
	/* Fault-code footnote row under the pills — the shared FaultChip, shrunk
	   via its CSS-var knobs (the deck's row strip does the same). */
	.pp-fault-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		--chip-h: 22px;
		--chip-pad-x: 7px;
		--chip-font: 12px;
		--chip-radius: 6px;
		--badge-min: 13px;
		--badge-h: 13px;
		--badge-font: 9px;
	}
	/* COMMENTS — a framed box like the mock; always present (placeholder when
	   empty). Read-only here; editing happens in the form. */
	.pp-comments {
		margin-top: 2px;
		padding: 8px 10px;
		border-radius: var(--rt-radius-sm, 8px);
		background: rgba(0, 0, 0, 0.28);
		border: 1px solid rgba(255, 255, 255, 0.06);
	}
	.pp-comment-text {
		margin: 4px 0 0;
		font-size: 0.86rem;
		line-height: 1.3;
		color: var(--rt-fg, #f3ead2);
		word-break: break-word;
	}
	.pp-k {
		font-size: 0.62rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--rt-fg-context, #d9a679);
		white-space: nowrap;
	}
	.pp-v {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		font-size: 1rem;
		color: var(--rt-fg, #f3ead2);
		white-space: nowrap;
	}
	/* Close ✕ — the SAME 39px square + radius as the Edit pencil and Share
	   (.pp-icon) beside it, so the header action row reads as one even band of
	   identical tiles. Border weight matches .pp-icon's 1.5px; colour comes
	   from the global .rt-popover-close (opaque muted grey). Scoped to THIS
	   popover so other popovers' close buttons keep their size. */
	.plot-pop :global(.rt-popover-close) {
		box-sizing: border-box;
		width: 39px;
		height: 39px;
		border-radius: var(--rt-radius-sm, 8px);
		border-width: 1.5px;
	}

</style>
