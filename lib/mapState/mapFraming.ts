// pure geometry for "See on map" framing — resolves a feature (shape or PDF overlay) to a lng/lat bounding box the camera can fit.
import { isNullIsland } from "./mapViewport";
import type { MapHostFeature } from "../shared/mapHostPorts";

export type LngLatBox = {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
};

// the one coordinate-tree walker — generic recursion collapses Point/LineString/Polygon and every Multi* variant into the same code.
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
            // a feature with no known location sits at null island (0,0) — drop it, or one unknown pin drags the camera into the Gulf of Guinea.
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
    // drop a degenerate overlay parked at null island (0,0) — same reason as the point guard above: never let an unknown-location feature frame.
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

// resolves one feature’s extent — shapes read geometry; overlay features read the bounds stamped on the feature row at import time.
export async function resolveFeatureBounds(
    f: MapHostFeature,
): Promise<LngLatBox | null> {
    if (f.geometry) {
        const gb = geometryBounds(f.geometry.geometry);
        return gb;
    }
    if (f.featureType !== "overlay" || !f.overlayStorageKey) return null;
    // overlays carry their extent on the feature row at import time (set by importPdf from GDAL) — anything pre-rewrite has no bounds and won’t frame; user re-imports.
    return f.overlayBounds ? boxFromTuple(f.overlayBounds) : null;
}
