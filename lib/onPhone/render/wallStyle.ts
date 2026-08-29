/** wallStyle.ts — the wall map's layer stack. wallLayers() returns the layers to add, bottom-first, already in paint order — a pure function of nothing, returning plain specs. ⛔ Never split this into multiple sources per zoom band: hand-written bands (wide/ring/mid/core) went out of sync at their boundaries and painted zero layers with no console error — one source spanning every stored zoom is the whole fix, so no zoom number belongs in this file. */

import type * as mapboxgl from "maplibre-gl";

import {
	PATH_LINE,
	RAIL_LINE,
	ROAD_LINE,
	ROAD_MAJOR_LINE,
} from "./offlineColors";
import {
	RAW_SOURCE,
} from "../roads/rawWallProtocol";

/** The layer per-area satellite photos mount BEFORE — directly under the roads, directly over the water fill. */
export const SAT_INSERT_BEFORE = "v4-roads";

/** ONE WIDTH FOR EVERY ROAD KIND. Colour is the only hierarchy — highways/majors in rust, everything else the owned brown; the low-zoom floor keeps rural roads visible from z7-8. */
const ROAD_WIDTH: mapboxgl.ExpressionSpecification = [
	"interpolate",
	["linear"],
	["zoom"],
	6,
	0.85,
	9,
	1.1,
	12,
	1.35,
	16,
	1.7,
];

/** ⚠️ Two colours, by road `kind`, NEVER by zoom — a given road must be the same colour at every zoom. Never put `["zoom"]` in this expression or restore per-level reads from the archive; either one brings back roads visibly shifting colour as you zoom (Protomaps thins minor roads at shallow levels). */
const ROAD_COLOR: mapboxgl.ExpressionSpecification = [
	"match",
	["get", "kind"],
	["major_road", "highway"],
	ROAD_MAJOR_LINE,
	ROAD_LINE,
];

/** Roads only — `path`, `rail` and `aeroway` each render elsewhere (or not at all), so every road layer excludes them identically. */
const ROADS_ONLY: mapboxgl.FilterSpecification = [
	"match",
	["get", "kind"],
	["rail", "aeroway", "path"],
	false,
	true,
];



/** The whole wall-map stack, bottom-first, in paint order. ⚠️ EARTH (the landmass polygon) is deliberately NOT here — Protomaps' `earth` clips to coarse z12 tile rectangles, so on the download frontier a fill reads as ugly dark blocks, worse than no base at all. */
export function wallLayers(): mapboxgl.LayerSpecification[] {
	return [
		// ⚠️ Land cover is OFF and its fill hexes are only PLACEHOLDERs (Law 4, never signed off) — do not restore either without picking real colours with the user first.
		// ⛔ Water layer removed — the pack no longer ships a "water" layer; it made the Worker build exceed the client's fetch timeout. ⚠️ It previously came from a 5 km radius, not 30 — measure the real cost before restoring at 30 km.
		// ⛔ Do not give this source a wider radius than the ring's — three builds did, and it read on screen as a second, bigger shape appearing and vanishing.
		// THE ROADS — one layer, one source, no zoom window; the source's own span already says which levels exist, and MapLibre overzooms above the deepest one for free.
		{
			id: "v4-roads",
			type: "line",
			source: RAW_SOURCE,
			"source-layer": "roads",
			filter: ROADS_ONLY,
			paint: { "line-color": ROAD_COLOR, "line-width": ROAD_WIDTH },
		} as mapboxgl.LayerSpecification,

		// PATH — sage-green with a fine dash so a footpath or logging track reads as a trail, not a road.
		{
			id: "v4-path",
			type: "line",
			source: RAW_SOURCE,
			"source-layer": "roads",
			filter: ["==", ["get", "kind"], "path"],
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": PATH_LINE,
				"line-width": ROAD_WIDTH,
				"line-dasharray": [1.5, 1.5],
			},
		} as mapboxgl.LayerSpecification,
		{
			id: "v4-rail",
			type: "line",
			source: RAW_SOURCE,
			"source-layer": "roads",
			filter: ["==", ["get", "kind"], "rail"],
			layout: { "line-cap": "butt", "line-join": "round" },
			paint: {
				"line-color": RAIL_LINE,
				"line-width": [
					"interpolate",
					["linear"],
					["zoom"],
					6,
					0.55,
					12,
					0.95,
					16,
					1.25,
				],
			},
		} as mapboxgl.LayerSpecification,
		{
			id: "v4-rail-ties",
			type: "line",
			source: RAW_SOURCE,
			"source-layer": "roads",
			filter: ["==", ["get", "kind"], "rail"],
			layout: { "line-cap": "butt", "line-join": "round" },
			paint: {
				"line-color": RAIL_LINE,
				// ~3.5x the spine width; short dash + big gap → one crosstie every ~3 tie-widths along the rail.
				"line-width": [
					"interpolate",
					["linear"],
					["zoom"],
					6,
					2.0,
					12,
					3.4,
					16,
					4.4,
				],
				"line-dasharray": [0.3, 2.6],
			},
		} as mapboxgl.LayerSpecification,

	];
}

/** Every layer id this module owns, for the page's visibility toggles and teardown — derived from wallLayers() so it cannot drift from the stack. */
export function wallLayerIds(): string[] {
	return wallLayers().map((l) => l.id);
}
