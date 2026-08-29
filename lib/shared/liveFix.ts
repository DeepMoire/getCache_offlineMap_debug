// ⛔ THE LAW: this must never cause a permission prompt — every path is gated on gpsIsGranted(), which only inspects, never asks.
// ⚠️ don't "simplify" back to getCurrentGps() from captureGps.ts — it calls requestPermissions() first, which PROMPTS.
// two sources, cheapest first: 1) rt-last-fix in localStorage (free, written by the blue-dot controller); 2) one rate-limited real GPS poll.
import { Geolocation } from "@capacitor/geolocation";
import { isUsableFix } from "./liveAnchor";
import type { LngLat } from "./kmGeo";

/** Do we ALREADY have location permission? Inspect only — never prompt. checkPermissions is non-prompting; requestPermissions (which shows a dialog) is deliberately NOT used here. */
async function gpsIsGranted(): Promise<boolean> {
	try {
		const p = await Geolocation.checkPermissions();
		return p.location === "granted" || p.coarseLocation === "granted";
	} catch {
		// codestyle-allow-swallow: no permissions API (dt-web) = not granted.
		return false;
	}
}

/** Written by the blue-dot controller (userLocation.svelte.ts). */
const LAST_FIX_KEY = "rt-last-fix";

/** How stale a stored fix may be and still be trusted for containment — six hours; we're asking "which blob", not drawing a dot. */
const STORED_FIX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Minimum gap between real GPS polls — 15 min. A BATTERY budget, not a coverage guarantee: a moving vehicle can cross several blobs between polls; that's an accepted trade for the person standing still in the bush. */
const LIVE_FIX_MIN_INTERVAL_MS = 15 * 60 * 1000;

/** Low accuracy ON PURPOSE — a km-scale containment test doesn't need a high-accuracy lock, and requesting one spins up the GPS radio. */
const POLL_OPTS = { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 };

let lastPollTs = 0;

/** Read the persisted blue-dot fix. Null if absent, corrupt, stale, or not a usable coordinate — caller treats that as "bake nothing new". */
export function readStoredFix(now: number = Date.now()): LngLat | null {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(LAST_FIX_KEY);
		if (!raw) return null;
		const p = JSON.parse(raw) as { lng?: unknown; lat?: unknown; ts?: unknown };
		const pos: LngLat = [Number(p?.lng), Number(p?.lat)];
		if (!isUsableFix(pos)) return null;
		const ts = Number(p?.ts);
		if (!Number.isFinite(ts) || now - ts > STORED_FIX_MAX_AGE_MS) return null;
		return pos;
	} catch {
		// codestyle-allow-swallow: a corrupt entry means "unknown position", not an error worth surfacing.
		return null;
	}
}

/** Persist a polled fix under the SAME key + shape the blue-dot controller uses ({lng, lat, ts}), so either writer seeds the other's reads. Best-effort. */
function writeStoredFix(pos: LngLat, ts: number): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(
			LAST_FIX_KEY,
			JSON.stringify({ lng: pos[0], lat: pos[1], ts }),
		);
	} catch {
		// codestyle-allow-swallow: losing the cache costs one extra poll later, never correctness.
	}
}

/** The position to use as a live anchor this pass, or null if we don't know and mustn't ask. Order matters: permission FIRST, then the free stored fix, then — rarely — one poll. */
export async function getLiveFix(): Promise<LngLat | null> {
	// Never prompt. gpsIsGranted only inspects existing permission state.
	if (!(await gpsIsGranted())) return null;

	const stored = readStoredFix();
	if (stored) return stored;

	const now = Date.now();
	if (now - lastPollTs < LIVE_FIX_MIN_INTERVAL_MS) return null;
	lastPollTs = now;
	try {
		const p = await Geolocation.getCurrentPosition(POLL_OPTS);
		const pos: LngLat = [p.coords.longitude, p.coords.latitude];
		if (!isUsableFix(pos)) return null;
		// PERSIST IT — without this, a user who never opens /mobile/map hits the 15-min throttle with storage empty and bakes nothing for the next 14 passes.
		writeStoredFix(pos, now);
		return pos;
	} catch {
		// codestyle-allow-swallow: no fix (indoors, cold start, timeout) is ordinary — the pass carries on with feature anchors; live anchor is an ADDITION, never a prerequisite.
		return null;
	}
}

/** Test seam — resets the poll rate limiter. */
export function __resetLiveFixThrottle(): void {
	lastPollTs = 0;
}
