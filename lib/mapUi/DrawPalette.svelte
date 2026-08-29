<!-- DrawPalette — the LINE/POLY/PIN tool strip; presentational only. Picking a tool arms the Snake Ruler (armKind), which then owns all geometry, the readout, and finishing. -->
<script lang="ts">
import type { MapHostPorts } from "../shared/mapHostPorts";

let {
    ports,
    editActive,
    activeTool,
    onMode,
    onUndo,
    onExit,
}: {
    ports: MapHostPorts;
    editActive: boolean;
    activeTool: "polygon" | "line" | "pin" | null;
    onMode: (mode: "draw_polygon" | "draw_line_string" | "draw_pin") => void;
    onUndo: () => void;
    onExit: () => void;
} = $props();
</script>

{#if editActive}
    <div class="draw-strip">
        <button
            class="strip-btn"
            class:strip-btn-active={activeTool === 'line'}
            onclick={() => onMode('draw_line_string')}
            title="Draw line"
        >
            <ports.ui.Icon name="share-nodes" size={20} />
            <span>LINE</span>
        </button>
        <button
            class="strip-btn strip-btn-poly"
            class:strip-btn-active-poly={activeTool === 'polygon'}
            onclick={() => onMode('draw_polygon')}
            title="Draw polygon"
        >
            <ports.ui.Icon name="pentagon" size={20} />
            <span>POLY</span>
        </button>
        <button
            class="strip-btn"
            class:strip-btn-active={activeTool === 'pin'}
            onclick={() => onMode('draw_pin')}
            title="Drop pin"
        >
            <ports.ui.Icon name="map-pin" size={20} />
            <span>PIN</span>
        </button>
        <button class="strip-btn" onclick={onUndo} title="Undo last point">
            <ports.ui.Icon name="undo" size={20} />
            <span>UNDO</span>
        </button>
        <button class="strip-btn strip-btn-exit" onclick={onExit} title="Exit draw mode">
            <ports.ui.Icon name="close" size={16} />
        </button>
    </div>
{/if}

<style>
    .draw-strip {
        position: absolute;
        left: 12px;
        top: calc(var(--top-bar-h, 2rem) + 18px);
        z-index: 55;
        display: flex;
        gap: 4px;
        padding: 3px 4px;
        background: rgba(18, 18, 18, 0.28); /* translucent — see the map through it */
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid color-mix(in srgb, var(--color-accent), transparent 60%);
        border-radius: 12px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    }

    .strip-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0;
        padding: 4px 10px 3px;
        background: transparent;
        border: none;
        color: var(--color-accent);
        font-size: 0.66rem;
        letter-spacing: 0.08em;
        text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
        border-radius: 8px;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        position: relative;
    }

    .strip-btn-active { background: color-mix(in srgb, var(--color-accent), transparent 85%); }
    .strip-btn-active::after {
        content: '';
        position: absolute;
        left: 25%; right: 25%;
        bottom: 0;
        height: 2px;
        background: var(--color-accent);
        border-radius: 2px;
    }

    .strip-btn-active-poly { background: color-mix(in srgb, var(--color-mode-indicator), transparent 82%); }
    .strip-btn-active-poly::after {
        content: '';
        position: absolute;
        left: 25%; right: 25%;
        bottom: 0;
        height: 2px;
        background: var(--color-mode-indicator);
        border-radius: 2px;
    }

    .strip-btn-exit {
        color: var(--rt-fg);
        padding: 4px 6px;
    }

    @container (min-width: 500px) {
        .draw-strip { gap: 6px; padding: 4px 6px; }
        .strip-btn { padding: 6px 14px 5px; font-size: 0.72rem; }
    }
</style>
