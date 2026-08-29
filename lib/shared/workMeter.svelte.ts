import { SvelteMap } from "svelte/reactivity";

export interface WorkStat {
	/** Label shown in the panel. */
	name: string;
	/** Completed runs since page load. */
	runs: number;
	/** ms of the most recent completed run. */
	lastMs: number;
	/** ms of the slowest run seen. */
	maxMs: number;
	/** Total ms spent in this operation since load — the "power bill". */
	totalMs: number;
	/** Wall-clock start of the in-flight run, or null when idle. */
	startedAt: number | null;
	/** Set by the caller when a fresh run was requested mid-flight. */
	queued: boolean;
	/** Runs that ended by throwing. */
	errors: number;
	/** Times the operation was TRIGGERED but returned at the door without doing anything (breaker latched, already running, nothing to do). */
	skips: number;
	/** Why the last skip happened, for the panel to show verbatim. */
	lastSkip: string;
}

/** A payload handed across a boundary (setData to Mapbox worker, postMessage, cache write) — separate from WorkStat: this tracks bytes×frequency, not time. */
export interface PayloadStat {
	/** Label shown in the panel — the source id. */
	name: string;
	/** Times a payload was handed over since page load. */
	sends: number;
	/** KB of the most recent payload. */
	lastKb: number;
	/** KB of the largest payload seen. */
	maxKb: number;
	/** Total KB pushed across the boundary since load — the re-parse bill. */
	totalKb: number;
	/** Features in the most recent payload, or -1 when not a FeatureCollection. */
	lastFeatures: number;
}

// ⛔ NOT `$state(new Map())`. Svelte 5 proxies arrays and plain objects only —
// a Map wrapped in $state is the SAME plain Map, so `stats.set()` in slot()
// was invisible to every `$derived(workStats())`. MEASURED, 28 Aug 2026, on
// the rapper tier: the meter mounts before the 20 s boot bake, `rows` was
// computed once as `[]` and never again, so it said "no bake pass has run yet"
// under a bake that had run three times. And inside a row the `{#if
// r.startedAt !== null}` never re-checked while `now - r.startedAt` did, so a
// finished run read `▶ 1787956047.3s` — `now - null`, the epoch.
//
// Two layers, both needed: the SvelteMap versions the KEY set (a new slot
// re-runs `workStats()`), and each slot is a `$state` proxy so its counters
// (`runs`, `startedAt`, `queued`…) are fine-grained reactive in the panel.
const stats = new SvelteMap<string, WorkStat>();
const payloads = new SvelteMap<string, PayloadStat>();

/** CIRCUITS: idle=nothing asked (grey), transit=request out (yellow), ok=bytes on disk (STILL yellow — not on screen), drawn=features seen in the viewport (green), err=request broke (red). */
/** ⛔ Probe reachability alone must never light green — only a real data call does; probes are used only to grey out / offer retry. */
/** ⛔ `ok` is the DOWNLOAD boundary, not the paint boundary. Only paintWatch.ts (on map idle, counting rendered features) can turn a row green — a circuit writer never says "drawn". */
/** Keys: worker:<tier> tile Worker per tier, sat satellite bake, pack roads/labels/places/hosp, fires hotspots — layers sharing a download share its circuit (see LayerToggle.feed in wallLegend.ts). */
export type CircuitState = "idle" | "transit" | "ok" | "drawn" | "err";
export interface CircuitStat {
	key: string;
	/** Download-side state only — never `drawn`; see light(). */
	state: Exclude<CircuitState, "drawn">;
	/** Epoch ms of the last change. */
	at: number;
	/** What arrived, or why it broke — the call's own words. */
	note: string;
	/** Epoch ms the request went out (null = never asked since reset). */
	askedAt: number | null;
	/** Epoch ms the bytes landed on disk (null = not yet / broke). */
	arrivedAt: number | null;
}

/** What the map ACTUALLY PAINTED for one layer row, counted on the last idle — the only witness that can turn a row green. */
export interface PaintStat {
	key: string;
	/** Rendered features (or mounted photos) of this layer inside the viewport. */
	count: number;
	/** Epoch ms of the idle that counted them. */
	at: number;
	/** Epoch ms of the first idle that saw count > 0 AFTER the feed's current arrivedAt — the "drawn" moment. Reset when a newer arrival lands. */
	drawnAt: number | null;
}

// SvelteMap, not $state(new Map()) — Svelte 5 doesn't proxy Map, so writes below REPLACE the entry rather than mutate in place.
const circuits = new SvelteMap<string, CircuitStat>();
const paints = new SvelteMap<string, PaintStat>();
const probes = new SvelteMap<string, boolean>();
const circuitListeners = new Set<(c: CircuitStat) => void>();

/** Yellow (transit) is held at least TRANSIT_HOLD_MS — a settle landing inside the hold is DEFERRED until it's up; the latest settle wins. */
const TRANSIT_HOLD_MS = 1000;
const transitSince = new Map<string, number>();
const pendingSettle = new Map<string, ReturnType<typeof setTimeout>>();

/** focusArea: set on pin-drop tap, cleared by resetCircuits() — while set, notes tagged with a different area are ignored (prevents a background reconcile pin overwriting the one just dropped); untagged notes (fires, probes) always land. */
let focusArea: string | null = null;
export function focusCircuits(areaKey: string | null): void {
	focusArea = areaKey;
}
export function circuitFocus(): string | null {
	return focusArea;
}
export function noteCircuit(
	key: string,
	state: Exclude<CircuitState, "drawn">,
	note = "",
	areaKey?: string,
): void {
	if (focusArea && areaKey && areaKey !== focusArea) return;
	const write = () => {
		const prev = circuits.get(key);
		const now = Date.now();
		const next: CircuitStat = {
			key,
			state,
			at: now,
			note,
			askedAt: state === "transit" ? now : (prev?.askedAt ?? null),
			// A new ask forgets the old arrival, or the row could stay green on last time's bytes.
			arrivedAt: state === "ok" ? now : state === "transit" ? null : (prev?.arrivedAt ?? null),
		};
		circuits.set(key, next);
		for (const fn of circuitListeners) fn(next);
	};
	const pend = pendingSettle.get(key);
	if (pend) {
		clearTimeout(pend);
		pendingSettle.delete(key);
	}
	if (state === "transit") {
		// A new ask while a settle was pending: the settle is moot; restart the hold only if we weren't already yellow.
		if (circuits.get(key)?.state !== "transit") {
			transitSince.set(key, Date.now());
			write();
		}
		return;
	}
	const since = transitSince.get(key);
	const left = since === undefined ? 0 : TRANSIT_HOLD_MS - (Date.now() - since);
	if (left > 0) {
		pendingSettle.set(
			key,
			setTimeout(() => {
				pendingSettle.delete(key);
				transitSince.delete(key);
				write();
			}, left),
		);
		return;
	}
	transitSince.delete(key);
	write();
}
/** Called on every circuit write — paintWatch uses it to force a repaint when bytes land, so an already-idle map still gets re-counted. */
export function subscribeCircuits(fn: (c: CircuitStat) => void): () => void {
	circuitListeners.add(fn);
	return () => circuitListeners.delete(fn);
}
/** One circuit, or undefined = never called (render grey). */
export function circuitOf(key: string): CircuitStat | undefined {
	return circuits.get(key);
}
/** Every circuit that has ever been called, insertion order. */
export function allCircuits(): CircuitStat[] {
	return [...circuits.values()];
}

/** Record what the map painted for one layer row on this idle. `drawnAt` latches on the first non-zero count and is dropped when the feed's arrival is newer than it — light() does the "after arrival" comparison against whichever circuit is asking. */
export function notePaint(layerKey: string, feedKey: string | undefined, count: number): void {
	const now = Date.now();
	const prev = paints.get(layerKey);
	const arrivedAt = feedKey ? (circuits.get(feedKey)?.arrivedAt ?? null) : null;
	const stillValid =
		prev?.drawnAt != null && (arrivedAt == null || prev.drawnAt >= arrivedAt);
	const drawnAt = stillValid ? prev!.drawnAt : count > 0 ? now : null;
	paints.set(layerKey, { key: layerKey, count, at: now, drawnAt });
}
export function paintOf(layerKey: string): PaintStat | undefined {
	return paints.get(layerKey);
}
export function allPaints(): PaintStat[] {
	return [...paints.values()];
}

export interface Light {
	state: CircuitState;
	circuit?: CircuitStat;
	/** The paint that earned `drawn`, when state is drawn. */
	paint?: PaintStat;
	/** ms from ask to bytes on disk. */
	transitMs: number | null;
	/** ms from bytes on disk to first sighting in the viewport — the gap this whole model exists to expose. */
	paintLagMs: number | null;
}
/** THE COLOUR OF A ROW. The feed's download state, promoted to `drawn` (green) ONLY when at least one of `layerKeys` was painted after the feed's current arrival. `ok` stays yellow: bytes on disk are not pixels on screen. */
export function light(circuitKey: string | undefined, layerKeys: readonly string[]): Light {
	const circuit = circuitKey ? circuits.get(circuitKey) : undefined;
	if (!circuit) return { state: "idle", transitMs: null, paintLagMs: null };
	const transitMs =
		circuit.askedAt != null && circuit.arrivedAt != null ? circuit.arrivedAt - circuit.askedAt : null;
	if (circuit.state !== "ok") return { state: circuit.state, circuit, transitMs, paintLagMs: null };
	let paint: PaintStat | undefined;
	for (const k of layerKeys) {
		const p = paints.get(k);
		if (p?.drawnAt != null && circuit.arrivedAt != null && p.drawnAt >= circuit.arrivedAt && (!paint || p.drawnAt < paint.drawnAt!)) paint = p;
	}
	if (!paint) return { state: "ok", circuit, transitMs, paintLagMs: null };
	return { state: "drawn", circuit, paint, transitMs, paintLagMs: paint.drawnAt! - circuit.arrivedAt! };
}

/** Back to grey — called the moment a pin is dropped, so circles describe THIS ask, not the last one; a drop that triggers nothing stays grey ("not even asking"). */
export function resetCircuits(areaKey: string | null = null): void {
	focusArea = areaKey;
	for (const t of pendingSettle.values()) clearTimeout(t);
	pendingSettle.clear();
	transitSince.clear();
	circuits.clear();
	paints.clear();
}

/** Probe result per tier — reachability for greying/retry ONLY. */
export function noteProbe(tier: string, ok: boolean): void {
	probes.set(tier, ok);
}
/** undefined = not probed yet. */
export function probeOf(tier: string): boolean | undefined {
	return probes.get(tier);
}

/** The whole panel as one plain object, for pasting into a chat — window.__meter() (dev console) and the panel's "copy JSON" button both hand out exactly this. */
export function meterSnapshot() {
	return {
		at: new Date().toISOString(),
		work: workStats().map((s) => ({ ...s })),
		payloads: payloadStats().map((p) => ({ ...p })),
		focus: focusArea,
		circuits: allCircuits().map((c) => ({
			...c,
			askedAtIso: c.askedAt == null ? null : new Date(c.askedAt).toISOString(),
			arrivedAtIso: c.arrivedAt == null ? null : new Date(c.arrivedAt).toISOString(),
			transitMs: c.askedAt != null && c.arrivedAt != null ? c.arrivedAt - c.askedAt : null,
		})),
		paints: allPaints().map((p) => ({
			...p,
			atIso: new Date(p.at).toISOString(),
			drawnAtIso: p.drawnAt == null ? null : new Date(p.drawnAt).toISOString(),
		})),
		probes: Object.fromEntries(probes),
	};
}

if (import.meta.env.DEV && typeof window !== "undefined") {
	(window as unknown as { __meter: () => unknown }).__meter = meterSnapshot;
}

/** Every tracked payload, stable order (insertion). Read in the panel. */
export function payloadStats(): PayloadStat[] {
	return [...payloads.values()];
}

/** Record a payload handed across a boundary — takes an already-serialised string when available; do NOT re-stringify an object just to measure it, that reintroduces the allocation the strings-not-object-graphs rewrite deleted. Objects report 0 KB (features only). */
export function notePayload(name: string, data: unknown): void {
	let s = payloads.get(name);
	if (!s) {
		const fresh: PayloadStat = $state({
			name,
			sends: 0,
			lastKb: 0,
			maxKb: 0,
			totalKb: 0,
			lastFeatures: -1,
		});
		payloads.set(name, fresh);
		s = fresh;
	}
	const kb =
		typeof data === "string" ? Math.round(data.length / 1024) : 0;
	const feats =
		data && typeof data === "object" && Array.isArray((data as { features?: unknown[] }).features)
			? ((data as { features: unknown[] }).features.length)
			: -1;
	s.sends++;
	s.lastKb = kb;
	s.totalKb += kb;
	if (kb > s.maxKb) s.maxKb = kb;
	s.lastFeatures = feats;
}

function slot(name: string): WorkStat {
	const have = stats.get(name);
	if (have) return have;
	const fresh: WorkStat = $state({
		name,
		runs: 0,
		lastMs: 0,
		maxMs: 0,
		totalMs: 0,
		startedAt: null,
		queued: false,
		errors: 0,
		skips: 0,
		lastSkip: "",
	});
	stats.set(name, fresh);
	return fresh;
}

/** Every tracked operation, stable order (insertion). Read in the panel. */
export function workStats(): WorkStat[] {
	return [...stats.values()];
}

/** Mark that a run was ASKED FOR while one was already in flight — a queued that stays permanently true means the op can't keep up with its trigger rate. */
export function noteQueued(name: string, queued = true): void {
	slot(name).queued = queued;
}

/** Record that a trigger fired but declined to run, and why — call at EVERY early return or the panel can't tell "idle" from "refusing". */
export function noteSkip(name: string, why: string): void {
	const s = slot(name);
	s.skips++;
	s.lastSkip = why;
}

/** Time one run of fn — returns whatever fn returns; a throw is recorded and re-thrown, so wrapping never changes behaviour. */
export async function track<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const s = slot(name);
	// Nested/overlapping runs share the slot; the LAST start wins for the "running for Ns" read-out.
	s.startedAt = Date.now();
	const t0 = performance.now();
	try {
		return await fn();
	} catch (err) {
		s.errors++;
		throw err;
	} finally {
		const ms = performance.now() - t0;
		s.runs++;
		s.lastMs = ms;
		if (ms > s.maxMs) s.maxMs = ms;
		s.totalMs += ms;
		s.startedAt = null;
	}
}

/** Manual bracket for code that can't wrap in a callback (own try/finally) — call at the start, call the returned fn in finally; same accounting as track(). */
export function beginWork(name: string): (failed?: boolean) => void {
	const s = slot(name);
	s.startedAt = Date.now();
	const t0 = performance.now();
	let closed = false;
	return (failed = false) => {
		if (closed) return; // double-call must not double-count
		closed = true;
		const ms = performance.now() - t0;
		s.runs++;
		s.lastMs = ms;
		if (ms > s.maxMs) s.maxMs = ms;
		s.totalMs += ms;
		if (failed) s.errors++;
		s.startedAt = null;
	};
}

/** Zero the counters (the panel's Reset) — the in-flight run is untouched. */
export function resetWorkStats(): void {
	for (const s of stats.values()) {
		s.runs = 0;
		s.lastMs = 0;
		s.maxMs = 0;
		s.totalMs = 0;
		s.errors = 0;
		s.skips = 0;
		s.lastSkip = "";
	}
	// Payloads reset too — a Reset that zeroed only half the panel would describe two different time windows.
	for (const p of payloads.values()) {
		p.sends = 0;
		p.lastKb = 0;
		p.maxKb = 0;
		p.totalKb = 0;
		p.lastFeatures = -1;
	}
	// Circuits go back to grey so the NEXT call is what you watch; probes stay — they're a fact about the network, not a counter.
	circuits.clear();
	paints.clear();
}
