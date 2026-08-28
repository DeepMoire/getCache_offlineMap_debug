<!--
  TrackingStrip.svelte — the map's standing "tracking is ON" control.

  Sits 12px below the draw strip's slot, in the draw strip's EXACT chrome
  (same translucent glass, accent border, radius, shadow). Present the whole
  time a tracking session runs — no blinking. The entire strip is ONE button:
  ✕ on the left, TRACKING label, track glyph on the right; tapping it stops
  the session (which toasts "Track saved — N points" as usual).

  Presentational only — the host (MapDrawControls) passes `active` from the
  tracking singleton and owns the stop.
-->
<script lang="ts">
import Icon from "$lib/core/icon/Icon.svelte";
import MaskedIcon from "$lib/mobile/components/ui/MaskedIcon.svelte";

let {
    active,
    onStop,
}: {
    active: boolean;
    onStop: () => void;
} = $props();
</script>

{#if active}
    <button class="tracking-strip" onclick={onStop} title="Stop tracking">
        <Icon name="close" size={22} />
        <span class="tracking-strip__label">TRACKING</span>
        <MaskedIcon src="/mobileAssets/tracks_goldV3.webp" size={30} color="var(--color-accent)" />
    </button>
{/if}

<style>
    /* The draw strip's chrome, verbatim (DrawPalette.svelte .draw-strip) —
       one slot lower: draw strip top + its ~45px height + 12px gap. */
    .tracking-strip {
        position: absolute;
        left: 12px;
        top: calc(var(--top-bar-h, 2rem) + 18px + 51px + 12px);
        z-index: 55;
        /* Same HEIGHT as the draw strip — 51px, measured on-device (its 3px
           padding + borders + a strip-btn's icon + label + button padding). */
        height: 51px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 3px 4px;
        background: rgba(18, 18, 18, 0.28); /* translucent — see the map through it */
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid color-mix(in srgb, var(--color-accent), transparent 60%);
        border-radius: 12px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        color: var(--color-accent);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }
    /* Match the strip buttons' inner feel: the ✕ leads, label in the strip's
       letterform, glyph trails — scaled up to fill the full-height bar. */
    .tracking-strip :global(svg) {
        margin-left: 8px;
    }
    .tracking-strip__label {
        font-size: 0.82rem;
        letter-spacing: 0.1em;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
        line-height: 1;
        /* The alarm pulse: the word FADES fully out over 1s and back over 1s,
           continuously. Only the word — the bar, ✕, and glyph hold steady so
           the tap target never disappears. Deliberately NOT disabled under
           prefers-reduced-motion: an opacity fade has no movement/parallax
           (same precedent as the TrackingIndicator pill), and "you are being
           recorded" must never quietly stop announcing itself. */
        animation: tracking-label-pulse 2s ease-in-out infinite;
    }
    @keyframes tracking-label-pulse {
        0%   { opacity: 1; }
        50%  { opacity: 0; }
        100% { opacity: 1; }
    }
    .tracking-strip :global(.masked-icon),
    .tracking-strip :global(img) {
        margin-right: 8px;
    }
    .tracking-strip:active {
        transform: scale(0.97);
    }
</style>
