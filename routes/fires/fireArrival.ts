/**
 * fireArrival.ts — "the user just showed up, ask NASA again".
 *
 * ── Why this exists ──
 * A TTL answers one question: *has this data aged out on its own?* That is the
 * right question for a phone sitting in camp all afternoon, and `FIRE_TTL_MS`
 * (1 h, matching FIRMS' own refresh) answers it well.
 *
 * It is the WRONG question at the one moment freshness matters most. The
 * planter has driven out of the block, back into cell service, and opened the
 * app SPECIFICALLY to find out whether the fire has moved. A record fetched 59
 * minutes ago answers `fireIsFresh` with `true`, so both fetch paths skipped —
 * and handed them an hour-old answer without ever asking. Add the Worker's edge
 * cache on top and the number on screen could be several hours old with nothing
 * on the card admitting it.
 *
 * ── The three ARRIVAL moments ──
 * App open, the app/tab becoming visible again, and connectivity returning.
 * Each one is a person turning up and asking. Nothing else arms this — in
 * particular NOT the 20 s reconcile loop, which would convert an hourly fetch
 * into a permanent poll over a burning province (~180 KB a time).
 *
 * ── Why a module and not a flag on the bake service ──
 * Two independent fetch paths gate on the same TTL: `refreshFires` in the bake
 * service (which owns downloads for the offline map) and `ensure()` in
 * fireLayer.ts (the online map's own coverage check). A flag private to one of
 * them fixes one map and leaves the other serving stale dots — the exact
 * two-implementations disease WILDFIRE_LAYER.md exists to prevent. One token,
 * both readers.
 *
 * ── Consume-once, deliberately ──
 * `takeFireArrival()` clears the flag. A pass that fails or is skipped must not
 * leave it armed, or every subsequent 20 s tick re-fetches forever — a stuck
 * flag would be indistinguishable from having no TTL at all.
 */

/**
 * Which READERS still owe a bypassed fetch for the current arrival.
 *
 * ⚠️ NOT a single boolean, and this is the whole subtlety. The first version was
 * one flag consumed by whoever asked first — and in the browser the bake
 * service's 20 s tick reliably won the race and ate it before the map's
 * `ensure()` ever ran, so the covered disc under the user's eyes never
 * refreshed. The layer looked fixed and wasn't.
 *
 * The two readers refresh DIFFERENT GROUND:
 *
 *   • `refreshFires` (bake service) → discs around your ANCHORS — where your
 *     features are, which may be a province away from the camera
 *   • `ensure()` (fireLayer)        → the disc you are LOOKING AT right now
 *
 * So "one fetch per arrival" was the wrong model. It is **one fetch per path
 * per arrival**: each owes its own answer, and neither can discharge the
 * other's debt. Overlapping discs are deduped downstream by `unionHotspots`
 * anyway, so the cost of both firing is one extra request, not double data.
 */
const owing = new Set<string>();

/** The two fetch paths. Named so a typo can't silently invent a third reader
 *  that never gets armed. */
export type FireReader = "bake" | "map";
const READERS: readonly FireReader[] = ["bake", "map"];

/**
 * ARM — a person just turned up. Call from app open, visibility-return, and
 * `online`. Idempotent: arriving twice before a pass runs is still one refresh
 * per path, because a Set cannot hold the same reader twice.
 */
export function noteFireArrival(): void {
	for (const r of READERS) owing.add(r);
}

/**
 * CONSUME — true exactly once per reader per arrival. The caller that gets
 * `true` owes a fetch that bypasses the TTL.
 *
 * Consumed rather than merely read: a pass that fails or is skipped must not
 * leave the debt standing, or every subsequent 20 s tick refetches forever — a
 * permanently-armed flag is indistinguishable from having no TTL at all.
 */
export function takeFireArrival(reader: FireReader): boolean {
	return owing.delete(reader);
}

/**
 * PEEK — is this reader still owed a bypass, without consuming it?
 *
 * ⚠️ Exists because `ensure()` has THREE call sites racing for one flag (idle
 * boot, `style.load`, and the pan debounce). Whichever fired first consumed the
 * arrival and then often decided it had nothing to do — so the flag was spent
 * before the call that would actually have fetched. The debt looked paid and
 * nothing was fetched, which is how a phone sat on a 6-hour-old copy with the
 * app open.
 *
 * So the gate PEEKS to decide whether to bypass, and only `settleFireArrival`
 * clears it — after a fetch has genuinely been attempted.
 */
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
