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
 * library and belongs in $lib, where deleting a route cannot reach it.
 *
 * It stays in ReTreever and NOT in a child on purpose: background geolocation,
 * Capacitor plugins and notification permissions are tier-1 proprietary code a
 * published child must never carry.
 */
// User-location ("blue dot") controller. Extracted from MapDrawControls.svelte
// to keep the geolocation concern self-contained.
//
// Two implementations branched on runtime:
//   • desktop web → Mapbox GeolocateControl (works in Chrome/Safari on a
//     laptop, gives the standard blue dot + accuracy ring for free).
//   • iOS-ish (native Capacitor *and* mob-web Safari/Chrome on iPhone) →
//     @capacitor/geolocation plugin + a manual mapboxgl.Marker.
//
// Why the split: GeolocateControl crashes on iOS in both contexts. In
// WKWebView the coords deserialize as undefined; even mob-web Safari has
// hit a `_updateCamera → fitBounds → LngLatLike` throw — the control's
// "expected coords" assumptions don't hold there.
import mapboxgl from "mapbox-gl";
import { toast } from "svelte-sonner";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { safeFlyTo } from "$parent/siblings/getCache_OnlineMap/lib/safeMap";
import { reportSwallowed } from "$lib/mobile/utils/reportSwallowed";
import { reportGeoError } from "$lib/mobile/utils/reportGeoError";
import { gpsIsGranted } from "$lib/mobile/utils/captureGps";

const isNative = Capacitor.isNativePlatform();

// ── Last-known fix (the "instant dot") ──────────────────────────────────
// The most recent GPS fix is persisted (lightweight, throttled) so on a map
// re-entry / app relaunch the blue dot appears IMMEDIATELY at the last-known
// position while the fresh fix is still being acquired. Same dot, same style
// — no "stale" visual treatment (colours are user-owned). Coords are
// validated on both write and read: a NaN marker/camera crashes Mapbox
// (same defence family as safeMap).
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
        // codestyle-allow-swallow: storage full/blocked — the dot just won't
        // be instant on the next visit; the live watch still drives it.
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

/**
 * Get a single GPS fix using whichever API is appropriate for the
 * current runtime (Capacitor plugin on native + iOS-web; standard
 * navigator.geolocation everywhere else).
 *
 * Throws with a friendly message on permission denial or timeout
 * so callers can surface it directly. Will trigger the native
 * permission prompt on first call if the user hasn't granted it.
 */
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
    /** Wire the GeolocateControl to the map (no-op on iOS). Returns
     *  cleanup. Run inside an `$effect`. */
    attachGeolocateControl(): () => void;
    /** Pan to current location and start a watch. iOS path. */
    locate(): Promise<boolean>;
    /** Start the position watch + blue dot WITHOUT flying the camera. Used
     *  while a tracking session runs, so the dot visibly rides the head of
     *  the growing track — the live "it's working" signal. Idempotent. */
    watch(): void;
    /** THE ALWAYS-ON DOT. Checks location permission ONCE; if (and only if)
     *  it is ALREADY granted, shows the dot immediately at the last-known
     *  fix and (re)starts the position watch. NEVER prompts — an ungranted
     *  state is a silent no-op (prompting belongs exclusively to the
     *  location gate, on a location-needing tap). NEVER moves the camera.
     *  Safe to call on every mount/resume: it restarts the single watch
     *  (healing one that died in the background) rather than stacking a
     *  second one. */
    autoStart(): Promise<void>;
    /** The live blue-dot coordinate `[lng, lat]`, or null if we don't have a
     *  fix yet. Used by snap-to-self: a double-tap within ~44px of this snaps
     *  the dropped plot onto the user's real position (proof-of-presence). */
    getUserCoord(): [number, number] | null;
    /** Flash a one-shot pulse ring on the blue dot — the visual "got you, we're
     *  placing exactly where you are" confirmation when a snap-to-self engages.
     *  No-op until the dot exists (desktop GeolocateControl path has no element
     *  we own, so the pulse is the native-dot path only). */
    pulseSelf(): void;
    /** Tear down the watch + remove the marker. Run inside an `$effect`
     *  cleanup so HMR / route changes don't leak. */
    cleanup(): void;
}

/**
 * The `Marker` class belonging to whichever library built this map.
 *
 * ⚠️ THIS IS NOT DEFENSIVE PLUMBING — it fixes a crash. The online map
 * (/mobile/map) is Mapbox; the offline map (/mobile/offlinev4) is MapLibre.
 * Building a `mapboxgl.Marker` and calling `.addTo(maplibreMap)` throws
 *
 *     TypeError: e2._addMarker is not a function
 *
 * from inside Mapbox's own `Marker.addTo`, because `_addMarker` is a private
 * method that only Mapbox's Map has. The map renders BLACK and the blue dot
 * never appears. Observed on the offline route before this existed.
 *
 * Every live map carries its renderer's namespaced class on the canvas
 * container (`mapboxgl-canvas-container` / `maplibregl-canvas-container`),
 * which is the cheapest honest way to ask an instance who owns it. Defaults to
 * Mapbox, so anything unrecognised behaves exactly as before.
 */
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
    /** Tap the blue dot → the host shows the coordinate pill. Optional so every
     *  other caller (tests, demo scheduler) keeps the old one-arg shape. */
    onDotTap?: () => void,
): UserLocator {
    let geolocateControl: unknown = null;
    let userLocationMarker: mapboxgl.Marker | null = null;
    /** True while the Marker class is being imported — see setOrUpdateUserMarker. */
    let markerPending = false;
    let nativeWatchId: string | null = null;
    // Last known fix, kept current on BOTH paths: the native marker (iOS/native +
    // mob-web) writes it in setOrUpdateUserMarker; the desktop GeolocateControl
    // writes it from its `geolocate` event. getUserCoord reads it so snap-to-self
    // works in every runtime (the desktop control owns no marker element of ours).
    let lastFix: [number, number] | null = null;
    // True only once a LIVE fix has arrived this session. The persisted
    // instant-dot seed (autoStart) is visual-only: getUserCoord must return
    // null until a real fix lands, or snap-to-self could stamp
    // proof-of-presence at yesterday's position.
    let hasLiveFix = false;

    function makeUserDotEl(): HTMLDivElement {
        const el = document.createElement("div");
        el.className = "user-location-dot";
        // TAP THE DOT → the coordinate pill. The dot is the most obvious thing
        // on the map to poke when you want to know where you are, so poking it
        // does what LOCATE does (minus the camera move — you're already looking
        // at yourself).
        //
        // stopPropagation is LOAD-BEARING, not defensive: SelfCoordPill
        // dismisses itself on the map's `click` (the map is its close surface).
        // Marker elements live in the map's DOM, so without this the same tap
        // would open the pill and immediately close it again — a dot that
        // visibly does nothing.
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
        // NaN defence at the Mapbox boundary — a non-finite marker coord
        // corrupts the GL transform (the red-screen family of crashes).
        if (!coordsValid(lng, lat)) return;
        // Record the fix even when the map handle isn't here yet, so
        // getUserCoord + the persisted instant-dot stay current regardless.
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
        // Creating the marker is ASYNC now: the Marker class comes from whichever
        // library owns this map (see markerCtorFor). Fixes arrive on a watch, so a
        // second one can land while the first import is still in flight —
        // `markerPending` is what stops that becoming TWO blue dots.
        if (markerPending) return;
        markerPending = true;
        void markerCtorFor(map)
            .then((Marker) => {
                // The map may be gone by now (route change), and a newer fix may
                // have landed — plant at `lastFix`, not the captured lng/lat.
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

    // Get a single fix. Native uses the Capacitor plugin (real iOS/Android
    // impl). Web (mob-web + dt-web) uses navigator.geolocation directly. The
    // Capacitor plugin's web shim calls navigator.permissions.query in
    // checkPermissions(), which throws in iOS Safari — that's what made the
    // previous version fail with "Couldn't get your location."
    /** Map the standard PositionError codes to friendly text.
     *  1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT. */
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

    /**
     * Get a single fix. Native uses the Capacitor plugin (real iOS/Android
     * impl). Web (mob-web + dt-web) uses navigator.geolocation directly. The
     * Capacitor plugin's web shim calls navigator.permissions.query in
     * checkPermissions(), which throws in iOS Safari — that's what made an
     * earlier version fail with "Couldn't get your location."
     *
     * ⚠️ HIGH ACCURACY MUST NEVER BE THE ONLY ATTEMPT. A laptop has no GPS
     * radio, so `enableHighAccuracy: true` waits the full timeout and then
     * throws TIMEOUT — while a COARSE Wi-Fi/IP fix was available the whole
     * time. That killed the blue dot AND the offline blob on desktop: the user
     * granted permission, saw the fires (which use a different path) draw a
     * ring around them, and still got "Location request timed out".
     *
     * So: try precise, and on ANYTHING but a denial, fall back to coarse. A
     * city-block-accurate fix is overwhelmingly good enough — the dot is a dot,
     * and the offline blob it seeds is a 2 km disc. Precision we can't get is
     * worth far less than a position we can.
     */
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
        // Shorter first leg: we now have somewhere to go when it fails, so
        // there's no reason to make the user wait the full 15 s for the radio.
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
                    // A mid-session error (signal loss, canyon, tunnel) must
                    // never freeze the location layer: keep the marker at its
                    // last-known position, keep the watch registered, and let
                    // the next good fix / next app-resume restart carry on.
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
            // Errors leave the marker at last-known; the browser keeps the
            // watch alive and delivers again when a fix returns.
            (e) => {
                console.warn("[locate] watch error", e);
                reportGeoError("userLocation:watch", e);
            },
            // NOT high-accuracy on the web. Same reasoning as getPositionOnce:
            // a laptop has no GPS radio, so demanding precision can mean the
            // watch never delivers a single fix and the dot never appears.
            // Coarse updates keep the dot live everywhere; native (above) still
            // asks for full precision because there the radio exists.
            { enableHighAccuracy: false, maximumAge: 5_000 },
        );
        nativeWatchId = String(id);
    }

    /** Tear down the position watch (marker untouched). THE single-owner
     *  guarantee lives here + in startWatch's `nativeWatchId` latch: there is
     *  exactly one watch, whoever asked for it (LOCATE tap, tracking session,
     *  or the always-on auto-start). */
    function stopWatch() {
        if (nativeWatchId === null) return;
        if (isNative) {
            Geolocation.clearWatch({ id: nativeWatchId }).catch((e) =>
                // A failed teardown can leave the GPS watch running
                // (battery drain) — don't swallow it silently.
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
                // Same library-ownership rule as the marker above: a Mapbox
                // control added to a MapLibre map reaches for internals that are
                // not there. GeolocateControl exists in both with these exact
                // options, so only the class source differs.
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
                // Mirror the control's fixes into lastFix so getUserCoord (and
                // thus snap-to-self) works on desktop, where there's no marker.
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
            // Remove the control on cleanup — otherwise HMR / remounts stack
            // up a tower of GeolocateControl tiles on the right side.
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
            // ONE permission check — no listener waiting for a grant, no
            // prompt, no self-heal loop (THE LOCATION GATE stays dead simple;
            // after a gated tap grants, locate() starts the watch itself).
            if (!(await gpsIsGranted())) return;
            // Instant dot: last-known position (this session's fix, else the
            // persisted one) shows immediately while the fresh fix arrives.
            const known = lastFix ?? loadPersistedFix();
            // staleSeed: visual-only — must not count as presence for
            // snap-to-self until a live fix lands (see hasLiveFix).
            if (known)
                setOrUpdateUserMarker(known[0], known[1], { staleSeed: true });
            // Restart rather than stack — heals a watch that silently died
            // while the app was backgrounded; still exactly one watch.
            stopWatch();
            startWatch();
        },
        getUserCoord(): [number, number] | null {
            // Proof-of-presence gate: the persisted instant-dot seed is not
            // a fix — only a live fix this session counts.
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
            // Restart the animation even on a rapid second snap: drop the class,
            // force a reflow, re-add it so the keyframes replay from 0.
            el.classList.remove("snapping");
            void el.offsetWidth; // reflow — without this the class re-add is a no-op
            el.classList.add("snapping");
            window.setTimeout(() => el.classList.remove("snapping"), 900);
        },
        async locate(): Promise<boolean> {
            // Note: Permissions API is unreliable as a gate. Brave's privacy
            // shield reports "denied" by default even when the user hasn't
            // denied anything, and iOS Safari doesn't implement it. Always
            // call getCurrentPosition — it's the source of truth for whether
            // the browser will actually surface a prompt or hand us coords.
            const map = getMap();
            try {
                const { lng, lat } = await getPositionOnce();
                if (!Number.isFinite(lng) || !Number.isFinite(lat) || !map) {
                    toast.error("Couldn't determine your location");
                    return false;
                }
                setOrUpdateUserMarker(lng, lat);
                // Gentle ease-in: longer duration + softer curve so the drawer
                // close and the camera glide feel like one motion.
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
