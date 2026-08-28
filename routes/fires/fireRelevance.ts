/**
 * fireRelevance.ts — WHICH fires belong on screen, measured from the USER.
 *
 * ── The bug this module exists to kill ──
 * The map showed hotspots over Winnipeg, Bismarck, Minneapolis and Des Moines
 * while the user's blue dot sat on the BC coast — roughly 2,000 km away. Three
 * separate attempts had failed to fix it, because each one worked at the wrong
 * layer:
 *
 *   1. shrink the fetch radius       → a chain of discs still all painted
 *   2. shrink the cluster circles    → same dots, smaller
 *   3. filter to the SCREEN bbox     → at continental zoom the screen IS the
 *                                      continent, so it filtered nothing
 *
 * The actual root cause: **nothing in the render path ever measured distance
 * from the USER.** `FIRE_RADIUS_KM` was only ever a download bbox, handed to
 * NASA, and the display had never heard of it. Worse, discs are fetched around
 * `map.getCenter()` — the CAMERA — so every pan minted a new disc anchored
 * wherever you happened to look, and they all painted forever after.
 *
 * ── The rule, stated once, enforced here ──
 * Distance from your ANCHORS is the ONLY thing that decides visibility:
 *
 *   • Past HARD_CUTOFF_KM (500) from every anchor there is NOTHING. Not faded,
 *     not clustered — absent. This is a hard promise, not a tunable.
 *   • Inside it, prominence falls off with distance from the NEAREST anchor, so
 *     near fires read loudly and far ones recede.
 *   • With no anchors at all we cannot compute relevance, so we fall back to
 *     the map centre — the best available proxy — rather than showing the
 *     world.
 *
 * ── Why anchors, and not just the user ──
 * "Near the user" was the first fix, and it was too narrow: it silently hid the
 * fires around a block the user had just created 1,900 km away. Relevance is
 * proximity to ground you have a STAKE in — your live fix is one such place,
 * the features you have touched recently are the others. See `fireAnchors`.
 *
 * ── Why relevance is size-vs-distance, not distance alone ──
 * A small fire 20 km away matters more than a big one 400 km away, so the
 * threshold to stay on screen RISES with distance. A far fire has to be big to
 * earn its pixel. That is what stops the far field turning to mush without
 * hiding a genuine monster on the horizon.
 *
 * Pure functions, no map and no DOM, so the whole policy is unit-testable.
 */

import type { FireHotspot } from "./fireCache";

/**
 * ⛔ THE HARD WALL. Beyond this, from the user, nothing renders. Ever.
 *
 * The user's words, after three failed attempts: "You show nothing after 500
 * kilometers nothing at all period. That's not going to go away." Treat this as
 * a promise the UI keeps, not a number to tune. It deliberately equals
 * FIRE_RADIUS_KM — what we download is exactly what we may draw.
 */
export const HARD_CUTOFF_KM = 500;

/** Inside this, a fire is "at your block" — always shown at full prominence
 *  whatever its size. Small nearby fires are the whole point of the layer. */
export const NEAR_KM = 50;

/** Great-circle km. Local copy keeps this module dependency-free. */
export function distKm(
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	const R = 6371;
	const toRad = Math.PI / 180;
	const dLat = (b[1] - a[1]) * toRad;
	const dLng = (b[0] - a[0]) * toRad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Minimum FRP (megawatts) a hotspot needs to stay visible at a given distance.
 *
 * Zero inside NEAR_KM — nothing near you is ever filtered out. Past that it
 * climbs linearly to MAX_FRP_GATE at the cutoff, so the far field keeps only
 * genuinely significant fires. The ramp is gentle on purpose: this is meant to
 * thin a rash into a readable scatter, not to hide the countryside.
 */
export const MAX_FRP_GATE = 25;

export function frpGateAt(km: number): number {
	if (km <= NEAR_KM) return 0;
	if (km >= HARD_CUTOFF_KM) return Number.POSITIVE_INFINITY;
	const t = (km - NEAR_KM) / (HARD_CUTOFF_KM - NEAR_KM);
	return t * MAX_FRP_GATE;
}

/**
 * ⛔ DELETED: `prominenceAt` — the distance fade. Do not bring it back.
 *
 * It faded a hotspot's opacity from 1.0 at your feet to 0.25 at the wall, and it
 * was coherent while the wall had ONE origin: "far from the user" and "less
 * important to the user" were the same sentence.
 *
 * ANCHORS broke that. With the origin a SET, a fire 400 km from a block you
 * deliberately pinned rendered at ~0.3 opacity while a fire beside your live fix
 * sat at 1.0 — the same hazard drawn two different ways depending on which
 * anchor happened to qualify it. Reported from the field as "the fires in the
 * pinned blob are really faint but the ones around location services aren't".
 *
 * It is deleted rather than rescaled because the premise was wrong, not the
 * curve: a detection either passes the FRP gate or it is not on the map at all.
 * Once drawn it IS a fire, and a hazard layer must not whisper. Distance already
 * has a home — the tap card's "190 km E" — and spending opacity on it a second
 * time only costs legibility in bright sun, the one condition that matters.
 *
 * Opacity now carries AGE and the industrial flag. Nothing else.
 */

export interface RelevantHotspot extends FireHotspot {
	/** km from the NEAREST anchor (see `fireAnchors`) — not necessarily the user. */
	readonly km: number;
}

/**
 * ── ANCHORS: the places you have a stake in ──
 *
 * Relevance used to mean "near your body". That was wrong, and the bug was
 * plain to see: a user in Vancouver created a feature in Manitoba, the bake
 * service dutifully downloaded the fires around it, and the map drew none of
 * them — they were 1,900 km from the phone. The layer went quiet about the one
 * piece of ground the user had just told it they cared about.
 *
 * A planter is anxious about the ground they are RESPONSIBLE for, and they are
 * usually not standing on it: working out of Vancouver, blocks up north. Your
 * body is simply the most common such place, not the only one. So the origin is
 * a SET — your live fix plus the ground you have touched recently — and the wall
 * is measured from whichever anchor is nearest.
 *
 * ⚠️ Deliberately capped and deduped. Every anchor is another 500 km disc, and
 * enough of them turn the wall back into the continent-of-dots bug it was built
 * to kill. `MAX_FIRE_ANCHORS` bounds how many stakes you can hold at once, and
 * `ANCHOR_MERGE_KM` collapses anchors whose discs would overlap so heavily that
 * keeping both buys nothing — three pins on one block are ONE place.
 */
export const MAX_FIRE_ANCHORS = 3;

/** Anchors closer together than this collapse into one — their 500 km discs
 *  overlap so far that the second adds no ground, only cost. */
export const ANCHOR_MERGE_KM = 200;

/** A place the user has a stake in, newest-touched first. */
export interface FireAnchorInput {
	readonly at: readonly [number, number];
	/** epoch ms; larger = more recently touched. The live fix passes Infinity. */
	readonly touchedAt: number;
}

/**
 * Reduce candidate anchors to the set the fire layer measures from.
 *
 * Order is by recency, so the thing you touched last always survives the cap —
 * that is the whole promise: create a feature in Manitoba and the fires around
 * it appear, even though you are in BC.
 */
export function fireAnchors(
	candidates: readonly FireAnchorInput[],
): Array<readonly [number, number]> {
	const byRecency = [...candidates]
		.filter((c) => Number.isFinite(c.at[0]) && Number.isFinite(c.at[1]))
		.sort((a, b) => b.touchedAt - a.touchedAt);
	const kept: Array<readonly [number, number]> = [];
	for (const c of byRecency) {
		if (kept.length >= MAX_FIRE_ANCHORS) break;
		// Near an anchor we already kept? Same place, in practice.
		if (kept.some((k) => distKm(k, c.at) < ANCHOR_MERGE_KM)) continue;
		kept.push(c.at);
	}
	return kept;
}

/** km from the nearest anchor, or Infinity when there are none. */
export function nearestAnchorKm(
	at: readonly [number, number],
	anchors: readonly (readonly [number, number])[],
): number {
	let best = Number.POSITIVE_INFINITY;
	for (const a of anchors) {
		const km = distKm(a, at);
		if (km < best) best = km;
	}
	return best;
}

/**
 * THE gate. Everything the map draws passes through here.
 *
 * `origin` is the anchor SET — the user's position when known, plus the ground
 * they have touched recently (see `fireAnchors`). A hotspot survives if it is
 * inside the wall of ANY anchor, and its distance-derived properties are
 * measured from the NEAREST one: a fire 12 km from your northern block reads as
 * loud and near, which is what it is, regardless of where your phone is.
 */
export function relevantHotspots(
	hotspots: readonly FireHotspot[],
	origin: readonly (readonly [number, number])[] | null,
): RelevantHotspot[] {
	// No anchors at all: we genuinely cannot judge relevance. Show nothing rather
	// than everything — a continent of dots is worse than an empty layer, and
	// the caller always has a map centre to offer.
	if (origin === null || origin.length === 0) return [];
	const out: RelevantHotspot[] = [];
	for (const h of hotspots) {
		const km = nearestAnchorKm(h.coordinates, origin);
		// THE WALL — from the nearest anchor.
		if (km >= HARD_CUTOFF_KM) continue;
		if (h.frp < frpGateAt(km)) continue;
		out.push({ ...h, km });
	}
	return out;
}

/**
 * ── THE ONE HOTSPOTS → MAP-FEATURES FUNCTION ──
 *
 * Both maps call this. Neither one stamps properties itself.
 *
 * It exists because they used to. `fireLayer.ts` (online) and
 * `offlinev4/+page.svelte` (offline) each hand-rolled the same walk — wall,
 * age stamp, prominence — and the moment a fifth property (`ind`, the
 * industrial-source flag) was added, it went into ONE of them. The two maps
 * disagreed about what a hotspot even is, and the only reason it wasn't
 * visible in the field is that the mask asset hadn't shipped yet.
 *
 * So the rule is now structural rather than remembered: there is exactly one
 * place that turns hotspots into paintable features, and adding a property
 * here reaches both maps by construction. Do NOT stamp feature properties at a
 * call site — put it here.
 *
 * `hidden` is the legend's fire toggle. It empties the collection rather than
 * removing the layers, so the source stays mounted and flipping the eye back on
 * is a `setData` away — no style surgery, no re-add, no chance of the layer
 * failing to come back.
 */
export function fireFeatureCollection(opts: {
	readonly hotspots: readonly FireHotspot[];
	/** The anchor SET — see `fireAnchors`. Empty/null draws nothing. */
	readonly origin: readonly (readonly [number, number])[] | null;
	/** Now, in epoch ms — injected so the age stamp is testable. */
	readonly now: number;
	/** Persistent-heat-source cell mask; empty set = nothing flagged. */
	readonly staticMask: ReadonlySet<string>;
	/** Legend toggle OFF → paint an empty collection. */
	readonly hidden?: boolean;
	/** Hotspot → GeoJSON, injected to keep this module free of the cache types. */
	readonly toGeoJSON: (
		h: readonly RelevantHotspot[],
	) => GeoJSON.FeatureCollection;
	/** Cell-mask lookup, injected for the same reason. */
	readonly isStatic: (
		lng: number,
		lat: number,
		mask: ReadonlySet<string>,
	) => boolean;
	/**
	 * "Is this in a city?" — injected. Detections that answer true are DROPPED,
	 * not flagged: this is a wildfire layer, and every wildfire agency map
	 * (BC Wildfire's included) leaves the built-up basin empty. A hotspot in
	 * downtown Vancouver is a flare or a rooftop, it is a municipal fire
	 * department's business either way, and showing it discredits the layer.
	 *
	 * Default: keep everything. A caller that hasn't loaded polygons must not
	 * silently lose fires.
	 */
	readonly isUrban?: (lng: number, lat: number) => boolean;
}): { fc: GeoJSON.FeatureCollection; shown: RelevantHotspot[] } {
	const empty: GeoJSON.FeatureCollection = {
		type: "FeatureCollection",
		features: [],
	};
	if (opts.hidden === true) return { fc: empty, shown: [] };

	const inRange = relevantHotspots(opts.hotspots, opts.origin);
	// ⛔ CITY RULE — drop, don't flag. See the `isUrban` doc above.
	const urban = opts.isUrban;
	const shown =
		urban === undefined
			? inRange
			: inRange.filter((h) => !urban(h.coordinates[0], h.coordinates[1]));
	const fc = opts.toGeoJSON(shown);

	for (const f of fc.features) {
		const props = f.properties as Record<string, unknown>;
		// Mapbox has no concept of "now", so age is baked in at paint time for
		// the opacity ramp.
		props.ageH = (opts.now - (props.t as number)) / 3_600_000;
		const co = (f.geometry as GeoJSON.Point).coordinates;
		// Industrial sources are FLAGGED, never removed — a refinery genuinely
		// can catch fire, and deleting would mean the app says nothing on the day
		// it does. They render dimmed and their card names them.
		props.ind = opts.isStatic(co[0], co[1], opts.staticMask) ? 1 : 0;
	}
	return { fc, shown };
}
