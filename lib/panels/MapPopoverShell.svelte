<!-- MapPopoverShell — floating popover over the map; owns positioning + gesture pass-through only, content is deferred to children. Shared by FeatureMapPopover and PlotMapPopover. -->
<script lang="ts" module>
// ⚠️ Top/bottom reserve so the popover never tucks under the top bar or tab bar — MapDrawControls' ensure-room pan uses these SAME numbers, so don't let them diverge.
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
	/** Wide variant — near-full container width instead of the compact 260px cap, for popovers hosting the full plot-row deck. */
	wide?: boolean;
	/** Freezes the surface's own scroll — ⚠️ must stay frozen during edit-spotlight or the focused row slides out from under the scrim. */
	scrollLocked?: boolean;
	children: Snippet;
} = $props();

const TOP_RESERVE = POPOVER_TOP_RESERVE;
const BOTTOM_RESERVE = POPOVER_BOTTOM_RESERVE;

// This shell's own root. Declared up here because crowExclusion() reads it.
let el = $state<HTMLDivElement | null>(null);

// ⚠️ Popover must never slide under the crow/basemap tile — measure its real rect (robust to safe-area insets) rather than hardcoding px.
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

// ⚠️ NO ResizeObserver here — measuring height to flip above/below causes an infinite feedback loop (tried 3x); if you reintroduce it, prove width/top/max-height are independent of the measured value first.

// Placement math lives in ./mapPopoverGeom (pure + test-locked); side is CHOSEN BY MEASUREMENT for points and polygons alike.
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

// Dotted leader trail ties a point-pin to its popover; runs to whichever edge of the card faces the pin.
const leader = $derived(isPoint ? leaderLine(bbox, geom) : null);

// Tap-outside-to-dismiss: a gesture is owned by where it begins — one starting outside the popover makes the surface pointer-transparent for that gesture so the tap lands on the map.

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
	<!-- Dotted trail lives OUTSIDE the popover surface (same offsetParent) so it never scrolls with content or eats taps. -->
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

	/* Pin→popover dotted trail, same gold as border. ⚠️ No bigger anchor dot at the pin end — reads as another map pin; keep every dot the same size. */
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

	/* Positioning + scroll + animation only — glass/border/shadow come from .rt-popover-surface (mobile.css). */
	.rt-fmp {
		position: absolute;
		/* Above the map but BELOW the mob drawer (zIndex 22). */
		z-index: 18;
		max-width: calc(100% - 16px);
		padding: 10px;
		animation: rt-fmp-in 0.15s ease-out;
		overflow-y: auto;
		/* Never scroll sideways — deck fits the surface width; a sideways scrollbar here is always a phantom from overflow-x:visible default. */
		overflow-x: hidden;
		-webkit-overflow-scrolling: touch;
	}
	/* Edit-spotlight: freeze the surface scroll so the focused row can't slide out from under the scrim. */
	.rt-fmp--locked {
		/* Lock BOTH axes — overflow-y:hidden alone promotes overflow-x from visible→auto (CSS spec rule) and spawns a phantom sideways scrollbar. */
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

	/* Description box expands on focus (FeatureDetail) — stop clipping so full text floats over the map. */
	.rt-fmp:has(:global(.rt-fd__desc:focus)) {
		overflow: visible;
	}
</style>
