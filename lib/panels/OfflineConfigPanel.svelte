<script lang="ts">
/**
 * CONFIG — Workers and layers. The right-hand rail of the offline-map
 * debugger.
 *
 * WHAT BELONGS HERE: switches that change what the map TALKS TO or DRAWS.
 * Nothing else. The pin picker is not config — it is part of the map's own
 * library (see PinLibrary.svelte).
 *
 * DEV-ONLY BY CONSTRUCTION: the worker override lives behind
 * `import.meta.env.DEV` in tilesHost.ts — a compile-time constant — so a
 * shipped build drops the branch entirely and cannot be switched. That is why
 * this panel is safe to publish at a public URL: it renders, it reads, and it
 * points at production with no way to move it.
 */
import { onMount } from "svelte";
import {
	getWorkerTarget,
	LOCAL_DEV_HOST,
	probeTarget,
	setWorkerTarget,
	type WorkerTarget,
} from "../r2Worker/local_dev/tilesHost";

let {
	layers = [],
}: {
	/** Layer switches, independent of each other — the point is to turn things
	 *  off one at a time and watch the heap. `disabled` renders the row greyed
	 *  out and unclickable — for a layer that exists in the list but isn't
	 *  safe to flip yet (see the online map's Fires row, held behind a
	 *  compile-time bisect until fires v2 ships). */
	layers?: {
		key: string;
		label: string;
		on: boolean;
		toggle: () => void;
		disabled?: boolean;
		disabledHint?: string;
	}[];
} = $props();

// ── WORKER TARGET ───────────────────────────────────────────────────────
// THREE tiers — r2_prod and r2_dev in the cloud, local_dev on the developer's
// own machine. See the WorkerTarget block in tilesHost.ts for what each is.
//
// local_dev was removed earlier on 27 Aug ("delete the local one, it's too
// much work" — a row that only works while a terminal is open is usually dead,
// and a dead switch reads as a broken app) and RESTORED the same day, because
// removing it removed the only target an outside contributor can reach.
// r2_prod and r2_dev both live on Chris's Cloudflare account; the key for them
// is in Bitwarden and is never shared. A contributor runs `wrangler dev
// --remote` against THEIR OWN free account and THEIR OWN bucket, which is what
// local_dev points at. Without this row there is no way to test a Worker change
// without Chris deploying it for you — which is not a contribution loop.
//
// The "dead switch reads as broken" worry is answered by the hint text and the
// greyed-out state, not by hiding the row: absent looks like impossible,
// greyed-out looks like not-running-yet, and only one of those is true.
//
// This list is the ONLY place a row is declared — probing, greying-out and
// the fallback all read from it, so adding a tier is one entry, not four.
//
// Changing the target re-points the NEXT request; in-flight ones finish
// where they started.
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
		// Interpolated, never retyped. A hand-copied hostname in a hint is a
		// fourth spelling waiting to happen — this row said "127.0.0.1:8787"
		// for a day after the constant had moved on.
		hint: `${LOCAL_DEV_HOST} — \`npm run dev:local\` in workers/offline-tiles. THE ONLY TARGET A CONTRIBUTOR CAN REACH: that script seeds wrangler's local R2 with a public sample archive, so it needs no Cloudflare account and no key. Greyed out until that terminal is running, which is expected, not broken.`,
	},
];

// undefined = not probed yet (shown neutral, still clickable — a slow probe
// must never make a working Worker look dead).
let reachable = $state<Partial<Record<WorkerTarget, boolean>>>({});

/** A tier currently being re-probed, so its row can say so. */
let retrying = $state<WorkerTarget | null>(null);

async function pickTarget(t: WorkerTarget) {
	// A DEAD ROW RE-PROBES INSTEAD OF DOING NOTHING.
	//
	// ⛔ THE ROW USED TO BE `disabled`, WHICH IS WHY YOU COULD LEAVE A TIER AND
	// NOT GET BACK. MEASURED 27 Aug 2026, Chris: "I went from production to
	// local but I couldn't get back on to production again." Every reachable[]
	// flag is set by ONE probe at mount. The tiles-prod DNS record was minutes
	// old and its negative cache had not expired, so that single probe failed
	// and the row was `disabled` from then on — the click that would have
	// re-tested it could not fire, because a disabled button has no click.
	//
	// A transient network result was being stored as permanent state. The
	// deploy fixed the Worker and the panel had no way to notice. Now a click
	// on a dead row means "try again": we re-probe THAT tier and select it if
	// it answers. Refusing a dead target is still right — silently switching to
	// a Worker that isn't there gives a map that never fills and no error
	// [[no-silent-fallbacks]] — but refusing must not be permanent.
	if (reachable[t] === false) {
		retrying = t;
		const alive = await probeTarget(t);
		reachable[t] = alive;
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
		reachable[t.id] = await probeTarget(t.id);
	}
	// If the CURRENT target turned out to be gone, move to ANY tier that is
	// actually answering rather than sit there pointed at nothing.
	//
	// ⛔ THIS USED TO READ `reachable.production !== false`, WHICH MADE THE
	// FALLBACK IMPOSSIBLE IN THE ONE CASE IT EXISTED FOR. production is the
	// default target, so the branch only runs when production is the dead one —
	// and then the guard is false and nothing happens. MEASURED 27 Aug 2026:
	// production NXDOMAIN, r2Dev unconfigured, localDev not running, so all
	// three rows disabled themselves and the panel showed r2_prod lit green AND
	// greyed out simultaneously. Selected-and-unreachable is a state the user
	// cannot leave: every row refuses the click that would fix it.
	//
	// Try the others in preference order instead. If NOTHING answers we stay
	// put and say so — the greying is then honest, and the log names the
	// hostname so "no blobs" is one glance from being explained.
	if (reachable[target] === false) {
		const alive = (["production", "r2Dev", "localDev"] as WorkerTarget[]).find(
			(t) => reachable[t] === true,
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
	// Unlike the ⚙ this panel is always visible, so probe on mount rather than
	// on open.
	void probeAll();
});
</script>

<div class="config">
	<div class="config-title">CONFIG</div>

	<div class="cfg-title">Workers</div>
	{#each TARGETS as t (t.id)}
		<button
			class="cfg-row"
			class:sel={target === t.id}
			class:dead={reachable[t.id] === false}
			class:retrying={retrying === t.id}
			onclick={() => pickTarget(t.id)}
			title={reachable[t.id] === false
				? `${t.label} is not answering — CLICK TO RETRY. ${t.id === "localDev" ? "Start it with `npm run dev:local` in workers/offline-tiles — no account needed." : "The Worker was unreachable when last checked."}`
				: t.hint}
		>
			<span class="cfg-label">{t.label}</span>
			{#if retrying === t.id}
				<span class="dead-tag">checking…</span>
			{:else if reachable[t.id] === false}
				<span class="dead-tag">retry</span>
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
				{#if l.disabled}
					<span class="dead-tag">not yet</span>
				{/if}
				<span class="sw" class:sw-on={l.on}></span>
			</button>
		{/each}
		<div class="cfg-note dim">any combination · heap updates each second</div>
	{/if}
</div>

<style>
.config {
	font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	background: #12100cd9;
	border: 1px solid #3a3428;
	border-radius: 10px;
	padding: 0.6rem 0.7rem;
}
.config-title {
	color: #e8b84b;
	font-size: 1.6rem;
	letter-spacing: 0.04em;
	text-align: center;
	margin-bottom: 0.8rem;
}
.cfg-title {
	color: #ffd24a;
	letter-spacing: 0.08em;
	margin-bottom: 4px;
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
	/* Grows to fill the row so every .sw switch lands on the SAME right edge
	   regardless of label length ("Fires" vs "Roads/water") — that drift is
	   what reads as "toggles not lined up". */
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cfg-row.sel {
	/* GOLD, not off-white. At #e8e8e8 the selected row sat one shade off the
	   unselected ones and the whole group read as greyed-out/disabled — the
	   switch looked broken when it was working. The colour has to carry the
	   state as loudly as the pill does. */
	color: #ffd24a;
	font-weight: 600;
}
.cfg-row.dead {
	/* Dimmed but CLICKABLE — the click is the retry. `cursor: not-allowed`
	   here told the user the row was a dead end, which is what it used to be. */
	opacity: 0.55;
	cursor: pointer;
}
.cfg-row.retrying {
	opacity: 0.8;
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
