// Two renderers are live and are not interchangeable at runtime: /mobile/map uses Mapbox GL JS, /mobile/offlinev4 uses MapLibre GL JS (see wallProtocol.ts).
// Wrong library's Marker/Popup on a map doesn't fail politely — it throws "TypeError: e2._addMarker is not a function" from inside addTo (Mapbox-only private method); observed as a BLACK map with no blue dot.
// Worse, if it doesn't throw: a Popup from the wrong library gets the other namespace's DOM classes, so close-button wiring and CSS silently no-op.
// Sniffs the live instance rather than a passed "library" flag — a flag can be forgotten at a call site and reintroduce the wrong-library bug; the instance can't lie.
// Prefer an explicit injection point where one exists (fireLayer's popupLib) — this file is only for helpers with no such seam.

import mapboxgl from "mapbox-gl";
import maplibregl from "maplibre-gl";

// True when built by MapLibre; defaults FALSE (Mapbox) if the probe fails, so unrecognised maps keep existing behaviour.
export function isMaplibreMap(map: unknown): boolean {
	const el = (
		map as { getCanvasContainer?: () => HTMLElement | undefined } | null
	)?.getCanvasContainer?.();
	return el?.className?.includes("maplibregl") ?? false;
}

// The GL library that built this map, imported lazily — both are already bundled, so this is a cache lookup, not a download.
export async function glOf(map: unknown): Promise<typeof import("mapbox-gl").default> {
	if (isMaplibreMap(map)) {
		const m = await import("maplibre-gl");
		return m.default as unknown as typeof import("mapbox-gl").default;
	}
	return (await import("mapbox-gl")).default;
}

// Synchronous on purpose — pin rendering is a hot loop (one call per pin per reconcile) that can't await a per-marker import; both libs are statically imported since they're bundled anyway.
// Callers construct with: new (markerCtor(map))({...})
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
