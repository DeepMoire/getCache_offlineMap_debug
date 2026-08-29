// ⚠️ mapboxgl.addProtocol doesn't exist — calling it on Mapbox silently no-ops (renders nothing, no error); that cost a full debugging round, don't repeat it. MapLibre's addProtocol (used here) is documented, stable, and runs on the main thread.
// NOT a memory fix — both renderers decode the same ~9.44 MB satellite texture; this swap only buys tile delivery through a documented API instead of a guessed one.
import maplibregl from "maplibre-gl";
// Import MapLibre's CSS via ./maplibreVendor.css only, never `maplibre-gl/dist/maplibre-gl.css` directly — see that file's header for why (cascade-layer fix for a white-on-white popup bug).
import "./maplibreVendor.css";

/** The subset of `initializeMap` options the offline route actually passes. */
export interface OfflineMapOptions {
	style: maplibregl.StyleSpecification;
	initialCenter: [number, number];
	initialZoom: number;
	/** Air-gap guard — rejects/rewrites every non-local URL (LAW 0). */
	transformRequest?: maplibregl.RequestTransformFunction;
	/** Pre-style handle — fires BEFORE the style loads, so the blue dot and Sentry error capture can attach without waiting on a slow style. */
	onMapCreated?: (map: maplibregl.Map) => void;
	/** Post-`load` handle — safe to add sources/layers. */
	onMapReady?: (map: maplibregl.Map) => void;
	showNavigation?: boolean;
}

// Guards against degenerate cameras — a NaN centre/zoom propagates into getBounds() and throws from inside the renderer (red-screens the map); same defence the shared initializer runs.
function safeCamera(
	center: [number, number],
	zoom: number,
): { center: [number, number]; zoom: number } {
	const okCenter =
		Array.isArray(center) &&
		center.length === 2 &&
		Number.isFinite(center[0]) &&
		Number.isFinite(center[1]) &&
		Math.abs(center[0]) <= 180 &&
		Math.abs(center[1]) <= 90;
	const okZoom = Number.isFinite(zoom) && zoom >= 0 && zoom <= 24;
	if (!okCenter || !okZoom) {
		console.warn("[offlineMapInit] degenerate initial camera — using defaults", {
			got: { center, zoom },
		});
	}
	return {
		center: okCenter ? center : [-76.32622, 45.25341],
		zoom: okZoom ? zoom : 7,
	};
}

/** Build the offline map. Returns a teardown function. */
export function initializeOfflineMap(
	container: HTMLElement,
	opts: OfflineMapOptions,
): () => void {
	const cam = safeCamera(opts.initialCenter, opts.initialZoom);

	const map = new maplibregl.Map({
		container,
		style: opts.style,
		center: cam.center,
		zoom: cam.zoom,
		...(opts.transformRequest ? { transformRequest: opts.transformRequest } : {}),
		hash: false,
		interactive: true,
		pitch: 0,
		bearing: 0,
		// No access token needed (air-gapped, no hosted API); preserveDrawingBuffer stays MapLibre's default (false) — the online map sets it true for Sentry replay capture, which would cost GPU memory here for a replay nobody watches.
		attributionControl: false,
	});

	// North is up and CANNOT be turned off — bearing:0 only sets the first frame; disabling these gestures is deliberate (a field map has exactly one correct orientation), don't re-enable rotation.
	map.dragRotate.disable();
	map.touchZoomRotate.disableRotation();
	map.keyboard.disableRotation();

	// Dev-only QA handle — lets browser automation aim the camera without synthetic gestures; same name the online map uses so existing probes keep working.
	if (import.meta.env.DEV) {
		(window as unknown as Record<string, unknown>).__rtMap = map;
		// The cruising-pin detector — opt-in (__pinDrift.start()), never records until asked; DEV-only and lazy so it costs nothing in production.
		void import("../../shared/pinDrift").then((m) => m.installPinDrift(map));
	}

	// Construction-time handle, BEFORE the style loads.
	opts.onMapCreated?.(map);

	if (opts.showNavigation) {
		map.addControl(new maplibregl.NavigationControl(), "top-right");
	}

	const onLoad = (): void => opts.onMapReady?.(map);
	if (map.loaded()) onLoad();
	else map.once("load", onLoad);

	return () => {
		try {
			map.remove();
		} catch (err) {
			console.warn("[offlineMapInit] teardown failed", err);
		}
	};
}
