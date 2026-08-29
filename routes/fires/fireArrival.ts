/**
 * Which READERS still owe a bypassed fetch for the current arrival.
 *
 * ⚠️ owing is a per-reader Set, not a single boolean — a shared flag let the bake service's 20s tick eat the map's refresh before ensure() ran, so the map never updated. Each reader (`refreshFires` for anchors, `ensure()` for the camera) owes separately; overlapping discs are deduped downstream by `unionHotspots` anyway.
 */
const owing = new Set<string>();

/** the two fetch paths — named so a typo can't silently invent a third, unarmed reader */
export type FireReader = "bake" | "map";
const READERS: readonly FireReader[] = ["bake", "map"];

export function noteFireArrival(): void {
	for (const r of READERS) owing.add(r);
}

/** consume, not merely read — a skipped pass must not leave the debt standing, or every 20s tick refetches forever (same as no TTL). */
export function takeFireArrival(reader: FireReader): boolean {
	return owing.delete(reader);
}

/** ⚠️ peek, don't consume, here — ensure() has THREE racing call sites; consuming on first read let the debt look paid with nothing actually fetched (6h-old data in the field). Only settleFireArrival clears it, after a fetch is attempted. */
export function peekFireArrival(reader: FireReader): boolean {
	return owing.has(reader);
}

/** Consume the debt — call ONLY once a fetch has actually been attempted. */
export function settleFireArrival(reader: FireReader): void {
	owing.delete(reader);
}

/** Test seam — reset between cases so one test's arrival can't leak. */
export function resetFireArrival(): void {
	owing.clear();
}
