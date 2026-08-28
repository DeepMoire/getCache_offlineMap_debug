// Pure geometry for "See on map" framing — no map, no reactivity. Resolves a
// feature (shape OR PDF overlay) to a lng/lat bounding box the camera can fit.
// Extracted from MapDrawControls.svelte; the camera-call functions that
// consume these (frameBox / frameFeature / frameActiveMap) stay in the
// component since they touch selection + viewport state.
import { isNullIsland } from "$lib/mobile/stores/mapViewport";
import type { MapSessionFeature } from "$lib/mobile/stores/mapStore.svelte";

export type LngLatBox = {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
};

// The ONE coordinate-tree walker. Generic recursion collapses Point /
// LineString / Polygon and every Multi* variant to the same code.
export function geometryBounds(
    geom: GeoJSON.Geometry | null | undefined,
): LngLatBox | null {
    if (!geom || geom.type === "GeometryCollection") return null;
    let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;
    const eat = (c: unknown): void => {
        if (
            Array.isArray(c) &&
            typeof c[0] === "number" &&
            typeof c[1] === "number"
        ) {
            // A feature with no known location sits at null island (0,0). Drop it
            // from the extent so one unknown pin can't drag the camera out into the
            // Gulf of Guinea — the map frames the REAL features, or nothing.
            if (isNullIsland(c[0], c[1])) return;
            if (c[0] < minLng) minLng = c[0];
            if (c[0] > maxLng) maxLng = c[0];
            if (c[1] < minLat) minLat = c[1];
            if (c[1] > maxLat) maxLat = c[1];
            return;
        }
        if (Array.isArray(c)) for (const v of c) eat(v);
    };
    eat(geom.coordinates);
    return Number.isFinite(minLng) ? { minLng, minLat, maxLng, maxLat } : null;
}

function boxFromTuple(
    b: [number, number, number, number] | null,
): LngLatBox | null {
    if (!b) return null;
    // Drop a degenerate overlay parked at null island (0,0) — same reason as the
    // point guard in geometryBounds: never let an unknown-location feature frame.
    if (isNullIsland((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) return null;
    return { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] };
}

export function unionBox(boxes: (LngLatBox | null)[]): LngLatBox | null {
    let out: LngLatBox | null = null;
    for (const b of boxes) {
        if (!b) continue;
        if (!out) out = { ...b };
        else {
            out.minLng = Math.min(out.minLng, b.minLng);
            out.minLat = Math.min(out.minLat, b.minLat);
            out.maxLng = Math.max(out.maxLng, b.maxLng);
            out.maxLat = Math.max(out.maxLat, b.maxLat);
        }
    }
    return out;
}

// Resolve ONE feature's extent. Shapes read geometry; overlay features
// read the bounds stamped on the feature row at import time.
export async function resolveFeatureBounds(
    f: MapSessionFeature,
): Promise<LngLatBox | null> {
    if (f.geometry) {
        const gb = geometryBounds(f.geometry.geometry);
        return gb;
    }
    if (f.featureType !== "overlay" || !f.overlayStorageKey) return null;
    // Overlays carry their geographic extent on the feature row at import
    // time (set by `importPdf` after GDAL returns the bounds). Anything
    // older — pre-rewrite — has no bounds and won't frame; user re-imports.
    return f.overlayBounds ? boxFromTuple(f.overlayBounds) : null;
}
