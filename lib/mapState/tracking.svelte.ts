/**
 * MOVED HERE 28 Aug 2026, from src/routes/(getcache)/map/.
 *
 * This is a LIBRARY MODULE — app-wide GPS/location state — and it was living
 * inside a route folder. When /map's 32-file second online map was deleted
 * (the copy of getCache_OnlineMap's component), this went with it and took
 * (getcache)/+layout@.svelte down: the GROUP layout imported `./map/tracking.svelte`,
 * so every Get Cache page, /offline included, 404'd on a missing module and
 * reload-looped.
 *
 * That is the whole lesson of the map move in one file. A route folder is an
 * ADDRESS — an import and a tag. Anything the rest of the app imports is a
 * library and belongs in the host lib, where deleting a route cannot reach it.
 *
 * It stays in ReTreever and NOT in a child on purpose: background geolocation,
 * Capacitor plugins and notification permissions are tier-1 proprietary code a
 * published child must never carry.
 */
// Sparse GPS breadcrumb tracking.
//
// Toggled from the map drawer's TRACK tile. The `active` flag is read in
// two places: the tile (to show its depressed/ON state) and MobMapPage (to
// paint the soft-yellow "you're in tracking mode" border). Both are plain
// reactive reads of this singleton's $state — same pattern as mapStore.
//
// Data model: one "track" LineString feature on the active map, grown by
// one point per movement. Deliberately sparse — low battery + data, few
// points — and it persists / shares like any other feature for free.
//
// TWO SAMPLERS, picked by runtime:
//   • native — @capacitor-community/background-geolocation watcher. Runs with
//     the phone IN A POCKET: screen off, app backgrounded, whole hike. The OS
//     makes the session visible (Android: persistent notification; iOS: the
//     blue location indicator) — tracking is never invisible to the person
//     being tracked. distanceFilter does the sparse gating at the OS level.
//   • web (dt-web / mob-web) — a foreground setInterval + getCurrentPosition.
//     Browsers give a page nothing once the screen is off; that ceiling is
//     Safari's, not ours. Sessions keep running across in-app navigation
//     (the store is a singleton), just not with the screen off.
//
// ROBUSTNESS: a session survives a page reload / Safari tab refresh / app
// relaunch — a RESUME_KEY marker in localStorage lets boot re-attach to the
// same track feature (resume(), called from the mobile layout). And a session
// never ends SILENTLY: every stop — user tap, degenerate track, track deleted,
// permission revoked — says so with a toast.
import { Capacitor, registerPlugin } from "@capacitor/core";
import type {
    BackgroundGeolocationPlugin,
    CallbackError,
    Location,
} from "@capacitor-community/background-geolocation";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { Feature, LineString } from "geojson";
import { toast } from "svelte-sonner";
// 28 Aug 2026: now comes from the host through ../shared/mapHostPorts (MapHostStore = the
// slice of the host's MapStore this file touches).
import type { MapHostStore as MapStore } from "../shared/mapHostPorts";
import { getCurrentPositionOnce } from "./userLocation.svelte";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>(
    "BackgroundGeolocation",
);

/** Web sampler cadence. Sparse on purpose — one fix every 10s. */
const SAMPLE_MS = 10_000;

/** localStorage marker for a live session, so a page reload / Safari tab
 *  refresh / crash doesn't KILL tracking silently — boot sees the marker and
 *  re-attaches to the same track feature (resume() below). Cleared on stop. */
const RESUME_KEY = "rt-trackingSession";

/** Consecutive appends allowed to fail the feature lookup before the session
 *  declares the track gone and stops itself (with a toast — never silently).
 *  Generous so a resumed session can wait out store hydration. */
const MAX_MISSED_FINDS = 6;

/** Don't record a fix unless you've moved at least this far from the last
 *  point. Keeps a stationary phone from stacking duplicate dots, and trims
 *  the point count to the path that actually matters. Doubles as the native
 *  watcher's distanceFilter, so the OS itself skips the still moments. */
const MIN_MOVE_M = 10;

/** Android 13+ only shows the tracking foreground-service notification if the
 *  app holds the POST_NOTIFICATIONS runtime permission — without it the session
 *  runs fine but its "Get Cache is tracking" banner is INVISIBLE, which breaks
 *  the "tracking is never invisible" promise. Ask exactly when it matters: at
 *  TRACKS start, before the watcher posts the notification. Denied → tracking
 *  still records; the status-bar location icon remains the OS-drawn fallback.
 *  iOS never reaches this (its blue location indicator needs no permission),
 *  and pre-13 Android auto-grants. */
async function ensureNotificationPermission(): Promise<void> {
    if (Capacitor.getPlatform() !== "android") return;
    try {
        const { display } = await LocalNotifications.checkPermissions();
        if (display === "prompt" || display === "prompt-with-rationale") {
            await LocalNotifications.requestPermissions();
        }
    } catch (e) {
        // Permission nicety only — never let it block the tracking session.
        console.warn("[tracking] notification permission ask failed", e);
    }
}

/** Rough great-circle metres between two [lng, lat] points. Equirectangular
 *  approximation — plenty accurate at the few-metres scale we gate on.
 *  Exported: plotDrop.ts uses it for the 5 m proof-of-presence check. */
export function metersBetween(a: number[], b: number[]): number {
    const R = 6_371_000;
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad;
    const dLng = (b[0] - a[0]) * toRad;
    const midLat = ((a[1] + b[1]) / 2) * toRad;
    const x = dLng * Math.cos(midLat);
    return Math.sqrt(x * x + dLat * dLat) * R;
}

class Tracking {
    /** True while a session is running. Drives the tile + the screen border. */
    active = $state(false);
    /** Points recorded this session (surfaced on the tile badge). */
    points = $state(0);

    #timer: ReturnType<typeof setInterval> | null = null;
    /** Native background watcher id (null on web / when not running). */
    #watcherId: string | null = null;
    #featureKey: string | null = null;
    #store: MapStore | null = null;
    /** Consecutive appends that couldn't find the track feature. */
    #missedFinds = 0;

    /** Start a session: create an empty track feature, drop the first fix
     *  immediately, then keep sampling. Safe to call when already active. */
    start(store: MapStore, displayName: string | null) {
        if (this.active) return;
        this.active = true;
        this.points = 0;
        this.#store = store;
        // NO name on the seed — addFeature then generates the convention name
        // (`{YYMMDD}Track[_{username}]`, e.g. "260706Track_Chris"), exactly
        // like pins. A hardcoded "Track" here would bypass that.
        const seed: Feature = {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: [] },
        };
        this.#featureKey = store.addFeature(
            seed,
            "track",
            displayName ?? undefined,
            displayName,
        );
        this.#run();
        try {
            localStorage.setItem(
                RESUME_KEY,
                JSON.stringify({ featureKey: this.#featureKey }),
            );
        } catch {
            // codestyle-allow-swallow: storage full/blocked — the session still
            // runs; it just won't survive a reload.
        }
    }

    /** Re-attach to a session a reload/crash/app-kill interrupted. The JS side
     *  dies with the page, but the RESUME_KEY marker and the track feature both
     *  survive — so boot (the mobile layout) calls this and the session simply
     *  carries on, with a toast saying so. No marker → no-op (the getter is
     *  never called, so no store is created on ordinary boots). */
    resume(getStore: () => MapStore) {
        if (this.active) return;
        let featureKey: string | null = null;
        try {
            const raw = localStorage.getItem(RESUME_KEY);
            featureKey = raw ? (JSON.parse(raw)?.featureKey ?? null) : null;
        } catch {
            // codestyle-allow-swallow: corrupt marker — treated as absent below
        }
        if (typeof featureKey !== "string" || !featureKey) return;
        this.active = true;
        this.points = 0; // corrected to the real count by the next append
        this.#store = getStore();
        this.#featureKey = featureKey;
        this.#run();
        toast.success("Tracking resumed");
    }

    #run() {
        this.#missedFinds = 0;
        if (Capacitor.isNativePlatform()) {
            void this.#startNativeWatcher();
            return;
        }
        void this.#sample();
        this.#timer = setInterval(() => void this.#sample(), SAMPLE_MS);
    }

    /** The pocket sampler: the OS delivers a location every MIN_MOVE_M metres
     *  of movement, screen on or off, app front or back. `backgroundMessage`
     *  is what enables background delivery (and is the Android notification's
     *  text — the user-visible "this app is recording" signal). */
    async #startNativeWatcher() {
        // Android 13+: get POST_NOTIFICATIONS BEFORE the watcher starts, so the
        // foreground service's very first notification is actually visible.
        await ensureNotificationPermission();
        // stop() may have run while the permission dialog was up.
        if (!this.active) return;
        try {
            const id = await BackgroundGeolocation.addWatcher(
                {
                    backgroundTitle: "Get Cache is tracking",
                    backgroundMessage:
                        "Recording your track — tap TRACKS on the map to stop.",
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: MIN_MOVE_M,
                },
                (position?: Location, error?: CallbackError) => {
                    if (error) {
                        if (error.code === "NOT_AUTHORIZED") {
                            // Permission revoked mid-session — end LOUDLY. The
                            // next TRACKS tap re-runs the location gate.
                            this.stop("Tracking ended — location was turned off");
                        } else {
                            console.warn("[tracking] watcher error", error);
                        }
                        return;
                    }
                    if (!position) return;
                    this.#append(position.longitude, position.latitude);
                },
            );
            // stop() may have run while addWatcher was in flight.
            if (!this.active) {
                void BackgroundGeolocation.removeWatcher({ id });
                return;
            }
            this.#watcherId = id;
        } catch (e) {
            // Watcher refused to start (plugin missing on an old build) — fall
            // back to the foreground sampler rather than recording nothing.
            console.warn("[tracking] background watcher unavailable — foreground fallback", e);
            if (!this.active) return;
            void this.#sample();
            this.#timer = setInterval(() => void this.#sample(), SAMPLE_MS);
        }
    }

    /** End the session — always CEREMONIOUSLY (a toast says what happened;
     *  tracking never just vanishes). A 0/1-point track is a degenerate
     *  (invalid) line, so drop it — a quick on/off shouldn't litter the
     *  features list. */
    stop(notice?: string) {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        if (this.#watcherId) {
            void BackgroundGeolocation.removeWatcher({ id: this.#watcherId });
            this.#watcherId = null;
        }
        this.active = false;
        try {
            localStorage.removeItem(RESUME_KEY);
        } catch {
            // codestyle-allow-swallow: storage blocked — stale marker just
            // triggers a harmless resume attempt next boot
        }
        // The REAL point count comes from the feature itself (this.points is 0
        // right after a resume until an append lands) — never delete a real
        // track off a stale counter.
        const coords = this.#lineCoords();
        const n = coords?.length ?? this.points;
        if (notice) {
            toast.warning(notice);
        } else if (n < 2) {
            if (coords && this.#featureKey && this.#store) {
                this.#store.deleteFeature(this.#featureKey);
            }
            toast("Tracking off — nothing recorded yet");
        } else {
            toast.success(`Track saved — ${n} points`);
        }
        this.#featureKey = null;
        this.#store = null;
    }

    /** The live track's coordinates, or null if the feature can't be found
     *  (deleted, or the store hasn't hydrated it yet). */
    #lineCoords(): number[][] | null {
        const store = this.#store;
        const key = this.#featureKey;
        if (!store || !key) return null;
        const rec = store.allMaps
            .flatMap((m) => m.features)
            .find((f) => f.mapFeatureKey === key);
        const feat = rec?.geometry;
        if (!feat || feat.geometry?.type !== "LineString") return null;
        return (feat.geometry as LineString).coordinates;
    }

    /** Web sampler: grab one foreground fix and append it. */
    async #sample() {
        const key = this.#featureKey;
        if (!this.#store || !key) return;
        let lng: number;
        let lat: number;
        try {
            ({ lng, lat } = await getCurrentPositionOnce());
        } catch (e) {
            // A single missed fix is fine — sparse tracking tolerates gaps.
            console.warn("[tracking] skipped a sample:", e);
            return;
        }
        // The await above can outlive a stop() — bail if the session moved on.
        if (!this.active || this.#featureKey !== key) return;
        this.#append(lng, lat);
    }

    /** Append one fix to the track's LineString (both samplers land here). */
    #append(lng: number, lat: number) {
        const store = this.#store;
        const key = this.#featureKey;
        if (!this.active || !store || !key) return;
        // Find across ALL maps, not just the active one, so switching the
        // active map mid-session doesn't strand the breadcrumb.
        const rec = store.allMaps
            .flatMap((m) => m.features)
            .find((f) => f.mapFeatureKey === key);
        const feat = rec?.geometry;
        if (!feat || feat.geometry?.type !== "LineString") {
            // Track feature not found — deleted, or (after a resume) the store
            // hasn't hydrated yet. Wait out a generous window, then end the
            // session LOUDLY. A session recording into nothing forever, with
            // the gold border still up, would be the silent lie.
            this.#missedFinds += 1;
            if (this.#missedFinds >= MAX_MISSED_FINDS) {
                this.stop("Tracking ended — its track is gone");
            }
            return;
        }
        this.#missedFinds = 0;
        const line = feat.geometry as LineString;
        // Distance gate: after the first fix, ignore fixes that didn't move
        // far enough — sparse data, no stationary duplicate dots. (The native
        // watcher already filters by distance; this is the shared belt.)
        const last = line.coordinates[line.coordinates.length - 1];
        if (last && metersBetween(last, [lng, lat]) < MIN_MOVE_M) {
            this.points = line.coordinates.length; // resume: correct the badge
            return;
        }
        const next: Feature = {
            ...feat,
            geometry: { ...line, coordinates: [...line.coordinates, [lng, lat]] },
        };
        store.updateFeature(key, { geometry: next });
        this.points = line.coordinates.length + 1;
    }
}

export const tracking = new Tracking();
