/** ⚠️ Never use this file to hide an error — failures always log unconditionally; only routine per-mount diagnostics are gated by topic. */

/** Topics that opt into chatty logging — keep names short, typed by hand into localStorage. */
export type VerboseTopic =
	| "plots"
	| "storage"
	| "quality704"
	| "mapDemo"
	| "fire"
	/** Snapshot upload / restore-gate chatter — SUCCESS only; failures always go through console.warn/error directly. */
	| "sync"
	/** Map bring-up: hospital markers, layer wiring. */
	| "map"
	/** Animation placement chatter (hand-placement, off-stage grow) — SUCCESS only; every ❌ in Player.svelte stays a bare console.error/warn. */
	| "anim"
	/** Import progress: per-chunk KML/KMZ/PDF write timings. */
	| "import"
	/** Offline wall map: per-burst tile-read counts, per-area download lines — OFF by default (high-frequency, repeats the same answer). */
	| "wall";

function enabledTopics(): Set<string> {
	try {
		if (typeof localStorage === "undefined") return new Set();
		const raw = localStorage.getItem("rtVerbose");
		if (!raw) return new Set();
		return new Set(
			raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		);
	} catch {
		// codestyle-allow-swallow: storage blocked (private mode/iframe) just means "not opted in", the default anyway.
		return new Set();
	}
}

/** Is chatty logging on for this topic? */
export function isVerbose(topic: VerboseTopic): boolean {
	const t = enabledTopics();
	return t.has("*") || t.has(topic);
}

/** Log a routine diagnostic (only when its topic is opted in) — NOT for errors/warnings; use console.warn/error directly for those. */
export function vlog(topic: VerboseTopic, ...args: unknown[]): void {
	if (isVerbose(topic)) console.log(`[${topic}]`, ...args);
}
