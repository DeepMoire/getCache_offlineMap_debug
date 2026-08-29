<!-- Placement: EphemeralCard forces its direct children position:static, so the outer span must stay static and only the inner one is position:absolute, relative to the card (position:fixed). -->
<script lang="ts">
import { onMount } from "svelte";

type Status = "green" | "red" | "yellow";
interface Offender { rel: string; line: number; abs: string; text: string }
interface Child { repo: string; status: Status; offenders: Offender[]; note?: string; ms: number }

let children = $state<Child[]>([]);
let busy = $state(false);
let note = $state("");
let open = $state<string | null>(null);

const worst = $derived<Status>(
	busy || children.length === 0
		? "yellow"
		: children.some((c) => c.status === "red")
			? "red"
			: children.some((c) => c.status === "yellow")
				? "yellow"
				: "green",
);

async function run() {
	busy = true;
	note = "";
	try {
		const r = await fetch("/api/parentGuard");
		if (!r.ok) {
			note = r.status === 404 ? "no /api/parentGuard here" : `HTTP ${r.status}`;
			children = [];
			return;
		}
		children = (await r.json()).children;
	} catch (e) {
		note = String(e);
		children = [];
	} finally {
		busy = false;
	}
}

onMount(run);
</script>

<span class="mount">
	<span class="light" class:open={open !== null}>
		<button
			type="button"
			class="head"
			title={busy ? "running noParentNames.test.ts…" : note || "click to re-run"}
			onclick={run}
		>
			<span class="name">noParentNames.test.ts</span>
			<span class="dot {worst}" class:busy></span>
		</button>
		{#if children.length}
			<span class="dots">
				{#each children as c (c.repo)}
					<button
						type="button"
						class="child"
						title="{c.repo}: {c.status}{c.note ? ` — ${c.note}` : ''} ({c.ms} ms)"
						onclick={() => (open = open === c.repo ? null : c.repo)}
					>
						<span class="dot small {c.status}"></span>
					</button>
				{/each}
			</span>
		{/if}
		{#if open}
			{@const c = children.find((x) => x.repo === open)}
			{#if c}
				<div class="detail">
					<div class="repo">{c.repo} — {c.status}{c.note ? `: ${c.note}` : ""}</div>
					{#each c.offenders as o (o.abs + o.line)}
						<a href="zed://file{o.abs}:{o.line}" title={o.abs}>{o.rel}:{o.line}</a>
						<code>{o.text}</code>
					{/each}
					{#if c.status === "green"}<div class="ok">names no parent</div>{/if}
				</div>
			{/if}
		{/if}
	</span>
</span>

<style>
.mount { display: contents; }
.light {
	position: absolute;
	top: 8px;
	right: 10px;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 3px;
	font-size: 0.62rem;
	line-height: 1;
	z-index: 1;
}
.head {
	all: unset;
	cursor: pointer;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 3px;
	color: #c97b52;
	font-family: ui-monospace, monospace;
}
.name { white-space: nowrap; }
.dot {
	width: 14px;
	height: 14px;
	border-radius: 50%;
	border: 3px solid #333;
	box-sizing: border-box;
}
.dot.small { width: 9px; height: 9px; border-width: 2px; }
.dot.green { border-color: #3ddc4e; }
.dot.red { border-color: #ff3b30; }
.dot.yellow { border-color: #e8b923; }
.dot.busy { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.dots { display: flex; gap: 3px; }
.child { all: unset; cursor: pointer; display: inline-flex; }
.detail {
	position: absolute;
	top: 100%;
	right: 0;
	margin-top: 4px;
	min-width: 220px;
	max-width: 60vw;
	padding: 6px 8px;
	background: #111;
	border: 1px solid #444;
	border-radius: 4px;
	color: #ddd;
	font-family: ui-monospace, monospace;
	display: grid;
	gap: 3px;
	white-space: nowrap;
	overflow: auto;
}
.repo { color: #e8b923; font-weight: 700; }
.detail a { color: #7fc3ff; }
.detail code { color: #ff8a80; font-size: 0.6rem; }
.ok { color: #3ddc4e; }
</style>
