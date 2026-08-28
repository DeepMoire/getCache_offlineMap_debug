<script lang="ts">
import "../shared/devCard.css";
/**
 * OfflineBlobPanel — what the device actually holds, per area.
 *
 * The work meter answers "is it working right now"; this answers "what is on
 * disk". Together they are the offline debugger. ReTreever has a much larger
 * inspector (BlobInspector.svelte, ~3,600 lines: geocoding, corner/reach
 * measurement, cross-DB sweeps, .retreever export); this is the portable core
 * of it — the coverage registry, grouped and sized — with no host dependencies
 * at all beyond the places port.
 *
 * ⚠️ INDEXEDDB IS PARTITIONED PER ORIGIN. This reads whatever the CURRENT origin
 * has baked. On a fresh rapper dev server that is legitimately nothing until the
 * engine runs a pass — an empty table here means "this origin has no blobs",
 * never "the blobs were lost". The same confusion cost an hour on the admin
 * host once, so the empty state says so out loud rather than showing 0 B.
 */
import { onMount } from "svelte";
import {
	allCoverage,
	OFFLINE_BUDGET_BYTES,
	type CoverageRecord,
} from "../onPhone/store/coverageRegistry";
import { subscribeOfflineBake } from "../onPhone/bake/bakeService.svelte";
import { wipeOfflineDataAndReload } from "../onPhone/store/wipe";
import type { HostPlace } from "../shared/hostPorts";

interface Props {
	/** The host's places, for naming areas. Same list the bake service gets. */
	places?: HostPlace[];
	/** Map an anchor to its areaKey — the engine's own satImageKey. */
	areaKeyOf?: (c: [number, number]) => string;
	/**
	 * Fired whenever the focused row's name changes — the newest-touched area,
	 * same row `rows[0]` renders as FOCUSED below. debugReport.ts already scopes
	 * its `latest` field to this same newest-first row, so this is just naming
	 * what export already exports, for the export button's sub-label.
	 */
	onFocusedName?: (name: string | null) => void;
}
let { places = [], areaKeyOf, onFocusedName }: Props = $props();

let rows = $state<CoverageRecord[]>([]);
let loading = $state(true);
let baking = $state(false);
let pending = $state(0);

const totalBytes = $derived(rows.reduce((n, r) => n + (r.bytes || 0), 0));

/**
 * THE LIST, per Chris 28 Aug 2026: "the last successful import is hoisted.
 * the rest are descending last touched, even empty pins endure there."
 *
 * So the list is PINS, not blobs: every place the host has, whether or not
 * a blob ever arrived for it. A pin with nothing on disk stays in the list
 * with empty chips — that row IS the reading "never arrived", which a
 * blobs-only list could not show (the pin was simply absent, and absent
 * looks like "fine"). Coverage rows no place owns any more (the fixture
 * home centre, an evicted pin's leftovers) are kept too, so bytes on disk
 * are never hidden.
 */
interface Entry {
	areaKey: string;
	name: string;
	lng: number;
	lat: number;
	/** Place touch, or the record's own touch when no place owns it. */
	lastTouched: number;
	groupName?: string;
	cov?: CoverageRecord;
}
const entries = $derived.by((): Entry[] => {
	const byKey = new Map(rows.map((r) => [r.areaKey, r]));
	const out: Entry[] = [];
	const seen = new Set<string>();
	if (areaKeyOf) {
		for (const p of places) {
			const a = p.anchors[0];
			if (!a) continue;
			const key = areaKeyOf(a);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				areaKey: key,
				name: p.featureName ?? key,
				lng: a[0],
				lat: a[1],
				lastTouched: Date.parse(p.lastTouched) || 0,
				groupName: p.groupName,
				cov: byKey.get(key),
			});
		}
	}
	for (const r of rows) {
		if (seen.has(r.areaKey)) continue;
		out.push({
			areaKey: r.areaKey,
			name: r.areaKey,
			lng: r.lng,
			lat: r.lat,
			lastTouched: r.lastTouched ?? 0,
			cov: r,
		});
	}
	return out;
});
/** Hoisted: the newest SUCCESSFUL import — bytes landed, by bakedAt. */
const focused = $derived.by((): Entry | undefined => {
	let best: Entry | undefined;
	for (const e of entries) {
		const c = e.cov;
		if (!c || !(c.hasPhoto || c.hasLines)) continue;
		const t = c.bakedAt ?? c.lastTouched ?? 0;
		const bt = best?.cov ? (best.cov.bakedAt ?? best.cov.lastTouched ?? 0) : -1;
		if (t > bt) best = e;
	}
	return best;
});
/** Everything else, newest touched first — empty pins included. */
const rest = $derived(
	entries
		.filter((e) => e !== focused)
		.sort((a, b) => b.lastTouched - a.lastTouched),
);

function kb(n: number): string {
	if (!n) return "—";
	return n < 1024 * 1024
		? `${(n / 1024).toFixed(0)} KB`
		: `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A ticking NOW, so the "3m ago" labels below age by themselves.
 *
 * This is a clock, NOT a poll: it touches no storage. The table itself still
 * refreshes only on an engine generation bump (see onMount) — re-reading
 * IndexedDB every second to re-render a string that changes once a minute is
 * exactly the 1 GB heap sink the byte-split above was added to kill. The
 * interval is the cheapest thing that can be correct: without it a row baked
 * "2s ago" keeps claiming 2s an hour later, which is worse than no timestamp
 * because it reads as fresh.
 *
 * 10s, not 1s: the coarsest tick that still lets the seconds bucket look live.
 */
let now = $state(Date.now());
onMount(() => {
	const id = setInterval(() => (now = Date.now()), 10_000);
	return () => clearInterval(id);
});

/**
 * Epoch ms -> "just now" / "45s ago" / "12m ago" / "3h ago" / "2d ago".
 *
 * Deliberately one unit, never "1h 3m": this sits in a dense read-out row
 * where the QUESTION is "is this stale?", and a single coarse figure answers
 * it at a glance. `ago` reads off `now` above, so every returned string is
 * re-derived whenever the clock ticks.
 */
function ago(ts: number | undefined, at: number): string {
	if (!ts) return "—";
	const secs = Math.floor((at - ts) / 1000);
	// Clock skew (or a record written a tick into the future) must not render
	// as a negative age; "just now" is the honest reading of "not yet past".
	if (secs < 5) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.floor(hrs / 24)}d ago`;
}

/** Absolute time for the `title` tooltip — the relative label is for scanning,
 *  this is for when you actually need to correlate against a log. */
function stamp(ts: number | undefined): string {
	return ts ? new Date(ts).toLocaleString() : "unknown";
}

async function refresh(): Promise<void> {
	try {
		// Newest first — the pin you just dropped is the one you are debugging.
		rows = (await allCoverage()).sort(
			(a, b) => (b.lastTouched ?? 0) - (a.lastTouched ?? 0),
		);
	} catch {
		// codestyle-allow-swallow: no IndexedDB (SSR, private mode) is an
		// ordinary state — the empty table below already says the right thing.
		rows = [];
	}
	loading = false;
	onFocusedName?.(focused?.name ?? null);
}

onMount(() => {
	void refresh();
	// Re-read on every generation bump: that is the engine saying the disk
	// changed (an area downloaded or was evicted), which is exactly and only
	// when this table is stale. Polling would re-open the DB for nothing.
	return subscribeOfflineBake((s) => {
		baking = s.downloading;
		pending = s.pending;
		void refresh();
	});
});
</script>

<div class="panel dev-card">
	<div class="head dev-card__head">
		<span class="title dev-card__title">offline blobs</span>
		<span class="sum">
			{rows.length} area{rows.length === 1 ? "" : "s"} · {kb(totalBytes)}
			{#if OFFLINE_BUDGET_BYTES}
				<span class="dim">/ {kb(OFFLINE_BUDGET_BYTES)}</span>
			{/if}
		</span>
		<button class="wipe" onclick={() => void wipeOfflineDataAndReload()}>
			WIPE
		</button>
	</div>

	{#if baking}
		<!-- The bake takes 20-60 s for a cold area. Without this line, "still
		     downloading" and "broken" look identical — a black map either way. -->
		<div class="baking">
			baking… {pending} area{pending === 1 ? "" : "s"} to go
		</div>
	{/if}

	{#if loading}
		<div class="empty">reading IndexedDB…</div>
	{:else if !rows.length}
		<div class="empty">
			<strong>no blobs on this origin yet</strong>
			<div class="dim">
				IndexedDB is partitioned per origin. This is not "blobs lost" — the
				engine has not finished a pass here. Wait ~20 s after load.
			</div>
		</div>
	{:else}
		<div class="rows">
			{#snippet card(e: Entry, isFocused: boolean)}
				{@const c = e.cov}
				<div class="row" class:focused={isFocused} class:other={!isFocused} class:empty={!c}>
					{#if isFocused}
						<span class="focustag">● FOCUSED — LAST IMPORT · EXPORTS AS JSON</span>
					{/if}
					<!-- ONE line for the pin: coordinates once (they ARE the name),
					     the age, and the total. Then one line per LAYER, ledger style:
					     what · how much · size at the right edge — the same shape as the
					     blob inspector's in/out rows. -->
					<div class="row-top">
						<span class="pin">📍</span>
						<span class="name">{e.name}</span>
						<span
							class="when"
							title={c?.bakedAt
								? `imported ${stamp(c.bakedAt)} · touched ${stamp(e.lastTouched)}`
								: `touched ${stamp(e.lastTouched)}`}
						>
							🕒 {isFocused && c?.bakedAt ? ago(c.bakedAt, now) : ago(e.lastTouched, now)}
						</span>
						<span class="bytes">{c ? kb(c.bytes) : "no blob"}</span>
					</div>
					<div class="layers">
						<div class="layer" class:on={c?.hasPhoto}>
							<span class="dir">in</span>
							<span class="ico">🛰️</span>
							<span class="lname">satellite</span>
							<span class="ldetail">{c?.hasPhoto ? "image/webp" : "—"}</span>
							<span class="lbytes">{c?.hasPhoto ? kb(c.photoBytes ?? 0) : "—"}</span>
						</div>
						<!-- lineCount is dl.downloaded — TILES, not features. It read
						     "1 feat" while the tile held 2,394 roads (28 Aug 2026). -->
						<div class="layer" class:on={c?.hasLines}>
							<span class="dir">out</span>
							<span class="ico">🛣️</span>
							<span class="lname">roads</span>
							<span class="ldetail">{c?.hasLines ? `${c.lineCount ?? 0} tiles` : "—"}</span>
							<span class="lbytes">{c?.hasLines ? kb(c.lineBytes ?? 0) : "—"}</span>
						</div>
					</div>
				</div>
			{/snippet}
			{#if focused}
				{@render card(focused, true)}
			{/if}
			{#if rest.length > 0}
				{#each rest as e (e.areaKey)}
					{@render card(e, false)}
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	/* Shell (bg, border, radius, padding, type) comes from devCard.css — see
	   .dev-card. Only the rail-specific bits stay here. */
	.panel {
		overflow: hidden;
		/* Fills its dock (the right rail runs top-to-bottom); the list below
		   takes the slack and scrolls, so the head and the WIPE stay put. */
		display: flex;
		flex-direction: column;
		max-height: 100%;
	}
	/* Row layout from .dev-card__head; this card also wraps its summary. */
	.head {
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
	}
	/* Title look from .dev-card__title. */
	.sum {
		margin-left: auto;
		color: #8f8b80;
	}
	.dim {
		color: #8f8b80;
	}
	/* Deliberately ugly and red: it must never be mistaken for a normal action. */
	.wipe {
		border: 1px solid #e2553f;
		color: #e2553f;
		background: transparent;
		border-radius: 7px;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
		font:
			800 0.7rem "Inter",
			-apple-system,
			sans-serif;
		letter-spacing: 0.03em;
	}
	.baking {
		padding: 0.5rem 0.9rem;
		color: #eab627;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	}
	.empty {
		padding: 0.9rem;
		line-height: 1.5;
	}
	.rows {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}
	.row {
		padding: 0.6rem 0.9rem;
		border-top: 1px dashed rgba(255, 255, 255, 0.1);
	}
	.row:first-child {
		border-top: none;
	}
	/* FOCUSED — the only row export json actually exports. Gold border + tint
	   pulls it out of the list so scope is unambiguous before you tap export. */
	.row.focused {
		margin: 0.6rem 0.7rem;
		padding: 0.8rem 0.85rem;
		border: 1.5px solid #eab627;
		border-top: 1.5px solid #eab627;
		background: rgba(234, 182, 39, 0.06);
		border-radius: 10px;
	}
	.focustag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: "JetBrains Mono", ui-monospace, monospace;
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.08em;
		color: #221904;
		background: #eab627;
		padding: 2px 7px;
		border-radius: 5px;
		margin-bottom: 7px;
	}
	/* NOT exported — secondary at a glance, so the eye lands on FOCUSED first. */
	/* A pin with nothing on disk. Dimmer still — the row's job is to SAY
	   "never arrived", not to look like a blob. */
	.row.empty {
		opacity: 0.55;
	}
	.row.other {
		opacity: 0.55;
	}
	.row.other .name {
		font-weight: 600;
		font-size: 0.9em;
	}
	.row-top {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.2rem 0;
	}
	.pin { font-size: 0.9em; }
	.name {
		color: #eab627;
		font-weight: 700;
		font-size: 0.95em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Age sits beside the name in the header — one line, not a fourth row. */
	.when {
		color: #eab627;
		opacity: 0.85;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.bytes {
		margin-left: auto;
		color: #eab627;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	/* THE LEDGER — one line per layer, columns aligned down the card:
	   in/out · icon · name · detail · size-at-the-right. Alternate fills so
	   the eye can follow a line across, like the blob inspector's rows. */
	.layers {
		display: grid;
		grid-template-columns: 2.2em 1.4em 5.5em 1fr auto;
		align-items: baseline;
		margin-top: 0.15rem;
		border-radius: 6px;
		overflow: hidden;
	}
	.layer {
		display: contents;
		color: #8f8b80;
	}
	.layer > span {
		padding: 0.18rem 0.3rem;
		background: rgba(255, 255, 255, 0.03);
		white-space: nowrap;
	}
	.layer:nth-child(even) > span { background: rgba(255, 255, 255, 0.06); }
	.dir { color: #6fb3d9; font-weight: 700; text-align: right; }
	.ico { text-align: center; }
	.lname { color: #f3f1e9; }
	.ldetail { color: #8f8b80; overflow: hidden; text-overflow: ellipsis; }
	.lbytes { color: #eab627; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
	.layer.on .lname { color: #f3f1e9; }
	.layer:not(.on) > span { opacity: 0.5; }
</style>
