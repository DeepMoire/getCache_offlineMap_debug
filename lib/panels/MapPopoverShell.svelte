<!--
  MapPopoverShell — the floating popover surface that sits over the Mapbox
  container near a selected feature. Owns ONLY positioning + the gesture
  pass-through + the glass surface; defers ALL content to its children.

  Two popovers share it: FeatureMapPopover (generic pins/lines/polys) and
  PlotMapPopover (Quality 704 plot pins). One positioning + gesture
  implementation, zero duplication.
-->
<script lang="ts" module>
// Reserve space at the top (app top bar + draw strip when active) and
// bottom (tab bar / shovel) so the popover never tucks under either.
// The bottom reserve is deliberately tight (was 120): the extra 25px of
// card height means a height-capped popover clips MID-content — a sliver
// of the next section peeks out, so the user knows to scroll. A cut that
// lands cleanly under the pill grid reads as "that's all there is".
// Exported: MapDrawControls' ensure-room pan works against the SAME
// reserves, so "will it be cut off?" is computed with one set of numbers.
export const POPOVER_TOP_RESERVE = 150;
export const POPOVER_BOTTOM_RESERVE = 95;
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import { leaderLine, placePopover } from "./mapPopoverGeom";

let {
	bbox,
	containerWidth,
	containerHeight,
	isPoint = false,
	wide = false,
	scrollLocked = false,
	children,
}: {
	bbox: { minX: number; minY: number; maxX: number; maxY: number };
	containerWidth: number;
	containerHeight: number;
	isPoint?: boolean;
	/** Wide variant — for popovers that host the full plot-row deck. Runs the
	 *  surface near full container width (pills reach the edges) instead of the
	 *  compact 260px cap. */
	wide?: boolean;
	/** Freeze the surface's own scroll. The plot deck sets this while a row is in
	 *  edit-spotlight: the shell scroll must NOT move, or the spotlit row slides
	 *  out from under the focus scrim (the scrim is trapped inside this scaled
	 *  shell, so it can't cover what scrolls past). Mirrors the page, where
	 *  focusing freezes the deck scroll too. */
	scrollLocked?: boolean;
	children: Snippet;
} = $props();

const TOP_RESERVE = POPOVER_TOP_RESERVE;
const BOTTOM_RESERVE = POPOVER_BOTTOM_RESERVE;

// This shell's own root. Declared up here because crowExclusion() reads it.
let el = $state<HTMLDivElement | null>(null);

// The crow / basemap tile floats over the map's top-RIGHT. The popover must treat
// it like a wall — never slide under it. We MEASURE its real rect at position time
// (robust to safe-area insets / --top-bar-h that hardcoded px would miss) and, if
// the popover's vertical span overlaps the tile's band, hold the popover's right
// edge to the tile's LEFT edge (minus a clearance). `el` is this shell's own root,
// so its offsetParent is the map container → rects share that coordinate space.
function crowExclusion(): { left: number; top: number; bottom: number } | null {
	if (typeof document === "undefined") return null;
	const crow = document.querySelector(".crow-slot") as HTMLElement | null;
	const host = el?.offsetParent as HTMLElement | null;
	if (!crow || !host) return null;
	const cr = crow.getBoundingClientRect();
	const hr = host.getBoundingClientRect();
	if (!cr.width) return null;
	return { left: cr.left - hr.left, top: cr.top - hr.top, bottom: cr.bottom - hr.top };
}

// NO ResizeObserver HERE — ON PURPOSE. Measuring the card's real height to
// decide the above/below flip looks obviously better than a constant, and it
// cost three failed attempts (2026-08-10): the measurement feeds the layout,
// and the layout feeds the measurement, so every version found a new edge of
// that cycle (height→max-height, then height→width via the crow test, then a
// Svelte $effect re-subscribing on its own write and rebuilding the observer).
// The symptom each time was "ResizeObserver loop completed with undelivered
// notifications" plus a pegged main thread.
//
// The flip works fine on the fixed estimate — that is what shipped before, and
// the only loss is slightly less precise placement for unusually tall cards.
// A guess that always terminates beats a measurement that sometimes doesn't.
// If you reintroduce measurement, the bar is: prove width, top, AND max-height
// are all independent of the measured value before writing any DOM.

// Placement math lives in ./mapPopoverGeom (pure + test-locked). The side is
// CHOSEN BY MEASUREMENT for points and polygons alike — see that file's header
// for why the old "pins always render below" shortcut was wrong.
const geom = $derived(
	placePopover({
		bbox,
		containerWidth,
		containerHeight,
		isPoint,
		wide,
		topReserve: TOP_RESERVE,
		bottomReserve: BOTTOM_RESERVE,
		crow: crowExclusion(),
	}),
);
const style = $derived(
	`left:${geom.left}px;top:${geom.top}px;width:${geom.width}px;max-height:${geom.maxH}px`,
);

// Dotted LEADER TRAIL — ties a point-pin to its popover so the pair reads as one
// thing (the popover can sit a fair drop below the pin, ABOVE it when there's no
// room below, or slide sideways to dodge the crow tile). Runs to whichever edge
// of the card faces the pin.
const leader = $derived(isPoint ? leaderLine(bbox, geom) : null);

// --- Gesture pass-through ----------------------------------------------------
// This NO LONGER passes pan/pinch through to the map: MapDrawControls freezes
// the camera (dragPan / scrollZoom / touchZoomRotate / doubleClickZoom) for as
// long as a popover is open, so there is nothing on the far side to reach. The
// old wheel branch was deleted with that change rather than left layered on top.
//
// What remains serves TAP-OUTSIDE-TO-DISMISS: a gesture is owned by WHERE IT
// BEGINS, so one starting outside the popover makes the surface transparent to
// pointer events for the rest of that gesture and the tap lands on the map.
// (`el` is declared at the top — crowExclusion() needs it too.)

$effect(() => {
	if (!el) return;
	const node = el;

	let passthrough = false;
	const pointers = new Set<number>();

	function setPassthrough(on: boolean) {
		if (passthrough === on) return;
		passthrough = on;
		node.style.pointerEvents = on ? "none" : "";
	}

	function onPointerDown(e: PointerEvent) {
		const inside = node.contains(e.target as Node);
		if (pointers.size === 0) setPassthrough(!inside);
		else if (!inside) setPassthrough(true);
		pointers.add(e.pointerId);
	}
	function onPointerEnd(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size === 0) setPassthrough(false);
	}

	window.addEventListener("pointerdown", onPointerDown, true);
	window.addEventListener("pointerup", onPointerEnd, true);
	window.addEventListener("pointercancel", onPointerEnd, true);
	return () => {
		window.removeEventListener("pointerdown", onPointerDown, true);
		window.removeEventListener("pointerup", onPointerEnd, true);
		window.removeEventListener("pointercancel", onPointerEnd, true);
	};
});
</script>

{#if leader}
	<!-- The dotted trail lives OUTSIDE the popover surface (same offsetParent = the
	     map container) so it never scrolls with the content and never eats taps. -->
	<svg
		class="rt-fmp-leader"
		width={containerWidth}
		height={containerHeight}
		viewBox="0 0 {containerWidth} {containerHeight}"
		aria-hidden="true"
	>
		<line x1={leader.x0} y1={leader.y0} x2={leader.x1} y2={leader.y1} />
	</svg>
{/if}
<div class="rt-fmp rt-popover-surface" class:rt-fmp--locked={scrollLocked} {style} bind:this={el}>
	{@render children()}
</div>

<style>
	@keyframes rt-fmp-in {
		from { opacity: 0; transform: scale(0.92); }
		to   { opacity: 1; transform: scale(1); }
	}

	/* Pin → popover dotted trail. Same gold as the popover's border so the pin,
	   trail, and card read as one connected unit. Round-cap dash with a wide gap
	   renders as DOTS, not dashes. NO bigger anchor dot at the pin end — an
	   oversized head dot read as another map pin (user, 2026-07-17); every dot
	   in the trail stays the same size. */
	.rt-fmp-leader {
		position: absolute;
		inset: 0;
		z-index: 17; /* just under the popover surface (18) */
		pointer-events: none;
		animation: rt-fmp-in 0.15s ease-out;
	}
	.rt-fmp-leader line {
		stroke: var(--rt-yellow, #ffd700);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-dasharray: 0.1 7;
		opacity: 0.85;
	}

	/* Positioning + scroll + animation only — the glass/gold-border/shadow now
	   come from the universal .rt-popover-surface convention (mobile.css). */
	.rt-fmp {
		position: absolute;
		/* Above the map but BELOW the mob drawer (zIndex 22). */
		z-index: 18;
		max-width: calc(100% - 16px);
		padding: 10px;
		animation: rt-fmp-in 0.15s ease-out;
		overflow-y: auto;
		/* Never scroll sideways — the deck fits the surface width; a sideways
		   scrollbar here is always a phantom from the overflow-x:visible default. */
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
	}
	/* Edit-spotlight: freeze the surface scroll so the focused row can't slide out
	   from under the scrim. */
	.rt-fmp--locked {
		/* Lock BOTH axes. Setting only overflow-y:hidden makes the browser promote
		   overflow-x from visible→auto (the "visible + non-visible" CSS rule), which
		   spawns a phantom sideways scrollbar. */
		overflow: hidden;
	}
	.rt-fmp::-webkit-scrollbar {
		width: 8px;
	}
	.rt-fmp::-webkit-scrollbar-track {
		margin: var(--rt-radius-sm) 0;
	}
	.rt-fmp::-webkit-scrollbar-thumb {
		background: var(--rt-border-active);
		border-radius: 4px;
	}

	/* The description box expands on focus (FeatureDetail) — stop clipping so
	   the full text floats over the map. */
	.rt-fmp:has(:global(.rt-fd__desc:focus)) {
		overflow: visible;
	}
</style>
