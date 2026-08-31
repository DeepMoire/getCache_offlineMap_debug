/**
 * paintWatch.ts — the ONLY witness that can turn a CONFIG row green.
 *
 * Download code lights a circuit `ok` when bytes hit IndexedDB; that is not
 * pixels. On every map `idle` (all tiles fetched, all layers rendered) this
 * counts what MapLibre actually painted inside the viewport for each layer
 * row and records it in the work meter, which derives `drawn` from the
 * count arriving AFTER the feed's bytes did. MEASURED 29 Aug 2026: pack
 * lights went green at 19:08:35 for blobs that were not on screen minutes
 * later — nothing in the model could say so.
 */
import type maplibregl from "maplibre-gl";

import { LAYER_TOGGLES } from "./wallLegend";
import { satLayerId } from "../satellite/mountSatellite";
import { circuitFocus, notePaint, subscribeCircuits } from "../../shared/workMeter.svelte";

/** Start counting on idle; returns the stop fn. `satMounted` is the mount's live key set — photo layers are per pin and not in LAYER_TOGGLES.ids. */
export function watchPaint(
	map: maplibregl.Map,
	satMounted: () => ReadonlySet<string>,
): () => void {
	const count = (): void => {
		const view = map.getBounds();
		for (const t of LAYER_TOGGLES) {
			let n = 0;
			if (t.key === "sat") {
				// While a pin is focused, only ITS photo counts — an old photo elsewhere in
				// the viewport turned the row green while the asked-for blob was still missing.
				const focus = circuitFocus();
				for (const key of satMounted()) {
					if (focus && key !== focus) continue;
					const id = satLayerId(key);
					const layer = map.getLayer(`${id}-l`);
					if (!layer || map.getLayoutProperty(`${id}-l`, "visibility") === "none") continue;
					if (!map.isSourceLoaded(id)) continue;
					const coords = (map.getSource(id) as maplibregl.ImageSource | undefined)?.coordinates;
					if (coords && overlaps(coords, view)) n++;
				}
			} else {
				// Only layers that exist in the style — queryRenderedFeatures throws on an unknown id, and `fires` has none on this route.
				const present = t.ids.filter((id) => map.getLayer(id));
				n = present.length ? map.queryRenderedFeatures(undefined, { layers: present }).length : 0;
			}
			notePaint(t.key, t.feed, n);
		}
	};
	map.on("idle", count);
	// Bytes landing on an already-idle map would never be re-counted — nudge a frame so idle fires again.
	const unsub = subscribeCircuits((c) => {
		if (c.state === "ok") map.triggerRepaint();
	});
	if (map.loaded()) count();
	return () => {
		map.off("idle", count);
		unsub();
	};
}

function overlaps(coords: number[][], view: maplibregl.LngLatBounds): boolean {
	const lngs = coords.map((c) => c[0]);
	const lats = coords.map((c) => c[1]);
	return (
		Math.max(...lngs) >= view.getWest() &&
		Math.min(...lngs) <= view.getEast() &&
		Math.max(...lats) >= view.getSouth() &&
		Math.min(...lats) <= view.getNorth()
	);
}
