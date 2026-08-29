<!-- SelfCoordPill — gold "you are here" GPS readout above the blue dot, with a share button (text/gps copy/.getcache/.kmz). -->
<script lang="ts">
import type { Map as MapboxMap } from "mapbox-gl";
// Icon and SharePicker render as ports.ui.*; ShareFormat is the contract's MapShareRow (SharePicker's row shape).
import type { MapHostPorts, MapShareRow as ShareFormat } from "../shared/mapHostPorts";

type Props = {
    /** The host's door — Icon + SharePicker come through here. */
    ports: MapHostPorts;
    /** The map handle — used to project lng/lat → screen pixels. */
    map: MapboxMap | null;
    /** The coordinate to show, or null to hide the pill entirely. */
    coord: { lng: number; lat: number } | null;
    /** Share/copy rows for the pill's share button, built by the host — keeps the pill presentational (no file building, no clipboard here). */
    formats: ShareFormat[];
    /** Dismiss — no ✕ on the chip; the map itself is the dismiss surface (tap anywhere). */
    onClose?: () => void;
};

let { ports, map, coord, formats, onClose }: Props = $props();

// Screen position of the coordinate, recomputed as the camera moves.
let pos = $state<{ x: number; y: number } | null>(null);

function computePos(): void {
    if (!map || !coord) {
        pos = null;
        return;
    }
    // NaN defence: a degenerate camera transform can make project() return non-finite pixels, silently vanishing the pill at translate(NaN,NaN).
    const p = map.project([coord.lng, coord.lat]);
    pos = Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

// Re-projects on every camera move so the pill rides the dot; a map tap dismisses it (no ✕ on the chip).
$effect(() => {
    if (!map || !coord) {
        pos = null;
        return;
    }
    computePos();
    const onMove = () => computePos();
    const onMapClick = () => onClose?.();
    map.on("move", onMove);
    map.on("click", onMapClick);
    return () => {
        map?.off("move", onMove);
        map?.off("click", onMapClick);
    };
});

// 3 dp ≈ 110 m — plenty to read aloud, keeps the pill narrow. SHARE rows carry full precision (host-built), same split as the snake ruler.
const readout = $derived(
    coord ? `${coord.lat.toFixed(3)}°, ${coord.lng.toFixed(3)}°` : "",
);
</script>

{#if coord && pos}
    <!-- Uses the shared .rt-line-label.rt-line-label-total globals (styles/mobile.css) — deliberately not restyled here, so it never drifts from the ruler's chip. -->
    <div
        class="rt-line-label rt-line-label-total rt-selfcoord"
        style="--x:{pos.x}px; --y:{pos.y}px"
        role="status"
        aria-live="polite"
    >
        {readout}

        <ports.ui.SharePicker {formats} side="above">
            {#snippet trigger({ toggle })}
                <button
                    class="rt-selfcoord__btn"
                    onclick={toggle}
                    aria-label="Share your GPS location"
                    title="Share your GPS location"
                >
                    <ports.ui.Icon name="share" size={16} />
                </button>
            {/snippet}
        </ports.ui.SharePicker>
    </div>
{/if}

<style>
/* POSITIONING ONLY — do not re-declare the shared visual properties here; edit mobile.css's .rt-line-label.rt-line-label-total instead. Base class sets pointer-events:none; re-enabled here for the button. */
.rt-selfcoord {
    position: absolute;
    left: 0;
    top: 0;
    /* -50% centres on the dot; the lift clears the dot's own ring. */
    transform: translate(calc(var(--x) - 50%), calc(var(--y) - 34px));
    display: inline-flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
    z-index: 5;
}

/* Deliberately taller than the pill (28px vs the 14px chip) so the share button isn't missed as a speck — negative block margins let it overflow without stretching the pill. */
.rt-selfcoord__btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    /* Break out of the 14px line, top and bottom, without growing the pill. */
    margin: -7px -6px -7px 1px;
    border: 2px solid var(--rt-bg, #1a1a1a);
    border-radius: 50%;
    background: var(--rt-yellow, #ffd700);
    box-shadow: 0 2px 5px rgb(0 0 0 / 35%);
    color: inherit;
    cursor: pointer;
    flex: 0 0 auto;
}
.rt-selfcoord__btn:active {
    transform: scale(0.92);
}
</style>
