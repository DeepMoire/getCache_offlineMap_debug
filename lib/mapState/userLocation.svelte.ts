// ⚠️ Mapbox GeolocateControl crashes on iOS (WKWebView + mob-web Safari) — coords deserialize undefined / fitBounds throws; use the Capacitor geolocation plugin + a manual Marker there instead.
import mapboxgl from "mapbox-gl";
import { toast } from "svelte-sonner";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { safeFlyTo } from "$parent/siblings/getCache_OnlineMap/lib/safeMap";
import type { MapHostPorts } from "../shared/mapHostPorts";

const isNative = Capacitor.isNativePlatform();

// ⚠️ NaN marker/camera coords crash Mapbox — validate on both write and read. Last-known fix is persisted so the blue dot appears instantly on re-entry, before a fresh fix arrives.
const LAST_FIX_KEY = "rt-last-fix";
const PERSIST_THROTTLE_MS = 10_000;
let lastPersistTs = 0;

function coordsValid(lng: number, lat: number): boolean {
    return (
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
    );
}

function persistFix(lng: number, lat: number): void {
    const now = Date.now();
    if (now - lastPersistTs < PERSIST_THROTTLE_MS) return;
    lastPersistTs = now;
    try {
        localStorage.setItem(
            LAST_FIX_KEY,
            JSON.stringify({ lng, lat, ts: now }),
        );
    } catch {
    }
}

function loadPersistedFix(): [number, number] | null {
    try {
        const raw = localStorage.getItem(LAST_FIX_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw) as { lng?: unknown; lat?: unknown };
        const lng = Number(p?.lng);
        const lat = Number(p?.lat);
        return coordsValid(lng, lat) ? [lng, lat] : null;
    } catch {
        return null; // corrupt entry — treated as absent
    }
}
const isIOSWeb =
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !isNative;
const usePluginGeo = isNative || isIOSWeb;

/** Get a single GPS fix (Capacitor plugin on native/iOS-web, navigator.geolocation elsewhere). Throws a friendly message on denial/timeout; may trigger the native permission prompt on first call. */
export async function getCurrentPositionOnce(): Promise<{
    lng: number;
    lat: number;
}> {
    if (usePluginGeo) {
        const p = await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 15_000,
        });
        return { lng: p.coords.longitude, lat: p.coords.latitude };
    }
    return new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            reject(new Error("Geolocation isn't available in this browser"));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (p) =>
                resolve({
                    lng: p.coords.longitude,
                    lat: p.coords.latitude,
                }),
            (err) => {
                const msg =
                    err.code === 1
                        ? "Location permission denied — enable it in your browser/system settings"
                        : err.code === 2
                          ? "Couldn't determine your location"
                          : err.code === 3
                            ? "Location request timed out — try again"
                            : err.message || "Location unavailable";
                reject(new Error(msg));
            },
            { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
        );
    });
}

export interface UserLocator {
    /** Mapbox GeolocateControl for desktop-web; null elsewhere. */
    readonly geolocateControl: unknown;
    /** Wire the GeolocateControl to the map (no-op on iOS); returns cleanup — run inside an `$effect`. */
    attachGeolocateControl(): () => void;
    /** Pan to current location and start a watch. iOS path. */
    locate(): Promise<boolean>;
    /** Start the position watch + blue dot without flying the camera — used while a tracking session runs so the dot rides the head of the track. Idempotent. */
    watch(): void;
    /** ⚠️ The always-on dot: only shows/restarts the watch if permission is already granted — NEVER prompts, NEVER moves the camera. Safe on every mount/resume; heals a dead watch rather than stacking a second one. */
    autoStart(): Promise<void>;
    /** The live blue-dot coordinate `[lng, lat]`, or null if no fix yet. Used by snap-to-self: a double-tap within ~44px snaps the dropped plot onto the user's position. */
    getUserCoord(): [number, number] | null;
    /** Flash a one-shot pulse ring on the blue dot for a snap-to-self confirmation. No-op until the dot exists (native-dot path only). */
    pulseSelf(): void;
    /** Tear down the watch + remove the marker. Run inside an `$effect` cleanup so HMR / route changes don't leak. */
    cleanup(): void;
}

/** ⚠️ NOT defensive plumbing — building a mapboxgl.Marker and calling `.addTo()` on a MapLibre map throws `TypeError: e2._addMarker is not a function` and renders the map black. Detect the renderer via the canvas container's class name and pick the matching Marker; defaults to Mapbox. */
function markerCtorFor(map: unknown): Promise<typeof mapboxgl.Marker> {
	const el = (
		map as { getCanvasContainer?: () => HTMLElement | undefined }
	).getCanvasContainer?.();
	return el?.className?.includes("maplibregl")
		? import("maplibre-gl").then(
				(m) => m.default.Marker as unknown as typeof mapboxgl.Marker,
			)
		: import("mapbox-gl").then((m) => m.default.Marker);
}

export function createUserLocator(
    getMap: () => mapboxgl.Map | null,
    /** Tap the blue dot → the host shows the coordinate pill. Optional — other callers (tests, demo scheduler) keep the old one-arg shape. */
    onDotTap?: () => void,
    /** The host's ports: `ui.reportSwallowed`, `gps.reportError`, `gps.isGranted`. Optional — without it errors go to console.warn and the permission check answers true. */
    ports?: Pick<MapHostPorts, "ui" | "gps">,
): UserLocator {
    const reportSwallowed = (scope: string, err: unknown, extra?: Record<string, unknown>) =>
        ports ? ports.ui.reportSwallowed(scope, err, extra) : console.warn(scope, err, extra);
    const reportGeoError = (scope: string, err: unknown, extra?: Record<string, unknown>) =>
        ports ? ports.gps.reportError(scope, err, extra) : console.warn(scope, err, extra);
    const gpsIsGranted = () => (ports ? ports.gps.isGranted() : Promise.resolve(true));
    let geolocateControl: unknown = null;
    let userLocationMarker: mapboxgl.Marker | null = null;
    /** True while the Marker class is being imported — see setOrUpdateUserMarker. */
    let markerPending = false;
    let nativeWatchId: string | null = null;
    // Last known fix, kept current by both paths (native marker via setOrUpdateUserMarker; desktop GeolocateControl via its `geolocate` event) — getUserCoord reads it for snap-to-self in every runtime.
    let lastFix: [number, number] | null = null;
    // ⚠️ True only once a live fix has arrived this session. The persisted instant-dot seed is visual-only — getUserCoord must return null until a real fix lands, or snap-to-self could stamp proof-of-presence at a stale position.
    let hasLiveFix = false;

    function makeUserDotEl(): HTMLDivElement {
        const el = document.createElement("div");
        el.className = "user-location-dot";
        // ⚠️ stopPropagation is load-bearing, not defensive — without it, tapping the dot opens SelfCoordPill and the same map click immediately closes it again.
        el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onDotTap?.();
        });
        return el;
    }

    function setOrUpdateUserMarker(
        lng: number,
        lat: number,
        opts?: { staleSeed?: boolean },
    ) {
        // ⚠️ NaN defence at the Mapbox boundary — a non-finite marker coord corrupts the GL transform (red-screen crash family).
        if (!coordsValid(lng, lat)) return;
        // Record the fix even when the map handle isn't here yet, so getUserCoord + the persisted instant-dot stay current regardless.
        lastFix = [lng, lat];
        if (!opts?.staleSeed) {
            hasLiveFix = true;
            persistFix(lng, lat);
        }
        const map = getMap();
        if (!map) return;
        if (userLocationMarker) {
            userLocationMarker.setLngLat([lng, lat]);
            return;
        }
        // Marker creation is async (see markerCtorFor); markerPending stops a second in-flight fix from creating a duplicate blue dot.
        if (markerPending) return;
        markerPending = true;
        void markerCtorFor(map)
            .then((Marker) => {
                // The map may be gone by now (route change) and a newer fix may have landed — plant at `lastFix`, not the captured lng/lat.
                const live = getMap();
                if (!live || !lastFix || userLocationMarker) return;
                userLocationMarker = new Marker({ element: makeUserDotEl() })
                    .setLngLat(lastFix)
                    .addTo(live);
            })
            .catch((err) =>
                console.warn("[userLocation] marker create failed", err),
            )
            .finally(() => {
                markerPending = false;
            });
    }

    // ⚠️ The Capacitor plugin's web shim calls navigator.permissions.query in checkPermissions(), which throws in iOS Safari.
    /** Map the standard PositionError codes to friendly text (1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT). */
    function geoErrMessage(err: GeolocationPositionError): string {
        return err.code === 1
            ? "Location permission denied — enable it in your browser settings"
            : err.code === 2
              ? "Couldn't determine your location"
              : err.code === 3
                ? "Location request timed out — try again"
                : err.message || "Location unavailable";
    }

    /** One web geolocation attempt with an explicit accuracy setting. */
    function webPositionAttempt(
        highAccuracy: boolean,
        timeout: number,
    ): Promise<{ lng: number; lat: number }> {
        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude }),
                (err) => reject(Object.assign(new Error(geoErrMessage(err)), {
                    code: err.code,
                })),
                { enableHighAccuracy: highAccuracy, timeout, maximumAge: 30_000 },
            );
        });
    }

    /** ⚠️ High accuracy must never be the only attempt — a laptop has no GPS radio, so `enableHighAccuracy: true` can time out while a coarse Wi-Fi/IP fix was available; always fall back to coarse unless the failure is a denial. */
    function getPositionOnce(): Promise<{ lng: number; lat: number }> {
        if (isNative) {
            return Geolocation.getCurrentPosition({
                enableHighAccuracy: true,
                timeout: 15_000,
            }).then((p) => ({
                lng: p.coords.longitude,
                lat: p.coords.latitude,
            }));
        }
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            return Promise.reject(
                new Error("Geolocation isn't available in this browser"),
            );
        }
        // Shorter first leg (8s) — there's somewhere to fall back to, so no need to wait the full 15s for the radio.
        return webPositionAttempt(true, 8_000).catch((err: Error & { code?: number }) => {
            // A denial is final — retrying coarse just prompts the same wall.
            if (err.code === 1) throw err;
            return webPositionAttempt(false, 12_000);
        });
    }

    function startWatch() {
        if (nativeWatchId !== null) return;
        if (isNative) {
            Geolocation.watchPosition(
                { enableHighAccuracy: true },
                (p, err) => {
                    // ⚠️ A mid-session error (signal loss, tunnel) must never freeze the location layer — keep the marker at last-known, keep the watch registered, let the next fix carry on.
                    if (err) {
                        console.warn("[locate] watch error", err);
                        reportGeoError("userLocation:watch", err);
                        return;
                    }
                    if (!p?.coords) return;
                    const { longitude: lng, latitude: lat } = p.coords;
                    if (Number.isFinite(lng) && Number.isFinite(lat)) {
                        setOrUpdateUserMarker(lng, lat);
                    }
                },
            )
                .then((id) => {
                    nativeWatchId = id;
                })
                .catch((e) => reportSwallowed("userLocation:watchPosition", e));
            return;
        }
        if (typeof navigator === "undefined" || !navigator.geolocation) return;
        const id = navigator.geolocation.watchPosition(
            (p) => {
                const { longitude: lng, latitude: lat } = p.coords;
                if (Number.isFinite(lng) && Number.isFinite(lat)) {
                    setOrUpdateUserMarker(lng, lat);
                }
            },
            // Errors leave the marker at last-known; the browser keeps the watch alive and delivers again when a fix returns.
            (e) => {
                console.warn("[locate] watch error", e);
                reportGeoError("userLocation:watch", e);
            },
            // Not high-accuracy on web — a laptop has no GPS radio, so demanding precision can mean the watch never delivers a fix; native above still asks for full precision.
            { enableHighAccuracy: false, maximumAge: 5_000 },
        );
        nativeWatchId = String(id);
    }

    /** Tear down the position watch (marker untouched). The single-owner guarantee lives here + startWatch's `nativeWatchId` latch: exactly one watch, whoever asked for it. */
    function stopWatch() {
        if (nativeWatchId === null) return;
        if (isNative) {
            Geolocation.clearWatch({ id: nativeWatchId }).catch((e) =>
                // ⚠️ A failed teardown can leave the GPS watch running (battery drain) — don't swallow it silently.
                reportSwallowed("userLocation:clearWatch", e),
            );
        } else if (typeof navigator !== "undefined" && navigator.geolocation) {
            const numId = Number(nativeWatchId);
            if (Number.isFinite(numId)) {
                navigator.geolocation.clearWatch(numId);
            }
        }
        nativeWatchId = null;
    }

    return {
        get geolocateControl() {
            return geolocateControl;
        },
        attachGeolocateControl() {
            const map = getMap();
            if (usePluginGeo || !map || geolocateControl)
                return () => {
                    /* nothing was attached — no-op detach */
                };
            let cancelled = false;
            let addedCtrl: mapboxgl.IControl | null = null;
            (async () => {
                // Same library-ownership rule as the marker — a Mapbox control added to a MapLibre map reaches for internals that aren't there; GeolocateControl exists in both, only the class source differs.
                const el = (
                    map as { getCanvasContainer?: () => HTMLElement | undefined }
                ).getCanvasContainer?.();
                const mbgl = el?.className?.includes("maplibregl")
                    ? ((await import("maplibre-gl")).default as unknown as {
                          GeolocateControl: typeof import("mapbox-gl").GeolocateControl;
                      })
                    : (await import("mapbox-gl")).default;
                const m = getMap();
                if (cancelled || !m) return;
                const ctrl = new mbgl.GeolocateControl({
                    positionOptions: { enableHighAccuracy: true },
                    trackUserLocation: true,
                    showUserLocation: true,
                    showAccuracyCircle: true,
                });
                m.addControl(
                    ctrl as unknown as Parameters<typeof m.addControl>[0],
                );
                // Mirror the control's fixes into lastFix so getUserCoord (snap-to-self) works on desktop, where there's no marker.
                ctrl.on("geolocate", (pos: GeolocationPosition) => {
                    const { longitude: lng, latitude: lat } = pos.coords;
                    if (Number.isFinite(lng) && Number.isFinite(lat)) {
                        lastFix = [lng, lat];
                        hasLiveFix = true;
                    }
                });
                geolocateControl = ctrl;
                addedCtrl = ctrl;
            })();
            // Remove the control on cleanup, or HMR / remounts stack up a tower of GeolocateControl tiles.
            return () => {
                cancelled = true;
                const m = getMap();
                if (addedCtrl && m) {
                    try {
                        m.removeControl(addedCtrl);
                    } catch {
                        /* map may already be torn down */
                    }
                }
                geolocateControl = null;
            };
        },
        watch() {
            startWatch();
        },
        async autoStart(): Promise<void> {
            // One permission check — no listener waiting for a grant, no prompt, no self-heal loop; after a gated tap grants, locate() starts the watch itself.
            if (!(await gpsIsGranted())) return;
            // Instant dot: last-known position (this session's fix, else the persisted one) shows immediately while the fresh fix arrives.
            const known = lastFix ?? loadPersistedFix();
            // ⚠️ staleSeed is visual-only — must not count as presence for snap-to-self until a live fix lands (see hasLiveFix).
            if (known)
                setOrUpdateUserMarker(known[0], known[1], { staleSeed: true });
            // Restart rather than stack — heals a watch that silently died while the app was backgrounded; still exactly one watch.
            stopWatch();
            startWatch();
        },
        getUserCoord(): [number, number] | null {
            // Proof-of-presence gate — the persisted instant-dot seed is not a fix; only a live fix this session counts.
            if (!hasLiveFix) return null;
            const ll = userLocationMarker?.getLngLat();
            if (ll && Number.isFinite(ll.lng) && Number.isFinite(ll.lat)) {
                return [ll.lng, ll.lat];
            }
            // Desktop GeolocateControl path: no marker of ours, use its last fix.
            return lastFix;
        },
        pulseSelf() {
            const el = userLocationMarker?.getElement();
            if (!el) return;
            // Restart the animation even on a rapid second snap: drop the class, force a reflow, re-add it so the keyframes replay from 0.
            el.classList.remove("snapping");
            void el.offsetWidth; // reflow — without this the class re-add is a no-op
            el.classList.add("snapping");
            window.setTimeout(() => el.classList.remove("snapping"), 900);
        },
        async locate(): Promise<boolean> {
            // Permissions API is unreliable as a gate (Brave reports denied by default; iOS Safari lacks it) — always call getCurrentPosition instead, it's the real source of truth.
            const map = getMap();
            try {
                const { lng, lat } = await getPositionOnce();
                if (!Number.isFinite(lng) || !Number.isFinite(lat) || !map) {
                    toast.error("Couldn't determine your location");
                    return false;
                }
                setOrUpdateUserMarker(lng, lat);
                safeFlyTo(map, {
                    center: [lng, lat],
                    zoom: 15,
                    duration: 1800,
                    curve: 1.4,
                    essential: true,
                });
                startWatch();
                return true;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error("[locate] failed", e);
                reportGeoError("userLocation:locate", e);
                toast.error(msg);
                return false;
            }
        },
        cleanup() {
            stopWatch();
            userLocationMarker?.remove();
            userLocationMarker = null;
        },
    };
}
