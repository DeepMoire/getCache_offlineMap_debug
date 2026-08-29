<script lang="ts">
import "../shared/devCard.css";
/** OfflineBlobPanel — what's actually on disk, per area, alongside the work meter's "is it working now". ⚠️ IndexedDB is partitioned per origin — an empty table here means this origin has no blobs, not that they were lost. */
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
	/** Fired when the focused row's name changes (rows[0], the newest-touched area) — mirrors debugReport.ts's `latest` field for the export button's sub-label. */
	onFocusedName?: (name: string | null) => void;
}
let { places = [], areaKeyOf, onFocusedName }: Props = $props();

let rows = $state<CoverageRecord[]>([]);
let loading = $state(true);
let baking = $state(false);
let pending = $state(0);

const totalBytes = $derived(rows.reduce((n, r) => n + (r.bytes || 0), 0));

/** The list holds pins, not blobs — every host place appears whether or not a blob arrived (empty-chip rows ARE the "never arrived" signal), and orphaned coverage rows with no owning place are kept too. */
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

/** Ticking clock only (NOT a poll — touches no storage); re-reading IndexedDB every second here is the 1 GB heap sink this was built to avoid. 10s tick is the coarsest that still looks live. */
let now = $state(Date.now());
onMount(() => {
	const id = setInterval(() => (now = Date.now()), 10_000);
	return () => clearInterval(id);
});

/** Epoch ms → "just now" / "45s ago" / "12m ago" / "3h ago" / "2d ago" — deliberately one unit, never "1h 3m". */
function ago(ts: number | undefined, at: number): string {
	if (!ts) return "—";
	const secs = Math.floor((at - ts) / 1000);
	// Clock skew (or a future-written record) must not render as a negative age — "just now" covers "not yet past".
	if (secs < 5) return "just now";
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.floor(hrs / 24)}d ago`;
}

/** Absolute time for the `title` tooltip — relative label is for scanning, this is for correlating against a log. */
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
		// codestyle-allow-swallow: no IndexedDB (SSR, private mode) is ordinary — the empty table below already says so.
		rows = [];
	}
	loading = false;
	onFocusedName?.(focused?.name ?? null);
}

onMount(() => {
	void refresh();
	// Re-read on every generation bump — that's the engine saying the disk changed, and the only time this table is stale. Polling would reopen the DB for nothing.
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
		<!-- Bake takes 20-60s for a cold area — without this line, "still downloading" and "broken" look identical. -->
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
					<!-- One line for the pin (name/age/total), then one line per layer, ledger style — same shape as the blob inspector's in/out rows. -->
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
						<!-- ⚠️ lineCount is dl.downloaded — TILES, not features; showing "feat" here undercounts badly (was "1 feat" for 2,394 roads). -->
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
	/* Shell (bg, border, radius, padding, type) comes from devCard.css (.dev-card); only rail-specific bits stay here. */
	.panel {
		overflow: hidden;
		/* Fills its dock (right rail, top-to-bottom); the list takes the slack and scrolls so the head and WIPE stay put. */
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
	/* FOCUSED — the only row export json exports; gold border + tint makes scope unambiguous before you tap export. */
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
	/* A pin with nothing on disk — dimmer still, the row's job is to SAY "never arrived", not to look like a blob. */
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
	/* THE LEDGER — one line per layer, columns aligned (in/out · icon · name · detail · size); alternate fills so the eye can follow a row across. */
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
