/**
 * rendererOf.ts — which GL library owns this map instance?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Two renderers are live in this app and they are NOT interchangeable at
 * runtime, only at the type level:
 *
 *   /mobile/map        → Mapbox GL JS   (needs globe, setFog, setTerrain)
 *   /mobile/offlinev4  → MapLibre GL JS (needs addProtocol; see wallProtocol.ts)
 *
 * Several helpers are shared by BOTH maps and construct `Marker` / `Popup` /
 * `GeolocateControl` off the library object. Building one library's class and
 * attaching it to the other's map does not fail politely — it throws from
 * inside the class's own `addTo`:
 *
 *     TypeError: e2._addMarker is not a function
 *
 * because `_addMarker` is a private method only Mapbox's Map has. Observed on
 * the offline route: the map rendered BLACK and the blue dot never appeared.
 * The failure is worse when it DOESN'T throw — a Popup built from the wrong
 * library gets the other namespace's DOM classes, so its close-button wiring
 * finds nothing and none of its CSS applies, silently.
 *
 * ── WHY SNIFF THE INSTANCE RATHER THAN PASS A FLAG ───────────────────────
 *
 * Threading a `library` prop through every shared component is the tidier
 * design on paper, but it has a failure mode this doesn't: a call site that
 * forgets to pass it gets the WRONG library and the silent-popup bug. Asking
 * the live instance cannot be forgotten, and it is exactly as authoritative —
 * the renderer stamps its own namespaced class on the canvas container it
 * built (`mapboxgl-canvas-container` / `maplibregl-canvas-container`).
 *
 * Where an explicit injection point already exists (fireLayer's `popupLib`),
 * prefer it — it keeps the lazy import at the call site. This is for the
 * helpers that have no such seam.
 */

import mapboxgl from "mapbox-gl";
import maplibregl from "maplibre-gl";

/** True when this map was built by MapLibre. Defaults to FALSE (Mapbox) for
 *  anything unrecognised, so the online map keeps its existing behaviour if
 *  the probe ever fails. */
export function isMaplibreMap(map: unknown): boolean {
	const el = (
		map as { getCanvasContainer?: () => HTMLElement | undefined } | null
	)?.getCanvasContainer?.();
	return el?.className?.includes("maplibregl") ?? false;
}

/**
 * The GL library object that built this map, imported lazily.
 *
 * Both modules are already in the bundle graph (the app ships both renderers),
 * so this resolves from cache after the first call on each — it is a lookup,
 * not a download.
 */
export async function glOf(map: unknown): Promise<typeof import("mapbox-gl").default> {
	if (isMaplibreMap(map)) {
		const m = await import("maplibre-gl");
		return m.default as unknown as typeof import("mapbox-gl").default;
	}
	return (await import("mapbox-gl")).default;
}

/**
 * The `Marker` class for this map — SYNCHRONOUS.
 *
 * Pin rendering is a hot synchronous loop (one call per pin, per reconcile),
 * so it cannot await an import per marker. Both libraries are statically
 * imported here instead: the app ships both renderers regardless, so there is
 * no bundle cost that dynamic import would have avoided — only a lost
 * opportunity to defer, which is not worth an async rewrite of the pin loop.
 *
 * Callers construct with `new (markerCtor(map))({...})`.
 */
export function markerCtor(map: unknown): typeof mapboxgl.Marker {
	return isMaplibreMap(map)
		? (maplibregl.Marker as unknown as typeof mapboxgl.Marker)
		: mapboxgl.Marker;
}

/** The `Popup` class for this map — SYNCHRONOUS. Same rationale as markerCtor. */
export function popupCtor(map: unknown): typeof mapboxgl.Popup {
	return isMaplibreMap(map)
		? (maplibregl.Popup as unknown as typeof mapboxgl.Popup)
		: mapboxgl.Popup;
}
