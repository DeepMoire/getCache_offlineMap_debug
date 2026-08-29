/** wallLabels.ts — TEXT + POI ICONS. Font stack must be read live via glyphStack(map), never hardcoded — a mismatch 404s the glyph range forever and the label silently never draws. */

import type * as mapboxgl from "maplibre-gl";

import { glyphStack } from "../../shared/glyphStack";

import { RAW_SOURCE } from "../roads/rawWallProtocol";

/** Warm off-white TOWN labels — the loud ones. */
const LABEL_COLOR = "#ece7da";
/** Road names sit on the roads, so go much quieter than town labels — avoids reading as harsh white scribble over the linework. */
const ROAD_LABEL_COLOR = "#8c887e";
/** Dark halo (≈ the map background) for legibility. */
const LABEL_HALO = "#05101f";

/** ⚠️ Takes the map so the font stack is read from the LIVE style, never hardcoded — the two maps' glyph endpoints are DISJOINT, so a literal is wrong on one map and 404s the glyph range forever. */
export function wallLabelLayers(
	map: mapboxgl.Map,
): mapboxgl.LayerSpecification[] {
	// ⚠️ glyphStack(map) must stay inlined at each font site, not hoisted to a const — glyphStacks.test.ts scans for a literal right after the font key and a hoisted const reads as one, failing the build.
	return [
		// NOTE: "places" lives on the z12 RING tiles, not the core — pointing a layer at a ring lacking its source-layer renders nothing, silently.
		{
			id: "v4-town-label",
			type: "symbol",
			source: RAW_SOURCE,
			"source-layer": "places",
			filter: [
				"all",
				["has", "name"],
				[
					">=",
					["zoom"],
					[
						"match",
						["get", "kind"],
						"city",
						0,
						"town",
						6,
						"village",
						8,
						"hamlet",
						10,
						99,
					],
				],
			],
			layout: {
				"text-field": ["coalesce", ["get", "name"], ["get", "name:en"], ""],
				"text-font": glyphStack(map as never),
				"text-size": [
					"match",
					["get", "kind"],
					"city",
					18,
					"town",
					15,
					"village",
					12,
					"hamlet",
					10,
					11,
				],
				// Lower sort-key wins collision → bigger places first.
				"symbol-sort-key": [
					"match",
					["get", "kind"],
					"city",
					0,
					"town",
					1,
					"village",
					2,
					"hamlet",
					3,
					4,
				],
				"text-anchor": "center",
				"text-allow-overlap": false,
				"text-padding": 8,
			},
			paint: {
				"text-color": LABEL_COLOR,
				"text-halo-color": LABEL_HALO,
				"text-halo-width": 1.6,
				"text-halo-blur": 0.4,
			},
		} as mapboxgl.LayerSpecification,

		// ⚠️ Highways are excluded here — road-label (world base) already draws them; both firing would double-label every highway.
		{
			id: "v4-road-label",
			type: "symbol",
			source: RAW_SOURCE,
			"source-layer": "roads",
			minzoom: 4,
			filter: [
				"all",
				["has", "name"],
				["match", ["get", "kind"], ["highway", "major_road"], false, true],
				[
					">=",
					["+", ["zoom"], ["step", ["zoom"], 7, 9, 5, 12, 4]],
					["coalesce", ["get", "min_zoom"], 14],
				],
			],
			layout: {
				"symbol-placement": "line",
				"text-field": ["get", "name"],
				"text-font": glyphStack(map as never),
				// Prominent roads (LOW min_zoom) sort first → win collision.
				"symbol-sort-key": ["coalesce", ["get", "min_zoom"], 14],
				"text-size": [
					"interpolate",
					["linear"],
					["zoom"],
					5,
					9.5,
					10,
					11,
					14,
					12,
				],
				"text-allow-overlap": false,
				// ⚠️ symbol-spacing (screen px, on-line) is the crowding dial — raise if crowded, lower if roads go unnamed; don't reach for text-padding, it steals space from city labels too.
				// ⛔ symbol-spacing does not support data expressions (e.g. match on kind) — MapLibre throws "data expressions not supported" from addLayer, aborting every layer added after it and silently breaking the whole map.
				"symbol-spacing": 400,
				"text-padding": 6,
			},
			paint: {
				"text-color": ROAD_LABEL_COLOR,
				"text-halo-color": LABEL_HALO,
				"text-halo-width": 1.6,
				"text-halo-blur": 0.4,
			},
		} as mapboxgl.LayerSpecification,
	];
}

/** Label layer ids the page raises above freshly-mounted photos — includes the world base's own two. */
export const LABEL_LAYER_IDS = [
	"v4-road-label",
	"road-label",
	"v4-town-label",
	"place-label",
];

/** POI icons: [image name, same-origin URL]. */
const POI_ICONS: ReadonlyArray<readonly [string, string]> = [
	["v4-icon-hospital", "/mobileAssets/hospitalPin.webp"],
	["v4-icon-camp", "/mobileAssets/camp_public_pin.webp"],
];

/** Mounts POI symbol layers; awaits image loads so a slow icon load never delays the synchronous road layers. */
export async function addWallPois(map: mapboxgl.Map): Promise<void> {
	// Must use the Promise form of loadImage — MapLibre silently ignores a callback param, so a promise wrapped around it never settles; the result is a GetResourceResponse wrapper, the image is on `.data`.
	const loadIcon = async (url: string) => {
		try {
			return (await map.loadImage(url)).data;
		} catch (err) {
			console.warn(`[wall] POI icon load failed: ${url}`, err);
			return null;
		}
	};

	for (const [name, url] of POI_ICONS) {
		if (map.hasImage(name)) continue;
		const data = await loadIcon(url);
		if (data && !map.hasImage(name)) map.addImage(name, data);
	}

	const poiLayer = (
		id: string,
		kind: string,
		icon: string,
		size: number,
		minzoom?: number,
	): void => {
		if (map.getLayer(id)) return;
		map.addLayer({
			id,
			type: "symbol",
			source: RAW_SOURCE,
			"source-layer": "pois",
			filter: ["==", ["get", "kind"], kind],
			...(minzoom != null ? { minzoom } : {}),
			layout: {
				"icon-image": icon,
				"icon-size": size,
				"icon-allow-overlap": false,
				// ⛔ icon-anchor must be "bottom" (the pin's tip), never the default "center" — center anchoring made pins visibly drift across the ground while zooming, since the fixed pixel gap covers different real-world distances at each zoom.
				"icon-anchor": "bottom",
			},
		} as mapboxgl.LayerSpecification);
	};

	poiLayer("v4-poi-hospital", "hospital", "v4-icon-hospital", 0.47);
	// Camp only from z10 up — too noisy when zoomed out.
	poiLayer("v4-poi-camp", "camp_site", "v4-icon-camp", 0.23, 10);
}

/** POI layer ids, for the page's visibility toggles and teardown. */
export const POI_LAYER_IDS = ["v4-poi-hospital", "v4-poi-camp"];
