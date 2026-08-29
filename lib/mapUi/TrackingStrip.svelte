<script lang="ts">
import type { MapHostPorts } from "../shared/mapHostPorts";

let {
    ports,
    active,
    onStop,
}: {
    ports: MapHostPorts;
    active: boolean;
    onStop: () => void;
} = $props();
</script>

{#if active}
    <button class="tracking-strip" onclick={onStop} title="Stop tracking">
        <ports.ui.Icon name="close" size={22} />
        <span class="tracking-strip__label">TRACKING</span>
        <ports.ui.MaskedIcon src="/mobileAssets/tracks_goldV3.webp" size={30} color="var(--color-accent)" />
    </button>
{/if}

<style>
    .tracking-strip {
        position: absolute;
        left: 12px;
        top: calc(var(--top-bar-h, 2rem) + 18px + 51px + 12px);
        z-index: 55;
        height: 51px;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 3px 4px;
        background: rgba(18, 18, 18, 0.28);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid color-mix(in srgb, var(--color-accent), transparent 60%);
        border-radius: 12px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        color: var(--color-accent);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }
    .tracking-strip :global(svg) {
        margin-left: 8px;
    }
    .tracking-strip__label {
        font-size: 0.82rem;
        letter-spacing: 0.1em;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
        line-height: 1;
        /* Deliberately not disabled under prefers-reduced-motion — the pulse must never quietly stop announcing "recording". */
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
