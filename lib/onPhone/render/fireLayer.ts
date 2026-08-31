/**
 * fireLayer — THE live fire renderer for the offline map.
 *
 * Paints the hotspots the bake service already stores (fireCache entries,
 * written through the host's `fires` port). The v2 disc pipeline
 * (routes/fires/v2/) needs a `?v=2` Worker payload that no deployed Worker
 * serves, so it stays dormant; this layer draws the v1 data that actually
 * flows today. Rendering is setData only — no geometry math on the paint path.
 */
import type * as maplibregl from "maplibre-gl";

import { fireEntriesNear } from "../../../routes/fires/fireCache";

export const FIRE_LAYER_IDS = {
	src: "v4-fire-geo",
	cluster: "v4-fire-cluster",
	count: "v4-fire-cluster-count",
	flame: "v4-fire-flame",
} as const;

/** The visible layers, for wallLegend's toggle row and paintWatch. */
export const FIRE_LAYER_ID_LIST: readonly string[] = [
	FIRE_LAYER_IDS.cluster,
	FIRE_LAYER_IDS.count,
	FIRE_LAYER_IDS.flame,
];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export interface FireLayerHandle {
	(): void;
	repaint(): void;
}

/**
 * Attach the fire layer. Idempotent per style; re-adds itself on style.load.
 * Returns a disposer that is also callable as `.repaint()` — the page calls
 * repaint when the fires circuit lands, so bytes on disk become pixels without
 * a reload.
 */
export function attachFireLayer(map: maplibregl.Map): FireLayerHandle {
	let disposed = false;

	const ensureLayers = (): void => {
		if (map.getSource(FIRE_LAYER_IDS.src)) return;
		map.addSource(FIRE_LAYER_IDS.src, {
			type: "geojson",
			data: EMPTY,
			cluster: true,
			clusterMaxZoom: 13,
			clusterRadius: 40,
		});
		map.addLayer({
			id: FIRE_LAYER_IDS.cluster,
			type: "circle",
			source: FIRE_LAYER_IDS.src,
			filter: ["has", "point_count"],
			paint: {
				"circle-color": "#e0483e",
				"circle-opacity": 0.85,
				"circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
				"circle-stroke-color": "#ffffff",
				"circle-stroke-width": 1.5,
			},
		});
		map.addLayer({
			id: FIRE_LAYER_IDS.count,
			type: "symbol",
			source: FIRE_LAYER_IDS.src,
			filter: ["has", "point_count"],
			layout: {
				"text-field": ["get", "point_count_abbreviated"],
				// The one bundled fontstack — see wallLabels.ts.
				"text-font": ["Noto Sans Regular"],
				"text-size": 11,
			},
			paint: { "text-color": "#ffffff" },
		});
		map.addLayer({
			id: FIRE_LAYER_IDS.flame,
			type: "circle",
			source: FIRE_LAYER_IDS.src,
			filter: ["!", ["has", "point_count"]],
			paint: {
				"circle-color": "#e0483e",
				// frp (fire radiative power, MW) sizes the dot — a big burn reads bigger.
				"circle-radius": [
					"interpolate",
					["linear"],
					["coalesce", ["get", "frp"], 1],
					1,
					4,
					100,
					9,
				],
				"circle-stroke-color": "#ffd24a",
				"circle-stroke-width": 1.5,
			},
		});
	};

	const paint = async (): Promise<void> => {
		if (disposed) return;
		// [] = every cached disc. Fires are few and global to the session, so
		// painting them all beats a per-pan requery — no moveend handler at all.
		const entries = await fireEntriesNear([]);
		if (disposed) return;
		ensureLayers();
		const features: GeoJSON.Feature[] = [];
		for (const e of entries) {
			for (const h of e.hotspots) {
				features.push({
					type: "Feature",
					geometry: { type: "Point", coordinates: [h.coordinates[0], h.coordinates[1]] },
					properties: { frp: h.frp, c: h.c, t: h.t },
				});
			}
		}
		const src = map.getSource(FIRE_LAYER_IDS.src) as maplibregl.GeoJSONSource | undefined;
		src?.setData({ type: "FeatureCollection", features });
	};

	const onStyle = (): void => void paint();
	map.on("style.load", onStyle);
	void paint();

	const handle = (): void => {
		disposed = true;
		map.off("style.load", onStyle);
	};
	handle.repaint = (): void => void paint();
	return handle as FireLayerHandle;
}
