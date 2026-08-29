<script lang="ts">
import {
	GLYPH_PINS,
	RAINBOW_PINS,
	type PinKey,
	type PinRow,
} from "../shared/icons";
import type { Snippet } from "svelte";

let {
	selected = $bindable("pin"),
	onChange,
	label = "PIN LIBRARY",
	emojiSlot,
}: {
	selected?: string;
	/** Fires on every pick, including from inside the full library. */
	onChange?: (key: PinKey) => void;
	label?: string;
	emojiSlot?: Snippet;
} = $props();

const COLLAPSED_COUNT = 4;
const collapsedPins = GLYPH_PINS.slice(0, COLLAPSED_COUNT);

let libraryOpen = $state(false);

function pick(key: PinKey) {
	selected = key;
	onChange?.(key);
	libraryOpen = false;
}
</script>

{#snippet swatch(pt: PinRow)}
	<button
		type="button"
		class="rt-fd__swatch"
		class:rt-fd__swatch--active={pt.name === selected}
		role="radio"
		aria-checked={pt.name === selected}
		aria-label={pt.name}
		title={pt.name}
		onclick={() => pick(pt.name)}
	>
		<img src={pt.path} alt="" class="rt-fd__swatch-img" />
	</button>
{/snippet}

<div class="rt-fd__sect-label">{label}</div>
<div class="rt-fd__pins">
	{#each collapsedPins as pt (pt.name)}
		{@render swatch(pt)}
	{/each}
	<button
		type="button"
		class="rt-fd__swatch rt-fd__swatch--more"
		aria-label="Open pin library"
		title="More"
		onclick={() => (libraryOpen = true)}
	>
		<span class="rt-fd__more-label">More</span>
	</button>
</div>

{#if libraryOpen}
	<div class="rt-fd__lib" role="dialog" aria-label="Pin library" tabindex="-1">
		<div class="rt-fd__lib-hdr">
			<div class="rt-fd__sect-label">PIN LIBRARY</div>
			<button
				class="rt-popover-close"
				onclick={() => (libraryOpen = false)}
				aria-label="Close pin library">✕</button
			>
		</div>
		<div class="rt-fd__pins">
			{#each GLYPH_PINS as pt (pt.name)}
				{@render swatch(pt)}
			{/each}
			{@render emojiSlot?.()}
		</div>
		<div class="rt-fd__sect-label">RAINBOW</div>
		<div class="rt-fd__pins">
			{#each RAINBOW_PINS as pt (pt.name)}
				{@render swatch(pt)}
			{/each}
		</div>
	</div>
{/if}

<style>
/* var() fallbacks matter — rapper may be mounted somewhere app.css is absent. */
.rt-fd__sect-label {
	color: var(--color-accent-terracotta, var(--rt-fg-dim, #c4713f));
	font-size: 0.7rem;
	font-weight: 800;
	letter-spacing: 0.08em;
	margin-top: var(--rt-space-1, 4px);
}

.rt-fd__pins {
	display: flex;
	flex-wrap: wrap;
	gap: 3px;
	padding: 4px 0;
}

.rt-fd__swatch {
	flex: 0 0 calc((100% - 15px) / 5);
	max-width: calc((100% - 15px) / 5);
	height: 48px;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	background: rgba(255, 255, 255, 0.04);
	border: 1px solid var(--rt-border-subtle, #3a3428);
	border-radius: 8px;
	padding: 3px 2px 0;
	cursor: pointer;
	-webkit-tap-highlight-color: transparent;
	color: var(--rt-fg-muted, #b8b8b8);
	font-size: 1.4rem;
	font-weight: 600;
}
.rt-fd__swatch:active {
	background: var(--rt-yellow-soft, #ffd24a22);
}
.rt-fd__swatch--active {
	border-color: var(--rt-yellow, #ffd24a);
	background: var(--rt-yellow-tint, #ffd24a1a);
}
.rt-fd__swatch-img {
	width: 100%;
	max-width: 40px;
	height: auto;
	object-fit: contain;
	display: block;
}
.rt-fd__swatch--more {
	align-items: center;
	padding: 0;
	border-style: dashed;
}
.rt-fd__more-label {
	font-size: 0.9rem;
	font-weight: 800;
	letter-spacing: 0.04em;
	color: var(--rt-yellow, #ffd24a);
}

.rt-fd__lib {
	margin-top: 6px;
	padding: 6px 8px 8px;
	background: var(--rt-surface, #12100cf2);
	border: 1px solid var(--rt-yellow, #ffd24a);
	border-radius: 12px;
}
.rt-fd__lib-hdr {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}
/* Ghost grey, never red — dismissal is not destruction. */
.rt-popover-close {
	background: none;
	border: 1px solid var(--rt-border-subtle, #3a3428);
	border-radius: 8px;
	color: var(--rt-fg-dim, #8f8a76);
	font: inherit;
	line-height: 1;
	padding: 3px 7px;
	cursor: pointer;
}
</style>
