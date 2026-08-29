import { Capacitor, registerPlugin } from "@capacitor/core";
import type {
    BackgroundGeolocationPlugin,
    CallbackError,
    Location,
} from "@capacitor-community/background-geolocation";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { Feature, LineString } from "geojson";
import { toast } from "svelte-sonner";
import type { MapHostStore as MapStore } from "../shared/mapHostPorts";
import { getCurrentPositionOnce } from "./userLocation.svelte";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>(
    "BackgroundGeolocation",
);

/** Web sampler cadence — sparse on purpose, one fix every 10s. */
const SAMPLE_MS = 10_000;

/** localStorage marker for a live session — lets boot re-attach to the same track feature after a reload/crash (resume() below); cleared on stop. */
const RESUME_KEY = "rt-trackingSession";

/** Consecutive missed feature lookups allowed before the session declares the track gone and stops itself (never silently). */
const MAX_MISSED_FINDS = 6;

/** Minimum movement (m) before recording a fix — avoids stacking duplicate dots; also doubles as the native watcher's distanceFilter. */
const MIN_MOVE_M = 10;

/** ⚠️ Android 13+ needs the POST_NOTIFICATIONS permission or the tracking banner is invisible, breaking the "tracking is never invisible" promise — ask at TRACKS start, before the watcher posts. */
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

/** Rough great-circle metres between two [lng, lat] points (equirectangular approximation); exported for plotDrop.ts's 5 m proof-of-presence check. */
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

    /** Start a session: create an empty track feature, drop the first fix immediately, then keep sampling. Safe to call when already active. */
    start(store: MapStore, displayName: string | null) {
        if (this.active) return;
        this.active = true;
        this.points = 0;
        this.#store = store;
        // No name on the seed — addFeature generates the convention name; a hardcoded name here would bypass that.
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
        }
    }

    /** Re-attach to a session a reload/crash/app-kill interrupted — boot calls this and the session carries on, with a toast saying so. No marker → no-op. */
    resume(getStore: () => MapStore) {
        if (this.active) return;
        let featureKey: string | null = null;
        try {
            const raw = localStorage.getItem(RESUME_KEY);
            featureKey = raw ? (JSON.parse(raw)?.featureKey ?? null) : null;
        } catch {
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

    /** The pocket sampler: the OS delivers a location every MIN_MOVE_M metres of movement, screen on or off, app front or back. */
    async #startNativeWatcher() {
        // ⚠️ Android 13+: request POST_NOTIFICATIONS before the watcher starts, or the first notification won't be visible.
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
                            // Permission revoked mid-session — end loudly; next TRACKS tap re-runs the location gate.
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
            // Watcher refused to start (plugin missing on an old build) — fall back to the foreground sampler.
            console.warn("[tracking] background watcher unavailable — foreground fallback", e);
            if (!this.active) return;
            void this.#sample();
            this.#timer = setInterval(() => void this.#sample(), SAMPLE_MS);
        }
    }

    /** End the session — always ceremoniously (a toast says what happened; tracking never just vanishes). A 0/1-point track is degenerate, so drop it. */
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
        }
        // The real point count comes from the feature itself, not this.points (0 right after a resume) — never delete a real track off a stale counter.
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

    /** The live track's coordinates, or null if the feature can't be found (deleted, or the store hasn't hydrated it yet). */
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
        // Find across ALL maps, not just the active one, so switching maps mid-session doesn't strand the breadcrumb.
        const rec = store.allMaps
            .flatMap((m) => m.features)
            .find((f) => f.mapFeatureKey === key);
        const feat = rec?.geometry;
        if (!feat || feat.geometry?.type !== "LineString") {
            // Track feature not found (deleted, or store not hydrated yet) — wait out a generous window, then end the session loudly.
            this.#missedFinds += 1;
            if (this.#missedFinds >= MAX_MISSED_FINDS) {
                this.stop("Tracking ended — its track is gone");
            }
            return;
        }
        this.#missedFinds = 0;
        const line = feat.geometry as LineString;
        // Distance gate: ignore fixes that didn't move far enough — sparse data, no stationary duplicate dots.
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
