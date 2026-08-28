<!--
  SelfCoordPill — THE "you are here, and here's the number" readout.

  A small gold pill that sits just above the blue dot showing your GPS
  coordinate, with a share button that opens the SAME format menu the pin
  popover uses (text / gps copy / .getcache / .kmz). Readable by eye on the
  phone AND shareable five ways — that's the whole point of it.

  ONE ACTION, TWO DOORS. Both the LOCATE tile and the hospital popup's "Your
  GPS loc." button run the same host action (pan to self → show this pill).
  Before this existed, the hospital popup hand-rolled its OWN
  navigator.geolocation.getCurrentPosition inside mapInit.ts — a second,
  ungated location path that refetched a fix the app already had in
  userLocator.getUserCoord(), and on denial showed its own dead-end
  "Check Settings > Location" string instead of routing through THE LOCATION
  GATE. That block is deleted; this component replaces it.

  Positioning follows PlotLayer's pending-popover pattern: the coordinate is
  projected to screen pixels and RE-projected on every camera `move`, so the
  pill glides with the dot instead of detaching from it.
-->
<script lang="ts">
import type { Map as MapboxMap } from "mapbox-gl";
import Icon from "$lib/core/icon/Icon.svelte";
import SharePicker, {
    type ShareFormat,
} from "$lib/mobile/components/ui/SharePicker.svelte";

type Props = {
    /** The map handle — used to project lng/lat → screen pixels. */
    map: MapboxMap | null;
    /** The coordinate to show, or null to hide the pill entirely. */
    coord: { lng: number; lat: number } | null;
    /** Share/copy rows for the pill's share button, built by the host so the
     *  pill stays presentational (no file building, no clipboard, in here). */
    formats: ShareFormat[];
    /** Dismiss. There is no ✕ on the chip — it stays as clean as the ruler's
     *  readout — so the map itself is the dismiss surface: tap anywhere and
     *  the pill goes away. */
    onClose?: () => void;
};

let { map, coord, formats, onClose }: Props = $props();

// Screen position of the coordinate, recomputed as the camera moves.
let pos = $state<{ x: number; y: number } | null>(null);

function computePos(): void {
    if (!map || !coord) {
        pos = null;
        return;
    }
    // NaN defence at the Mapbox boundary: a degenerate camera transform makes
    // project() return non-finite pixels, which would place the pill at
    // translate(NaN,NaN) and vanish it silently.
    const p = map.project([coord.lng, coord.lat]);
    pos = Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

// Re-project on every camera move so the pill rides the dot. A tap on the map
// dismisses it (the chip carries no ✕ of its own).
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

// The eye-readable text. 3 dp is ~110 m — plenty to read aloud over a radio
// or a phone call, and it keeps the pill narrow. The SHARE rows carry full
// precision (the host builds those), same split as the snake ruler's
// readout-vs-copy.
const readout = $derived(
    coord ? `${coord.lat.toFixed(3)}°, ${coord.lng.toFixed(3)}°` : "",
);
</script>

{#if coord && pos}
    <!-- THE SAME PILL THE SNAKE RULER USES. `rt-line-label
         rt-line-label-total` are the shared globals in styles/mobile.css — the
         gold fill, the rounded 14px/800 face, the radius and shadow all come
         from there, NOT from this file. Deliberately not restyled: this is the
         app's established "here is a coordinate" chip, and a second look-alike
         would be one more thing to keep in sync. The share button is the only
         addition, sitting at the end. -->
    <div
        class="rt-line-label rt-line-label-total rt-selfcoord"
        style="--x:{pos.x}px; --y:{pos.y}px"
        role="status"
        aria-live="polite"
    >
        {readout}

        <SharePicker {formats} side="above">
            {#snippet trigger({ toggle })}
                <button
                    class="rt-selfcoord__btn"
                    onclick={toggle}
                    aria-label="Share your GPS location"
                    title="Share your GPS location"
                >
                    <Icon name="share" size={16} />
                </button>
            {/snippet}
        </SharePicker>
    </div>
{/if}

<style>
/* POSITIONING ONLY. Every visual property — gold fill, font, size, weight,
   radius, shadow, padding — is inherited from the global
   `.rt-line-label.rt-line-label-total` pair in styles/mobile.css, so this pill
   and the snake ruler's readout can never drift apart. Do not re-declare them
   here; change mobile.css if the chip's look should change everywhere.
   The base class sets pointer-events:none (it's a passive map label); we turn
   it back on because this one has a button in it. */
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

/* The one addition to the ruler chip: a share affordance at the end.
   DELIBERATELY TALLER THAN THE PILL. The coordinate chip is a short, skinny
   14px-line stick, so a button sized to fit inside it reads as a speck and gets
   missed. This one is 28px — bigger than the chip's own height — so it stands
   proud above and below the gold, with its own border making it unmistakably a
   BUTTON rather than part of the readout. Unorthodox on purpose: the overhang IS
   the affordance. Negative block margins let it overflow without stretching the
   pill (the chip keeps its own height; the button breaks out of it). */
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
