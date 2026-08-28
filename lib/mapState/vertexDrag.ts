// Vertex dragging on completed lines + polygons. Press any vertex (line
// interior, line endpoint, or polygon corner) and drag: pure visual update
// during the drag (setData on the live "completed-features" source), with the
// store getting the final geometry only on release.
//
// Extracted from MapDrawControls.svelte. Factory (not a singleton) — each map
// instance wires its own listeners. Same shape as createUserLocator(() => map).
import type {
    Map as MapboxMap,
    MapLayerMouseEvent,
    MapLayerTouchEvent,
    MapMouseEvent,
    MapTouchEvent,
} from "mapbox-gl";
import type { Feature } from "geojson";
import {
    buildCompletedFC,
    type Lnglat,
} from "$parent/siblings/getCache_OnlineMap/lib/mapDraw";
import { syncAreaLabels } from "$parent/siblings/getCache_OnlineMap/lib/areaLabels";
import { isFiniteLngLat } from "$parent/siblings/getCache_OnlineMap/lib/safeMap";
// 28 Aug 2026: now comes from the host through ../shared/mapHostPorts (MapHostStore = the
// slice of the host's MapStore this file touches).
import type { MapHostStore as MapStore } from "../shared/mapHostPorts";

type GeomKind = "LineString" | "Polygon";
type VertexDragState = {
    idx: number;
    vertexIdx: number;
    kind: GeomKind;
    mapFeatureKey: string;
    coords: Lnglat[]; // line: full coords | polygon: ring without closing dupe
    moved: boolean;
};

export interface VertexDragDeps {
    getMap: () => MapboxMap | null;
    mapStore: MapStore;
    /** Popover anchored to the selected feature — cleared while dragging,
     *  re-anchored on release. Structural to avoid a lib→routes import. */
    popoverPos: { clear(): void; compute(feature: Feature): void };
    /** Truthy while a draw tool is armed — vertex drag is disabled then. */
    getDrawIntent: () => unknown;
    /** Keep the dragged feature selected so its handles stay visible. */
    setSelectedIndex: (idx: number) => void;
}

export interface VertexDragger {
    /** Wire the vertex listeners onto the map. Returns cleanup. Run inside
     *  the map-wiring `$effect`. */
    attach(): () => void;
    /** Timestamp (performance.now) of the last vertex release. The map's
     *  click handler reads this to ignore the synthesized click that follows
     *  a vertex tap/drag, so editing a handle doesn't deselect the feature. */
    readonly lastUpAt: number;
}

export function createVertexDrag(deps: VertexDragDeps): VertexDragger {
    const { getMap, mapStore, popoverPos, getDrawIntent } = deps;
    let drag: VertexDragState | null = null;
    let lastUpAt = 0;

    function paintCompleted(features: Feature[]) {
        const map = getMap();
        const src = map?.getSource("completed-features");
        if (src && "setData" in src) {
            (src as unknown as { setData: (d: unknown) => void }).setData(
                buildCompletedFC(features),
            );
        }
        // The area-name label rides the polygon's centroid, so it follows
        // the drag live instead of snapping over on release.
        if (map) syncAreaLabels(map, features);
    }

    const vertexDown = (
        e: MapLayerMouseEvent | MapLayerTouchEvent,
    ) => {
        if (getDrawIntent()) return;
        const m = getMap();
        if (!m) return;
        const f = e.features?.[0];
        const props = f?.properties as
            | { _idx?: number; _vertexIdx?: number }
            | undefined;
        if (!props) return;
        const idx = props._idx;
        const vIdx = props._vertexIdx;
        if (typeof idx !== "number" || typeof vIdx !== "number") return;
        const feat = mapStore.features[idx];
        if (!feat) return;
        const key = feat.properties?.mapFeatureKey as string | undefined;
        if (!key) return;
        let kind: GeomKind;
        let coords: Lnglat[];
        if (feat.geometry?.type === "LineString") {
            kind = "LineString";
            coords = (feat.geometry as GeoJSON.LineString).coordinates.map(
                (c) => [c[0], c[1]] as Lnglat,
            );
        } else if (feat.geometry?.type === "Polygon") {
            kind = "Polygon";
            const ring = (feat.geometry as GeoJSON.Polygon).coordinates[0];
            // Strip closing dupe; we re-append on commit.
            const last = ring.length - 1;
            const closes =
                ring.length > 1 &&
                ring[0][0] === ring[last][0] &&
                ring[0][1] === ring[last][1];
            const open = closes ? ring.slice(0, last) : ring.slice();
            coords = open.map((c) => [c[0], c[1]] as Lnglat);
        } else {
            return;
        }
        e.preventDefault();
        drag = {
            idx,
            vertexIdx: vIdx,
            kind,
            mapFeatureKey: key,
            coords,
            moved: false,
        };
        m.getCanvas().style.cursor = "grabbing";
        // Keep the feature selected so its vertex handles stay visible for
        // the duration of the drag; only the popover is dismissed (clearing
        // the bbox) so it doesn't obstruct the gesture.
        deps.setSelectedIndex(idx);
        popoverPos.clear();
        m.on("mousemove", vertexMove);
        m.on("touchmove", vertexMove);
        m.once("mouseup", vertexUp);
        m.once("touchend", vertexUp);
        m.once("touchcancel", vertexUp);
    };

    const vertexMove = (e: MapMouseEvent | MapTouchEvent) => {
        if (!drag) return;
        // Multi-touch / pinch can yield NaN lngLat. NaN in source coords
        // poisons every render-time unproject downstream — see safeMap.ts.
        if (!isFiniteLngLat(e.lngLat)) return;
        drag.moved = true;
        drag.coords[drag.vertexIdx] = [e.lngLat.lng, e.lngLat.lat];
        const overrideIdx = drag.idx;
        const overrideCoords = drag.coords.map(
            (c) => [c[0], c[1]] as [number, number],
        );
        const feats: Feature[] = mapStore.features.map((f, i) => {
            if (i !== overrideIdx) return f;
            if (drag?.kind === "LineString") {
                return {
                    ...f,
                    geometry: {
                        type: "LineString",
                        coordinates: overrideCoords,
                    } as GeoJSON.LineString,
                };
            }
            return {
                ...f,
                geometry: {
                    type: "Polygon",
                    coordinates: [[...overrideCoords, overrideCoords[0]]],
                } as GeoJSON.Polygon,
            };
        });
        paintCompleted(feats);
        // No live segment labels while editing a SAVED feature — measurement legs
        // belong to the Snake Ruler only; a saved line/polygon stays clean.
    };

    const vertexUp = () => {
        if (!drag) return;
        lastUpAt = performance.now();
        const { mapFeatureKey, coords, idx, moved, kind } = drag;
        const original = mapStore.features[idx];
        drag = null;
        const m = getMap();
        if (m) {
            m.getCanvas().style.cursor = "";
            m.off("mousemove", vertexMove);
            m.off("touchmove", vertexMove);
        }
        if (!moved || !original) {
            // No drag — the feature stays selected; re-anchor its popover
            // (the bbox was cleared on vertexDown).
            if (original) popoverPos.compute(original);
            return;
        }
        const geometry: Feature =
            kind === "LineString"
                ? {
                      type: "Feature",
                      geometry: {
                          type: "LineString",
                          coordinates: coords,
                      } as GeoJSON.LineString,
                      properties: { ...(original.properties ?? {}) },
                  }
                : {
                      type: "Feature",
                      geometry: {
                          type: "Polygon",
                          coordinates: [[...coords, coords[0]]],
                      } as GeoJSON.Polygon,
                      properties: { ...(original.properties ?? {}) },
                  };
        mapStore.updateFeature(mapFeatureKey, { geometry });
        // The feature stays selected so its handles remain editable; bring
        // the popover back, re-anchored to the new geometry.
        popoverPos.compute(geometry);
    };

    const vertexEnter = () => {
        if (getDrawIntent()) return;
        getMap()?.getCanvas().style.setProperty("cursor", "grab");
    };
    const vertexLeave = () => {
        if (drag) return;
        getMap()?.getCanvas().style.setProperty("cursor", "");
    };

    return {
        get lastUpAt() {
            return lastUpAt;
        },
        attach() {
            const m = getMap();
            if (!m) return () => { /* no map — nothing to detach */ };
            m.on("mousedown", "completed-vertices-dot", vertexDown);
            m.on("touchstart", "completed-vertices-dot", vertexDown);
            m.on("mousedown", "completed-vertices-halo", vertexDown);
            m.on("touchstart", "completed-vertices-halo", vertexDown);
            m.on("mouseenter", "completed-vertices-dot", vertexEnter);
            m.on("mouseleave", "completed-vertices-dot", vertexLeave);
            m.on("mouseenter", "completed-vertices-halo", vertexEnter);
            m.on("mouseleave", "completed-vertices-halo", vertexLeave);
            return () => {
                m.off("mousedown", "completed-vertices-dot", vertexDown);
                m.off("touchstart", "completed-vertices-dot", vertexDown);
                m.off("mousedown", "completed-vertices-halo", vertexDown);
                m.off("touchstart", "completed-vertices-halo", vertexDown);
                m.off("mouseenter", "completed-vertices-dot", vertexEnter);
                m.off("mouseleave", "completed-vertices-dot", vertexLeave);
                m.off("mouseenter", "completed-vertices-halo", vertexEnter);
                m.off("mouseleave", "completed-vertices-halo", vertexLeave);
                m.off("mousemove", vertexMove);
                m.off("touchmove", vertexMove);
            };
        },
    };
}
