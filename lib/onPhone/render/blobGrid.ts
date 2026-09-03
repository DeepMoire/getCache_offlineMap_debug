/**
 * blobGrid.ts — THE GHOST GRID (direction2.5).
 *
 * One white square per pin: the BOUNDING BOX of the tileset that pin
 * generates. The downloader reads `radiusBox` — the GRID_RADIUS_KM box
 * around the anchor — so THAT is the footprint crossing z8 reveals, and
 * painting the same function means the grid can never disagree with the
 * generated data. (Not the z8 tiles of `cellsFor`: those are just the
 * ADDRESS the blob is framed to — a pin near a tile edge pulls in 100+ km
 * neighbours, and the grid read as a huge regular tile grid, not as the
 * pin's footprint.)
 *
 * Pins whose boxes are identical dedupe — one square, not two stacked.
 *
 * Pure geometry: no map, no state. The page collects the pin anchors, calls
 * `blobGridFeatures`, and hands the FeatureCollection to the
 * `BLOB_GRID_SOURCE` geojson source; the layer that paints it lives at the
 * BOTTOM of `wallLayers()` (wallStyle.ts), under every tileset layer.
 */

import { radiusBox } from "../../contract/grid";

/** The ghost grid's source id — shared by the page (addSource/setData) and
 *  wallStyle.ts (the layer spec), so the two cannot drift. */
export const BLOB_GRID_SOURCE = "v4-blob-grid";

/** The radius-box square per pin — the bbox of the tileset each generates. */
export function blobGridFeatures(
	anchors: ReadonlyArray<readonly [number, number]>,
): GeoJSON.FeatureCollection {
	const seen = new Set<string>();
	const features: GeoJSON.Feature[] = [];
	for (const [lng, lat] of anchors) {
		const b = radiusBox(lng, lat);
		// Stable dedup key on the exact box — two pins, two tilesets, but the
		// SAME box (identical anchor) is one square. Neighbouring pins keep
		// their own slightly-offset squares: they are different tilesets.
		const key = `${b.w.toFixed(6)},${b.s.toFixed(6)},${b.e.toFixed(6)},${b.n.toFixed(6)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		features.push({
			type: "Feature",
			properties: { box: key },
			geometry: {
				type: "Polygon",
				// Closed ring — W→E along the south edge, back along the
				// north. MapLibre does not care about winding; the closure
				// (first point == last point) it does.
				coordinates: [
					[
						[b.w, b.s],
						[b.e, b.s],
						[b.e, b.n],
						[b.w, b.n],
						[b.w, b.s],
					],
				],
			},
		});
	}
	return { type: "FeatureCollection", features };
}
