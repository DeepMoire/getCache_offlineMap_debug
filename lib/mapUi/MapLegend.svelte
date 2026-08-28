<!--
  MapLegend — the colour/symbol key for the map, shared by BOTH the online
  Sandbox map (/mobile/map) and the offline map (/mobile/offlinev4).

  PRESENTATION — a TOP DRAWER that slides down and STAYS down. It portals out
  of the page (overlayPortal, position:fixed, z:51) exactly like the typing
  top-drawers (InputPopover) so it drops from the true top edge, OVER the z:50
  nav — without the portal, the page's .mobile-content z:0 stacking context
  traps it beneath the nav and the close is unreachable. Unlike InputPopover
  there is deliberately NO backdrop and NO tap-outside dismiss: the whole point
  is flipping the show/hide eyes and the PDF opacity slider while panning the
  live map underneath and watching the effect. The ONLY way out is the gold OK
  button (header styled 1:1 after InputPopover's inline-confirm header).
  Opening it collapses the bottom modules drawer (MapDrawControls wraps
  onLegend) so the map is clear.

  It always lists the USER OVERLAY types the inspector draws — Pin, Plot,
  Polygon, PDF map — because those are what's actually on the map and were
  missing from the old basemap-only legend. This is also the ONE place the
  show/hide toggles live (they used to be duplicated in the Basemap popover).
  The PDF row carries the shared overlay-opacity slider INLINE between its
  label and eye (same overlayOpacity store as the inbox sheet + layers panel,
  so all three sliders stay in sync). The Polygon row carries the same kind of
  slider — a blanket fill-opacity for ALL drawn polygons (polygonOpacity store
  → applyPolygonFillOpacity in mapDraw.ts); outlines never fade. BOTH sliders
  rest at CENTRE (their default strength — a tick above the track marks it):
  left fades toward invisible, right pushes stronger. Labels in slider rows are
  a fixed-width column so the two tracks align and run the same length.
  Callers may pass extra `basemapRows` for
  the basemap line/fill types (roads, water, …) which differ per route; those
  render in a second group below the overlays.

  Swatches mirror how each thing renders on the map:
    • Pin        — the default pin glyph (pin_default_sm.webp, same asset as the marker)
    • Plot       — gold "N" plaque (numbered Quality-704 plot pin)
    • Polygon    — terracotta fill + solid terracotta outline (POLYGON_FILL/OUTLINE)
    • PDF map    — the pdfMaps globe icon (the imported-overlay layer)
-->
<script lang="ts">
import { cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import {
	FIRE_HIDE_TTL_MS,
	type OverlayKind,
	overlayVisibility,
} from "$lib/mobile/stores/overlayVisibility.svelte";
import {
	overlayOpacity,
	polygonOpacity,
} from "$lib/mobile/stores/overlayOpacity.svelte";
import { overlayPortal } from "$lib/mobile/utils/overlayPortal";
import { createEyeToggle } from "$lib/mobile/animation/eyeBlink.svelte";

// Toggle eyes — hiding a type plays the close sequence (rests closed), showing
// plays open (rests open). Keyed by overlay kind so only the tapped row moves.
const eyeToggle = createEyeToggle();
$effect(() => () => eyeToggle.destroy());

function toggleKind(kind: OverlayKind) {
	overlayVisibility.toggle(kind);
	eyeToggle.play(overlayVisibility.isVisible(kind), kind);
}

type SwatchKind =
	| "line"
	| "dashed"
	| "fill"
	| "rail"
	| "pin"
	| "plot"
	| "pdf"
	| "fire";
export type LegendRow = { label: string; color: string; swatch: SwatchKind };

// The drawn-overlay rows. Every row maps to an OverlayKind and is a TAP TOGGLE
// (tap to show/hide that type on a busy map; off = dimmed). Colours mirror the
// real render paints: POLYGON_FILL/OUTLINE in $parent/siblings/.../mapDraw.ts, gold glyphs
// in pinMarkers.
type OverlayRow = { label: string; color: string; swatch: SwatchKind; kind: OverlayKind };
const OVERLAY_ROWS: readonly OverlayRow[] = [
	{ label: "Pin", color: "#f5d565", swatch: "pin", kind: "pins" },
	{ label: "Quality Plot", color: "#f5d565", swatch: "plot", kind: "plots" },
	{ label: "Polygon", color: "#e8a06a", swatch: "fill", kind: "shapes" },
	{ label: "PDF map", color: "#f5d565", swatch: "pdf", kind: "pdf" },
] as const;

// Wildfire sits in its OWN group, below "your marks", because it is not one of
// your marks — it's someone else's ground truth laid over your map. Same row
// chrome and the same eye as everything else (one component, one set of
// styles), but its own heading so the distinction is visible rather than
// implied. Terracotta, never red: red means a destructive action here.
const FIRE_ROW: OverlayRow = {
	label: "Wildfire",
	color: "#b36940",
	swatch: "fire",
	kind: "fires",
};

/** TTL in whole hours, for the note under the row. Derived, never retyped. */
const FIRE_HIDE_HOURS = Math.round(FIRE_HIDE_TTL_MS / 3_600_000);
/** The note swaps to the expiry promise only while fires are actually hidden. */
const fireHiddenNote = $derived(!overlayVisibility.fires);
const fireOn = $derived(overlayVisibility.isVisible(FIRE_ROW.kind));
/** Same lit-while-animating lag as the rows above: the lid finishes closing in
 *  a LIT row, THEN the row dims. */
const fireDark = $derived(eyeToggle.isSettledOff(fireOn, FIRE_ROW.kind));

let {
	onClose,
	basemapRows = [],
}: {
	onClose: () => void;
	// Basemap line/fill rows (roads, water, …) — route-specific, optional.
	basemapRows?: readonly LegendRow[];
} = $props();
</script>

<!-- Same window-blind motion as the InputPopover top drawers (fly from above,
     cubicOut). |global because the parents mount/unmount us via {#if legendOpen}.
     overlayPortal lifts it out of the page so z:51 beats the z:50 nav bar. -->
<div
	class="legend-card"
	role="dialog"
	aria-label="Map legend"
	use:overlayPortal
	in:fly|global={{ y: -420, duration: 500, easing: cubicOut, opacity: 1 }}
	out:fly|global={{ y: -420, duration: 380, easing: cubicOut, opacity: 1 }}
>
	<!-- Header matches the InputPopover drawers' inline-confirm header 1:1
	     (lowercase gold title + glossy gold OK) — the legend can't literally BE
	     an InputPopover (that closes on tap-outside; this must not), so the
	     title/OK styles below are copied from it. OK is the only way out. -->
	<div class="legend-head">
		<h2 class="legend-title">legend</h2>
		<button type="button" class="legend-ok" aria-label="Close legend" onclick={onClose}>OK</button>
	</div>

	<!-- Your marks — always present. Toggleable rows (kind != null) tap to show/hide
	     that overlay type; off = dimmed + struck eye. The ruler row is a static key. -->
	<p class="legend-group-label">Your marks · tap to show / hide</p>
	<ul class="legend-list">
		{#each OVERLAY_ROWS as entry (entry.label)}
			{@const on = overlayVisibility.isVisible(entry.kind)}
			<!-- `dark` lags `on` by the close animation (lit-while-animating law in
			     eyeBlink.svelte.ts): the lid must finish closing in a LIT row, THEN
			     the row dims. Opening needs no lag — un-dim first, lid opens lit. -->
			{@const dark = eyeToggle.isSettledOff(on, entry.kind)}
			<li class="legend-row">
				{#if entry.kind === "pdf" || entry.kind === "shapes"}
					<!-- Slider rows — PDF drives the shared overlay opacity (inbox
					     sheet + layers panel move in sync); Polygon drives the blanket
					     fill-opacity for ALL drawn polygons (outlines stay put). Either
					     way the slider sits INLINE between the label and the eye and the
					     map fades live as you drag. A slider can't nest inside a
					     <button>, so these rows are divs and the EYE is the show/hide
					     toggle. -->
					{@const slider = entry.kind === "pdf" ? overlayOpacity : polygonOpacity}
					<div class="legend-toggle legend-toggle--slider" class:is-off={dark}>
						{#if entry.kind === "pdf"}
							<span class="legend-swatch legend-swatch--pdf" style:--swatch-color={entry.color}>
								<img class="legend-swatch-img" src="/mobileAssets/pdf_maps_icon.webp" alt="" />
							</span>
						{:else}
							<span class="legend-swatch legend-swatch--fill" style:--swatch-color={entry.color}></span>
						{/if}
						<span class="legend-label">{entry.label}</span>
						<!-- Wrapper carries the centre TICK (::before) — both sliders
						     rest at 50%, the designed strength, so the tick marks home. -->
						<span class="legend-slider-wrap">
							<input
								class="legend-slider"
								type="range"
								min="0"
								max="100"
								step="1"
								value={slider.percent}
								oninput={(e) => {
									slider.setPercent(
										Number((e.currentTarget as HTMLInputElement).value),
									);
								}}
								aria-label={entry.kind === "pdf"
									? "PDF overlay opacity"
									: "Polygon fill opacity"}
							/>
						</span>
						<button
							type="button"
							class="legend-eye-btn"
							aria-pressed={on}
							aria-label="Show or hide {entry.label}"
							onclick={() => toggleKind(entry.kind)}
						>
							<img class="legend-eye" src={eyeToggle.srcFor(on, entry.kind)} alt="" aria-hidden="true" />
						</button>
					</div>
				{:else}
					<button
						type="button"
						class="legend-toggle"
						class:is-off={dark}
						aria-pressed={on}
						onclick={() => toggleKind(entry.kind)}
					>
						<span class="legend-swatch legend-swatch--{entry.swatch}" style:--swatch-color={entry.color}>
							{#if entry.swatch === "plot"}<span class="legend-plot-n">1</span>
							{:else if entry.swatch === "pin"}<img class="legend-swatch-img" src="/mobileAssets/pin_library_small/pin_default_sm.webp" alt="" />
							{/if}
						</span>
						<span class="legend-label">{entry.label}</span>
						<img class="legend-eye" src={eyeToggle.srcFor(on, entry.kind)} alt="" aria-hidden="true" />
					</button>
				{/if}
			</li>
		{/each}
	</ul>

	<!-- Wildfire — its own group because it is NOT one of your marks. Same row
	     chrome, same eye, same styles as above (literally the same component and
	     the same CSS, not a lookalike). The note under it is the honest part: the
	     eye is a shift-length declutter, not a preference, and it re-arms itself
	     (FIRE_HIDE_TTL_MS in overlayVisibility.svelte.ts). -->
	<p class="legend-group-label">Wildfire · not your marks</p>
	<ul class="legend-list">
		<li class="legend-row">
			<button
				type="button"
				class="legend-toggle"
				class:is-off={fireDark}
				aria-pressed={fireOn}
				onclick={() => toggleKind(FIRE_ROW.kind)}
			>
				<span class="legend-swatch legend-swatch--fire" style:--swatch-color={FIRE_ROW.color}>
					<img class="legend-swatch-img" src="/mobileAssets/fire_icon.webp" alt="" />
				</span>
				<span class="legend-label">{FIRE_ROW.label}</span>
				<img class="legend-eye" src={eyeToggle.srcFor(fireOn, FIRE_ROW.kind)} alt="" aria-hidden="true" />
			</button>
		</li>
	</ul>
	<p class="legend-note">
		{#if fireHiddenNote}
			Hidden for now — fires come back on their own within {FIRE_HIDE_HOURS} h.
		{:else}
			Satellite heat detections, refreshed hourly. A ring means several
			detections grouped together; fainter means older.
		{/if}
	</p>

	{#if basemapRows.length}
		<p class="legend-group-label">Basemap</p>
		<ul class="legend-list">
			{#each basemapRows as entry (entry.label)}
				<li class="legend-row">
					<span class="legend-swatch legend-swatch--{entry.swatch}" style:--swatch-color={entry.color}></span>
					<span class="legend-label">{entry.label}</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	/* Top drawer — full-width sheet flush with the top edge, rounded bottom
	   corners. position:fixed + overlayPortal = frame-local on dt-web (the
	   phone frame's contain:layout is the containing block) and above the
	   z:50 nav (z:51, same as InputPopover — portalling out of the page's
	   .mobile-content z:0 stacking context is what lets 51 beat 50). No
	   backdrop: the map underneath stays fully interactive while it's open. */
	.legend-card {
		position: fixed;
		z-index: 51;
		top: 0;
		left: 0;
		right: 0;
		max-height: min(72%, 32rem);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		padding: max(0.9rem, env(safe-area-inset-top)) 1rem 1rem;
		border-radius: 0 0 1.4rem 1.4rem;
		background: var(--color-background, #16130f);
		border: 1px solid color-mix(in srgb, var(--color-accent), transparent 55%);
		border-top: none;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
	}
	/* Header — copied from InputPopover's inline-confirm header
	   (.cache-popover-header / .cache-popover-title--inline / .cache-popover-ok)
	   so this drawer reads as the same family as every other top drawer. */
	.legend-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.legend-title {
		margin: 0;
		padding-left: 5px;
		color: var(--rt-yellow);
		font-size: 1.5rem;
		font-weight: 500;
		text-transform: lowercase;
	}
	/* Glossy gold OK — the ONLY way out of the drawer (no tap-outside dismiss). */
	.legend-ok {
		position: relative;
		flex-shrink: 0;
		padding: 0.46rem 1.35rem;
		border-radius: 0.7rem;
		border: 1px solid color-mix(in srgb, var(--rt-yellow) 70%, #000);
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--rt-yellow) 88%, #fff) 0%,
				var(--rt-yellow) 46%,
				color-mix(in srgb, var(--rt-yellow) 78%, #000) 100%
			);
		color: var(--rt-gold-ink);
		font-family: inherit;
		font-size: 1.1rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, #fff 60%, transparent),
			inset 0 -1px 1px color-mix(in srgb, var(--rt-gold-ink) 45%, transparent),
			0 2px 5px color-mix(in srgb, var(--rt-yellow) 45%, transparent),
			0 1px 2px rgba(0, 0, 0, 0.4);
		transition:
			transform 0.08s ease,
			box-shadow 0.12s ease,
			filter 0.12s ease;
	}
	/* glossy top sheen */
	.legend-ok::before {
		content: "";
		position: absolute;
		inset: 1px 1px auto 1px;
		height: 45%;
		border-radius: 0.6rem 0.6rem 0.9rem 0.9rem / 0.6rem 0.6rem 1.4rem 1.4rem;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, #fff 55%, transparent),
			transparent
		);
		pointer-events: none;
	}
	.legend-ok:active {
		transform: translateY(1px) scale(0.96);
		filter: brightness(0.94);
		box-shadow:
			inset 0 1px 2px color-mix(in srgb, var(--rt-gold-ink) 55%, transparent),
			0 1px 2px rgba(0, 0, 0, 0.4);
	}
	.legend-group-label {
		margin: 0.15rem 0 0;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--color-accent-sage, #9bb07a);
	}
	.legend-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
	/* One-line key note under the wildfire row. Sage (never grey — the
	   no-gray-on-black rule; this is read outdoors), and full-size rather than
	   shrunk-to-fine-print: it carries the "it comes back on" promise, which is
	   the whole reason hiding a hazard layer is acceptable at all. */
	.legend-note {
		margin: 0;
		padding: 0 0.2rem;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.35;
		color: var(--color-accent-sage, #9bb07a);
	}
	.legend-row { display: flex; align-items: center; gap: 0.65rem; }
	.legend-label { font-size: 0.85rem; line-height: 1.2; color: var(--rt-fg, #f3efe9); }
	.legend-swatch { flex: none; width: 1.5rem; height: 1rem; display: block; }

	/* Toggle row — a tappable button (fine gold border so it reads as one). On = full
	   opacity + gold eye; off = dimmed + faded eye (the overlay is hidden on the map). */
	.legend-toggle {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: 100%;
		padding: 0.3rem 0.45rem;
		margin: 0;
		border: 1px solid color-mix(in srgb, var(--color-accent), transparent 70%);
		border-radius: 0.5rem;
		background: transparent;
		text-align: left;
		cursor: pointer;
		transition: opacity 160ms ease, border-color 160ms ease, background 160ms ease;
	}
	.legend-toggle:active { background: color-mix(in srgb, var(--color-accent), transparent 88%); }
	/* OFF — fade the whole row and soften the border so "hidden" reads at a glance. */
	.legend-toggle.is-off {
		opacity: 0.45;
		border-color: color-mix(in srgb, var(--color-accent), transparent 85%);
	}
	/* Inline opacity sliders (PDF + Polygon rows) — a proper aligned COLUMN.
	   The label gets a fixed width so every slider starts at the same x and
	   runs the same length, instead of staggering after each label. Kept TIGHT
	   (both slider labels are 7ch — "Polygon" / "PDF map") so the track gets
	   the extra length (~180px on the 390 frame, not ~130). */
	.legend-toggle--slider .legend-label {
		flex: 0 0 8ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.legend-slider-wrap {
		position: relative;
		flex: 1;
		min-width: 3rem;
		display: flex;
		align-items: center;
	}
	/* Centre TICK — both sliders rest at 50% (the designed strength), so a
	   small white notch above the track marks home. */
	.legend-slider-wrap::before {
		content: "";
		position: absolute;
		left: 50%;
		top: -0.18rem;
		transform: translateX(-50%);
		width: 2px;
		height: 0.32rem;
		border-radius: 1px;
		background: color-mix(in srgb, #fff 85%, transparent);
		pointer-events: none;
	}
	.legend-slider {
		width: 100%;
		accent-color: var(--accent-gold, #f5d04a);
	}
	/* Slider rows are divs (a slider can't live inside a <button>), so the eye
	   gets its own real button — bare chrome, generous tap target. */
	.legend-eye-btn {
		flex: none;
		margin: -0.2rem -0.25rem;
		padding: 0.2rem 0.25rem;
		border: none;
		background: transparent;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
	}
	.legend-eye-btn .legend-eye {
		margin-left: 0;
	}

	/* Eye glyph (gold webp). The row's is-off opacity fades it for the hidden state. */
	.legend-eye {
		margin-left: auto;
		width: 1.7rem;
		height: auto;
		display: block;
		flex: none;
	}

	/* Solid line (roads). */
	.legend-swatch--line { height: 0; border-top: 3px solid var(--swatch-color); align-self: center; }
	/* Dashed line (trails). */
	.legend-swatch--dashed { height: 0; border-top: 3px dashed var(--swatch-color); align-self: center; }
	/* Railway hatch. */
	.legend-swatch--rail {
		align-self: center;
		height: 0.7rem;
		background:
			repeating-linear-gradient(90deg, var(--swatch-color) 0 2px, transparent 2px 7px),
			linear-gradient(var(--swatch-color), var(--swatch-color)) center / 100% 2px no-repeat;
	}
	/* Filled chip (water; polygon — terracotta fill + solid terracotta outline,
	   matching the on-map POLYGON_FILL/OUTLINE paints). */
	.legend-swatch--fill {
		height: 1rem;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--swatch-color), transparent 60%);
		border: 1.5px solid var(--swatch-color);
	}
	/* Wildfire — the real on-map flame asset, so the key matches the map 1:1
	   (same reasoning as the pin swatch below). */
	.legend-swatch--fire,
	/* Pin — the real default-pin marker asset, so the key matches the map 1:1. */
	.legend-swatch--pin,
	/* PDF map — the pdfMaps globe icon (same asset as the FEATURES tile hint). */
	.legend-swatch--pdf {
		align-self: center;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.35rem;
	}
	.legend-swatch-img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		display: block;
	}
	/* Plot — a small black/gold numbered plaque, mirroring the on-map plot pin. */
	.legend-swatch--plot {
		align-self: center;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1rem;
		border-radius: 0.28rem;
		background: #161616;
		border: 1.5px solid var(--swatch-color);
	}
	.legend-plot-n {
		font-family: var(--rt-font-display), sans-serif;
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1;
		color: var(--swatch-color);
	}
</style>
