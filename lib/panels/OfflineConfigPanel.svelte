<script lang="ts">
import "$parent/retreeved/sharedComponents/effemeralCard/devCard.css";
/** CONFIG — the right-hand rail's Workers/layers switches (only things that change what the map talks to or draws; the pin picker is not config, see PinLibrary.svelte). ⚠️ DEV-ONLY BY CONSTRUCTION — the worker override lives behind `import.meta.env.DEV` in tilesHost.ts (compile-time), so a shipped build cannot switch it; that's what makes this panel safe to publish at a public URL. */
import { onMount } from "svelte";
import {
	getWorkerTarget,
	LOCAL_DEV_HOST,
	probeTarget,
	setWorkerTarget,
	type WorkerTarget,
} from "../r2Worker/local_dev/tilesHost";
import {
	circuitOf,
	allCircuits,
	probeOf,
	type CircuitState,
} from "../shared/workMeter.svelte";
import { LAYER_TOGGLES } from "../onPhone/render/wallLegend";

let {
	layers = [],
}: {
	/** Layer switches, independent of each other, to turn things off one at a time and watch the heap. `disabled` greys a row out for one that exists but isn't safe to flip yet. */
	layers?: {
		key: string;
		label: string;
		on: boolean;
		toggle: () => void;
		/** HOW the layer draws ("always on" / "pyramid" / "cluster"), shown greyed beside the label — the mechanism you compare when a feature is missing. See LayerToggle.hint. */
		hint?: string;
		disabled?: boolean;
		disabledHint?: string;
	}[];
} = $props();

// THREE tiers: r2_prod / r2_dev (cloud, Chris's Cloudflare account) and local_dev (developer's own machine) — see WorkerTarget in tilesHost.ts.
// ⚠️ Don't remove local_dev — it's the only tier an outside contributor can reach without the Bitwarden-only Cloudflare key (removed 27 Aug, restored same day).
// This list is the ONLY place a row is declared — probing, greying-out, and fallback all read from it; adding a tier is one entry.
// Changing the target re-points the NEXT request; in-flight ones finish where they started.
let target = $state<WorkerTarget>("production");

const TARGETS: {
	id: WorkerTarget;
	label: string;
	hint: string;
}[] = [
	{
		id: "production",
		label: "r2_prod",
		hint: "tiles-prod.getcache.org — what every shipped phone talks to. Deployed by ./deployProduction.sh, which asks for confirmation first.",
	},
	{
		id: "r2Dev",
		label: "r2_dev",
		hint: "tiles-dev.getcache.org — a DEPLOYED sandbox worker reading the same R2 data as r2_prod, so any difference between them is code, never data. No shipped phone ever reads it.",
	},
	{
		id: "localDev",
		label: "local_dev",
		// ⚠️ Interpolated, never retyped — a hardcoded hostname here drifts from the constant (this row said "127.0.0.1:8787" stale for a day).
		hint: `${LOCAL_DEV_HOST} — \`npm run dev:local\` in workers/offline-tiles. THE ONLY TARGET A CONTRIBUTOR CAN REACH: that script seeds wrangler's local R2 with a public sample archive, so it needs no Cloudflare account and no key. Greyed out until that terminal is running, which is expected, not broken.`,
	},
];

// Reachability lives in the work meter (probeTarget() in workMeter.svelte.ts), not here — this panel only reads it. Before the first probe a tier is undefined (neutral, still clickable): a slow probe must never look like a dead Worker.
function reach(t: WorkerTarget): "ok" | "err" | "wait" {
	const p = probeOf(t);
	return p === undefined ? "wait" : p ? "ok" : "err";
}

// THE CIRCLE — current state of that row's last real call: grey=never asked · yellow=in transit · green=arrived · red=broke. Worker rows show it only while selected; layer rows show the download they draw from (LayerToggle.feed).
const circuits = $derived(allCircuits());
function circ(key: string | undefined): CircuitState {
	void circuits; // read so this re-runs when any circuit changes
	if (!key) return "idle";
	return circuitOf(key)?.state ?? "idle";
}
function circNote(key: string | undefined): string {
	void circuits;
	return key ? (circuitOf(key)?.note ?? "") : "";
}
const FEED_OF: Record<string, string | undefined> = Object.fromEntries(
	LAYER_TOGGLES.map((t) => [t.key, t.feed]),
);
const CIRC_WORDS: Record<CircuitState, string> = {
	idle: "nothing asked for yet",
	transit: "request out, nothing back yet",
	ok: "arrived",
	err: "broke",
};

/** A tier currently being re-probed, so its row can say so. */
let retrying = $state<WorkerTarget | null>(null);

async function pickTarget(t: WorkerTarget) {
	// ⛔ A dead row RE-PROBES on click, never `disabled` — a disabled row can trap you on a dead tier permanently (measured 27 Aug 2026: Chris got stuck off production after one stale probe). Refuse a dead target, but never permanently.
	if (reach(t) === "err") {
		retrying = t;
		const alive = await probeTarget(t);
		retrying = null;
		if (!alive) {
			console.warn(
				`[tiles] ${t} still not answering. Click again to retry.`,
			);
			return;
		}
		console.info(`[tiles] ${t} is back — switching to it.`);
	}
	setWorkerTarget(t);
	target = t;
}

async function probeAll() {
	for (const t of TARGETS) {
		await probeTarget(t.id);
	}
	// If the CURRENT target is gone, fall back to any tier that IS answering rather than sit pointed at nothing. ⛔ A guard of `reachable.production !== false` made this impossible in the one case it existed for (measured 27 Aug 2026: all three tiers down, selected-and-unreachable, no row's click could fix it) — try tiers in preference order instead, and if nothing answers, stay put and say so.
	if (reach(target) === "err") {
		const alive = (["production", "r2Dev", "localDev"] as WorkerTarget[]).find(
			(t) => reach(t) === "ok",
		);
		if (alive) {
			console.info(
				`[tiles] ${target} is unreachable — switching to ${alive}.`,
			);
			pickTarget(alive);
		} else {
			console.warn(
				"[tiles] NO worker is reachable — nothing will download. Tried: " +
					TARGETS.map((t) => t.id).join(", ") +
					". Check VITE_TILES_HOST resolves, or start a local worker on :8787.",
			);
		}
	}
}

onMount(() => {
	target = getWorkerTarget();
	// Unlike the ⚙, this panel is always visible, so probe on mount rather than on open.
	void probeAll();
});
</script>

<div class="config dev-card">
	<div class="dev-card__head"><span class="dev-card__title">CONFIG</span></div>

	<div class="cfg-title">Workers</div>
	{#each TARGETS as t (t.id)}
		<button
			class="cfg-row"
			class:sel={target === t.id}
			class:dead={reach(t.id) === "err"}
			class:retrying={retrying === t.id}
			onclick={() => pickTarget(t.id)}
			title={reach(t.id) === "err"
				? `${t.label} is not answering — CLICK TO RETRY. ${t.id === "localDev" ? "Start it with `npm run dev:local` in workers/offline-tiles — no account needed." : "The Worker was unreachable when last checked."}`
				: t.hint}
		>
			<span class="cfg-label">{t.label}</span>
			{#if retrying === t.id}
				<span class="dead-tag">checking…</span>
			{:else if reach(t.id) === "err"}
				<span class="dead-tag">retry</span>
			{/if}
			{#if target === t.id}
				{@const k = `worker:${t.id}`}
				<span
					class="circ {circ(k)}"
					title={`last pack request: ${CIRC_WORDS[circ(k)]}${circNote(k) ? " — " + circNote(k) : ""}`}
				></span>
			{:else}
				<span class="circ blank"></span>
			{/if}
			<span class="sw" class:sw-on={target === t.id}></span>
		</button>
	{/each}
	<div class="cfg-note">
		reads only — this picks where blobs come FROM. Deploying is still
		<code>./deployProduction.sh</code>, which asks for confirmation first.
	</div>

	{#if layers.length > 0}
		<div class="cfg-sep"></div>
		<div class="cfg-title">layers</div>
		{#each layers as l (l.key)}
			<button
				class="cfg-row"
				class:sel={l.on}
				class:dead={l.disabled}
				disabled={l.disabled}
				onclick={l.toggle}
				title={l.disabled
					? (l.disabledHint ?? `${l.label} is not switchable yet`)
					: `Toggle ${l.label} — watch the heap reading in MAP DEBUGGER`}
			>
				<span class="cfg-label">{l.label}</span>
				{#if l.hint}
					<span class="cfg-hint">{l.hint}</span>
				{/if}
				{#if l.disabled}
					<span class="dead-tag">not yet</span>
				{/if}
				{#if FEED_OF[l.key]}
					{@const k = FEED_OF[l.key]}
					<span
						class="circ {circ(k)}"
						title={`${k} download: ${CIRC_WORDS[circ(k)]}${circNote(k) ? " — " + circNote(k) : ""}`}
					></span>
				{:else}
					<span class="circ blank"></span>
				{/if}
				<span class="sw" class:sw-on={l.on}></span>
			</button>
		{/each}
		<div class="cfg-note dim">any combination · heap updates each second</div>
	{/if}
</div>

<style>
/* Shell + title come from devCard.css (.dev-card) — same look as MAP DEBUGGER and OFFLINE BLOBS. */
.cfg-title {
	/* Section head under the card title — same family, one step smaller/dimmer, caps so it reads as a label not a row. */
	font-family: "Inter", -apple-system, sans-serif;
	font-weight: 800;
	font-size: 11px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--muted);
	margin: 10px 0 6px;
}
.cfg-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 100%;
	background: none;
	border: 0;
	color: #b8b8b8;
	font: inherit;
	padding: 3px 0;
	cursor: pointer;
	text-align: left;
}
.cfg-label {
	/* Does NOT grow — a growing label would push the hint to the far right as a second column; .cfg-hint/.dead-tag take the slack so every .sw switch lands on the same right edge. */
	flex: 0 0 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cfg-row.sel {
	/* GOLD, not off-white — #e8e8e8 read as one shade off unselected rows, making the whole group look greyed-out/disabled while it was working. */
	color: #ffd24a;
	font-weight: 600;
}
.cfg-row.dead {
	/* Dimmed but CLICKABLE — the click is the retry; `cursor: not-allowed` here used to tell the user it was a dead end. */
	opacity: 0.55;
	cursor: pointer;
}
.cfg-row.retrying {
	opacity: 0.8;
}
/* THE MECHANISM HINT — grey, beside the label, reads as an annotation not a second label; inherits the row's dimming when dead. */
.cfg-hint {
	flex: 1 1 auto;
	min-width: 0;
	margin-left: 6px;
	color: #7d7a6e;
	font-size: 0.85em;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.cfg-row.sel .cfg-hint {
	/* Selected rows go gold; the hint must NOT follow — it is not state. */
	color: #7d7a6e;
}

.dead-tag {
	flex: 1 1 auto;
	min-width: 0;
	margin-left: auto;
	color: #8f8a76;
	font-size: 0.85em;
	text-align: right;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* THE CIRCLE — sits left of the switch; grey until asked, then the last call's state. Muted grey (not black) so "never asked" doesn't read as failure. */
.circ {
	flex: 0 0 auto;
	width: 10px;
	height: 10px;
	border-radius: 50%;
	/* Right-aligned beside the switch on every row — layer rows push it there via their hint; worker rows (no hint) let the circle take the slack itself. */
	margin-left: auto;
	margin-right: 8px;
	background: #4a4a4a;
	box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.circ.blank {
	background: transparent;
	box-shadow: none;
}
.circ.transit {
	background: #e0b428;
}
.circ.ok {
	background: #35c759;
}
.circ.err {
	background: #e0483e;
}
.cfg-sep {
	border-top: 1px solid #3a3a3a;
	margin: 7px 0 5px;
}
.cfg-note {
	color: #8f8a76;
	margin-top: 5px;
	line-height: 1.3;
}
.cfg-note.dim {
	opacity: 0.75;
}
.cfg-note code {
	font: inherit;
	color: #b8b8b8;
}
.sw {
	flex: 0 0 auto;
	width: 30px;
	height: 16px;
	border-radius: 999px;
	background: #4a4a4a;
	position: relative;
	transition: background 120ms ease;
}
.sw::after {
	content: "";
	position: absolute;
	top: 2px;
	left: 2px;
	width: 12px;
	height: 12px;
	border-radius: 50%;
	background: #fff;
	transition: transform 120ms ease;
}
.sw-on {
	background: #35c759;
}
.sw-on::after {
	transform: translateX(14px);
}
</style>
