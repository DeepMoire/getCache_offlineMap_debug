<!-- PlotMapPopover (V2) — gated on counted: CREATE (uncounted) shows the editable deck; VIEW (counted) is read-only — never edit inline here, edit via the quality704 form. -->
<script lang="ts">
import { iconPath } from "../shared/icons";
import type { Feature } from "geojson";
import { onDestroy, onMount } from "svelte";
import { fade } from "svelte/transition";
import MapPopoverShell from "../panels/MapPopoverShell.svelte";
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
	// ports.q704 is OPTIONAL — a host with no inspections leaves it out and this popover renders nothing.
	ports: MapHostPorts;
	// VIEW mode: an existing, counted plot's map feature (a real DB-backed pin).
	feature?: Feature | null;
	// CREATE mode: pendingPlotNo set → no feature yet (pin doesn't exist until swiped+written); deck seeds from the in-memory pending drop.
	pendingPlotNo?: number | null;
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	containerWidth: number;
	containerHeight: number;
	onShare: (format: MapShareFormat) => void;
	onClose: () => void;
	// Jump to the Quality 704 form, focused on this plot number.
	onOpenInForm: (plotNo: number) => void;
} = $props();

// const (not let) so {#if q704} narrows correctly in nested blocks; every store call below no-ops when q704 is absent.
const q704 = $derived(ports.q704);
// `use:atvShare` needs a local action — bound here to the host's.
function atvShare(node: HTMLElement) {
	return q704 ? q704.atvShare(node) : undefined;
}

// ⚠️ NEVER discard a plot on unmount — only the host's "cancel plot" gate discards; a half-done plot is re-confronted, not deleted.
const mapFeatureKey = $derived((feature?.properties?.mapFeatureKey as string) ?? "");
// CREATE mode iff pendingPlotNo was passed (no pin until the count is written); VIEW mode otherwise.
const isCreate = $derived(pendingPlotNo != null);
// ⚠️ plotByGpsKey reads the store imperatively (runes can't track it) — plotVersion must bump after every write, or `counted` freezes and the Edit pencil never appears until a full close/reopen.
let plotVersion = $state(0);
const plot = $derived.by<MapQ704PlotPinData | null>(() => {
	void plotVersion;
	if (!q704) return null;
	// CREATE: render the popover from the in-memory pending drop (no store row yet).
	if (isCreate) return q704.pendingDropPinData();
	// VIEW: an existing plot, read from the database via its pin.
	return mapFeatureKey ? q704.plotByGpsKey(mapFeatureKey) : null;
});

// Fallback: parse the number from the pin's own type key (`plot:N`) if the row lookup misses; CREATE mode uses the pending drop's number.
const pinPlotNo = $derived.by(() => {
	if (isCreate) return pendingPlotNo ?? 0;
	const k = (feature?.properties?.pinTypeKey as string) ?? "";
	const m = k.match(/^plot:(\d+)$/);
	return m ? Number(m[1]) : 0;
});
// The STORED survey-local number — stable key for matching the row / deep-linking "open in form"; NOT shown to the user.
const plotNo = $derived(plot?.plotNo || pinPlotNo);
// The DYNAMIC per-map number the user SEES (pin label + title) — re-flows as surveys merge/plots delete; falls back to the survey-local number.
const displayNo = $derived(plot?.displayNo || plot?.plotNo || pinPlotNo);

// Plot NUMBER is the identity; the full Open LoCode rides beneath as a faint, copyable sub-line. `copyLoCode` writes the FULL code.
const plotFullCode = $derived(q704 ? q704.plotFullCodeByGpsKey(mapFeatureKey) : "");
// plotShortCode — the locally-varying tail of the full code (e.g. 87G3H2PG+QFG → 2PG+QFG), shown beside the plot number.
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

// Derived plot state drives the per-pill tints — nulls read as 0 for maths, but the raw value still renders.
const planted = $derived(plot?.planted ?? 0);
const spots = $derived(plot?.spots ?? 0);
const excess = $derived(plot?.excess ?? 0);
// Empty plantable spots — planted came up short of the spot count.
const short = $derived(Math.max(0, spots - planted));
const faultCount = $derived(plot?.faults.length ?? 0);
// Fault codes grouped for the chip strip — one chip per code, ·count badge when a code repeats.
const faultGroups = $derived.by<[string, number][]>(() => {
	const m = new Map<string, number>();
	for (const code of plot?.faults ?? []) m.set(code, (m.get(code) ?? 0) + 1);
	return [...m.entries()];
});

// ⚠️ ONE survey, loaded VERBATIM — no invented trailing blank, no repair (repairing buries the bug); an illegal buried null makes the deck's assertThread THROW on purpose.
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

// THE CYCLE (swipe-to-file) is owned entirely by Quality704Deck — the popover wires nothing; dropping the deck in IS dropping the cycle in.
// True while a plot row is in the edit spotlight — freezes shell scroll so it can't slide from under the focus scrim.
let focusing = $state(false);
// justFiledHold keeps the just-filed GOLD pill visible for a beat before swapping to read-only (else the swap is instant).
let justFiledHold = $state(false);
let justFiledTimer: ReturnType<typeof setTimeout> | null = null;
function onDeckFocusingChange(f: boolean) {
	const wasFocusing = focusing;
	focusing = f;
	// Read LIVE rows here, not `counted` — the persist $effect may not have flushed the swipe's write to the store yet when this fires.
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
		// ⚠️ SINGLE-PLOT WINDOW: seed the deck with only the tapped row — never the whole survey + trailing blank, or "add another" creates a phantom plot with no GPS.
		rows = saved.rows
			.filter((r) => r.plotNo === want)
			.map((r) => ({ ...r, committed: r.planted != null }));
	}
	// A fresh drop isn't in the store yet — seed the deck's row from memory; the swipe (r.committed) is the FIRST write, via updateActivePlot → promotion.
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
					// No pin yet — gpsFeatureKey is minted by the promotion when the count is swiped.
					openLocode: pend.gridCode || undefined,
					committed: false,
				},
			];
		}
	}
	hydrated = true;
	// Lands focused on the tapped plot — spotlight it in the deck, like the page's ?focusPlot deep-link.
	if (want) {
		const hit = rows.find((r) => r.plotNo === want);
		if (hit) {
			deck?.focusRow(hit.id);
			// A blank plot jumps straight to the trees-planted pad — the count is the first question every plot asks.
			if (hit.planted == null && !hit.committed) deck?.openPlantedFor(hit.id);
		}
	}
});

// ⚠️ Only writes on commit (swipe-right); an untyped-but-unswiped row is discarded. Uses targeted updateActivePlot — never the page's destructive persistInspection.
// saveFailed: updateActivePlot returned "missing" — a duplicate-heal can bump the plot number out from under `rows`'s mount-time snapshot; raises the refusal strip so an unsaved value never renders as filed.
let saveFailed = $state(false);
// Reports each impossible-write plot number ONCE per mount — the commit effect re-runs on every rows edit.
const missingReported = new Set<number>();

$effect(() => {
	if (!hydrated || !q704) return;
	// ⚠️ Bump plotVersion ONLY when a write actually changed the store — bumping unconditionally causes an infinite effect loop (effect_update_depth_exceeded, the map "freeze").
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
			// ⚠️ "missing" write is IMPOSSIBLE, not "unchanged" — treating it as unchanged is how a committed count rendered as filed but lived only in memory (gone on restart).
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
	// Only bump plotVersion on a real write — untouched otherwise, which is what stops the loop.
	if (changed) plotVersion += 1;
});

// ⚠️ Species persist must NOT wait on r.committed (must fire before the plot is filed) — the popover needs this explicit write or per-map species never persist (page gets it free via persistInspection).
$effect(() => {
	if (!hydrated || !q704) return;
	q704.setActiveSpeciesChoices([...block.speciesChoices]);
});


// ⚠️ Must NOT pop its own unfinished-plot dialog — that gate lives in the HOST (MapDrawControls.handlePlotPopoverClose) so X and tap-outside share exactly ONE gate.
function requestClose() {
	onClose();
}

</script>

<!-- No q704 host → render NOTHING (the offline debugger has no inspections) — must never throw. -->
{#if q704}
<MapPopoverShell {bbox} {containerWidth} {containerHeight} isPoint={true} wide={true} scrollLocked={focusing}>
	<div class="plot-pop">
		<!-- Header: quality glyph + "Quality plot" + actions -->
		<div class="pp-hdr">
			<img class="pp-glyph" src={iconPath("quality")} alt="" />
			<span class="pp-kind">Quality plot</span>
			<span class="pp-spacer"></span>
			<!-- Edit appears once counted — an existing plot is never edited inline; editing happens in the quality704 form. Icon-only so the header row never wraps. -->
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
			<!-- Share only exists for a COUNTED plot — nothing to share while CREATE mode is still session-only. -->
			{#if counted}
				<button class="pp-icon" aria-label="Share plot" title="Share" use:atvShare onclick={() => onShare("getcache")}>
					<ports.ui.Icon name="share" size={18} />
				</button>
			{/if}
			<!-- No delete: a plot pin is the plot's key and can't be deleted from here (shared convention with the feature popover). -->
			<button class="rt-popover-close" aria-label="Close" title="Close" onclick={requestClose}><ports.ui.Icon name="close-x" /></button>
		</div>

		<!-- Title = the permanent plot NUMBER (read-only, the key); status lives on the PLOT DATA pills below, not a separate chips row. -->
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

		<!-- IMPOSSIBLE-WRITE refusal strip: saveFailed → value stays on screen but is NOT saved; close-and-retap the pin to retry. -->
		{#if saveFailed}
			<div class="pp-save-failed" role="alert">
				Couldn't save this plot's count — it's shown below but NOT saved yet.
				Close this plot and tap its pin again to retry.
			</div>
		{/if}

		<!-- Gated on `counted`: UNCOUNTED shows the editable deck (create); COUNTED is view-only — Edit opens the quality704 form, never inline. -->
		{#if !counted || focusing || justFiledHold}
			<!-- CREATE mode deck; stays open while `focusing` even once counted, so the swipe-to-file animation finishes before swapping to read-only. -->
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
			<!-- VIEW-only: read-only derived cells; tap "Edit" (header) to open the quality704 form. Cross-fades in as the deck fades out. -->
			<div class="pp-view" in:fade={{ duration: 220, delay: 120 }} out:fade={{ duration: 160 }}>
			<div class="pp-sect">PLOT DATA</div>
			<!-- Four pills (Planted/Spots/Excess/Faults), one line — pill colour alone carries status; fits as long as counts stay under triple digits. -->
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
				<!-- Fault codes: one chip per code (·count if repeated) — the same FaultChip as the quality deck, shrunk via its CSS-var knobs. -->
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

		<!-- Unfinished-plot gate is the HOST's single dialog (MapDrawControls), not duplicated here. -->
	</div>
</MapPopoverShell>

<!-- Reward arm plays over the deck on every successful action. CelebrateHost portals at Z_HANDS (above the footer, clipped to the bezel) — no per-host zIndex needed. -->
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

	/* Deck draws its own border — keep INSIDE the popover padding; a negative side margin used to push its corners past the gold shell surface. */
	.pp-deck {
		margin: 4px 0 0;
	}

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
		/* border-box so the 1.5px border counts INTO the 39px height — else it'd add 3px and mismatch the GoldButton Edit pill. */
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

	/* Icon-only 39px square (matches Share/glyph buttons) — wrapper shrinks the shared GoldButton's default width:100% to fit inline. */
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
	/* Strips the shared GoldButton's badge chrome (circle/border/bg) — the bare pencil centres itself. */
	.pp-edit :global(.gold-btn .badge) {
		width: auto;
		height: auto;
		border: none;
		border-radius: 0;
		background: none;
	}
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
	/* Plot-code accent: the short tail of the Open LoCode, gold like the plot number, with a bright leading bar. Full code stays on the sub-line. */
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
	/* Full Open LoCode sub-line: quiet mono row beneath the plot number with a faint copy button (dim, same hue as the text). */
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
	/* ⛔ Must be a real gold button WITH a label — a bare 0.45-opacity icon read as decoration and was repeatedly missed. Same border/tint/hue as .pp-share. */
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
	/* Word beside the glyph is hidden from screen readers — the button's aria-label already says the same thing. */
	.pp-locode-copy-text {
		line-height: 1;
	}


	/* Read-only view wrapper — keeps the sect/data/comments spacing from when they were direct .plot-pop children. */
	.pp-view {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.pp-sect {
		font-family: var(--rt-font-display), sans-serif;
		font-size: 0.7rem;
		letter-spacing: 0.08em;
		color: var(--rt-fg-context, #d9a679);
		margin-top: 2px;
	}
	/* Compact pill row: label+number side by side, one line — pill colour alone carries status (holds under triple-digit counts). */
	.pp-data {
		display: flex;
		flex-wrap: nowrap;
		gap: 5px;
	}
	.pp-cell {
		display: inline-flex;
		/* Wraps INSIDE the pill when too narrow (value drops under the label) instead of pushing past the border; .pp-k/.pp-v stay whole via nowrap. */
		flex-wrap: wrap;
		flex: 1 1 auto;
		min-width: 0;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 6px;
		padding: 7px 9px;
		border-radius: 10px;
		background: rgba(0, 0, 0, 0.28);
		/* Neutral frame — every pill reads as a tile; semantic states swap this border for a coloured one. */
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
	/* Same red fault chrome as .pp-cell--bad — loud by design, the value on screen is NOT saved. */
	.pp-save-failed {
		padding: 7px 10px;
		border-radius: var(--rt-radius-sm, 8px);
		background: color-mix(in srgb, var(--rt-q704-fault) 18%, rgba(0, 0, 0, 0.28));
		border: 1px solid var(--rt-q704-fault);
		font-size: 0.82rem;
		line-height: 1.3;
		color: var(--rt-fg, #f3ead2);
	}
	/* Fault-code footnote row — the shared FaultChip, shrunk via its CSS-var knobs (same as the deck's row strip). */
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
	/* Comments box: framed, always present. Read-only here — editing happens in the form. */
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
	/* Close ✕ matches Edit/Share's 39px square + 1.5px border; scoped to THIS popover so other popovers' close buttons keep their size. */
	.plot-pop :global(.rt-popover-close) {
		box-sizing: border-box;
		width: 39px;
		height: 39px;
		border-radius: var(--rt-radius-sm, 8px);
		border-width: 1.5px;
	}

</style>
