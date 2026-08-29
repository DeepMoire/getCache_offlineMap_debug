import type * as mapboxgl from "mapbox-gl";
import {
	ROAD_LINE,
	WATER_FILL,
	WATER_LINE,
} from "./offlineColors";

/** Root of the bundled Natural Earth vector tile pyramid — fully airgapped, same-origin; raw source GeoJSON lives at /mobileAssets/worldBase/base/min/, input to scripts/build-world-base-tiles.mjs (no longer loaded at runtime). */
const BASE_TILES = "/mobileAssets/worldBase/base/tiles";

// ⛔ COLOURS ARE USER-OWNED — never change any hex here without explicit permission; keep everything dark enough for imagery tiles to pop.
const C = {
	ocean: WATER_FILL, // background + lakes: dark dark blue (shared)
	land: "#15161b", //  faint dark-grey continental silhouette
	urban: "#212430", //  barely-there glow over big cities
	water: WATER_LINE, // river/lake line — shared blue (base = big = small)
	road: ROAD_LINE, //   roads — shared (base = big)
	border: "#2a2a31", // country borders: dimmest line
} as const;

/** Build the dark world-base style. */
export function buildOfflineBaseStyle(): mapboxgl.StyleSpecification {
	return {
		version: 8,
		// Glyphs are bundled locally & served same-origin (Noto Sans Regular, Latin+accents) — never point this at a remote endpoint, it'd break the air-gap (LAW 0). No sprite; icons load via map.loadImage.
		glyphs: "/mobileAssets/worldBase/glyphs/{fontstack}/{range}.pbf",
		sources: {
			// maxzoom: 6 is the deepest tile that EXISTS, not a display limit — Mapbox overzooms beyond it, so the base renders all the way in.
			// ⚠️ Keep this URL RELATIVE, not `${location.origin}${BASE_TILES}` — reading `location` at module scope breaks vitest collection (silently reports "0 tests", not a failure).
			"world-base": {
				type: "vector",
				tiles: [`${BASE_TILES}/{z}/{x}/{y}.pbf`],
				minzoom: 0,
				maxzoom: 6,
			},
		},
		layers: [
			// 1) Ocean = the whole canvas. Land/lakes paint over it.
			{
				id: "ocean-bg",
				type: "background",
				paint: { "background-color": C.ocean },
			},
			// 2) Land silhouette — faint dark-grey; one constant colour at every zoom (never changes).
			{
				id: "land-fill",
				type: "fill",
				source: "world-base",
				"source-layer": "land",
				paint: { "fill-color": C.land },
			},
			// 3) Urban glow — a touch lighter than land, very subtle.
			{
				id: "urban-fill",
				type: "fill",
				source: "world-base",
				"source-layer": "urban",
				paint: { "fill-color": C.urban, "fill-opacity": 0.55 },
			},
			// 4) Lakes = water tone punched back through the land.
			{
				id: "lakes-fill",
				type: "fill",
				source: "world-base",
				"source-layer": "lakes",
				paint: { "fill-color": C.ocean },
			},
			// 5) Country borders — dimmest line, dashed.
			{
				id: "admin-line",
				type: "line",
				source: "world-base",
				"source-layer": "admin",
				paint: {
					"line-color": C.border,
					"line-width": 0.5,
					"line-dasharray": [3, 3],
				},
			},
			// 6) Roads — density-aware like city labels: each shows once zoom >= min_zoom − LEAD, so major highways read far out and lesser roads fill in as you zoom.
			{
				id: "roads-line",
				type: "line",
				source: "world-base",
				"source-layer": "roads",
				// ⛔ NO maxzoom here — capping it made the base map vanish past z8 (tried & reverted); fix style clashes via colour matching, never by deleting the base.
				// LEAD=4 here: a min_zoom-6 highway shows from z2, min_zoom-9 from z5 — major highways read far out.
				filter: [
					">=",
					["zoom"],
					["-", ["coalesce", ["get", "min_zoom"], 9], 4],
				],
				paint: {
					// Base roads stay a quiet dark tone — deliberately: the downloaded BLOB roads are the ones carrying navigation detail.
					"line-color": C.road,
					// Expressways heavier; all stay thin enough not to eat the landscape.
					"line-width": [
						"interpolate",
						["linear"],
						["zoom"],
						4,
						["match", ["get", "expressway"], 1, 1.4, 1.0],
						9,
						["match", ["get", "expressway"], 1, 2.0, 1.4],
						14,
						["match", ["get", "expressway"], 1, 2.6, 1.8],
					],
				},
			},
			// 7) Rivers + lake shores — the one blue that reads in the dark; constant width, no zoom expression.
			{
				id: "rivers-line",
				type: "line",
				source: "world-base",
				"source-layer": "rivers",
				// NO maxzoom — the blob ships no water at all, so this base river is the ONLY water on screen; capping it deletes all water in the app.
				paint: {
					"line-color": C.water,
					"line-width": 1,
				},
			},
			// Lake outlines in the same blue so big lakes read as water at all zooms.
			{
				id: "lakes-line",
				type: "line",
				source: "world-base",
				"source-layer": "lakes",
				paint: { "line-color": C.water, "line-width": 0.6 },
			},
			// 8) City labels — zoom-gated on effective rank = min(scalerank − 2×capital, population-derived rank); collision (text-allow-overlap:false) thins dense regions.
			// ⚠️ THE POPULATION HALF IS LOAD-BEARING — don't simplify it away; scalerank alone silently erases the Canadian interior (Kamloops/Kelowna) since NE ranks it more coarsely outside the US.
			{
				id: "place-label",
				type: "symbol",
				source: "world-base",
				"source-layer": "places",
				filter: [
					"<=",
					[
						"min",
						["-", ["get", "s"], ["*", 2, ["coalesce", ["get", "c"], 0]]],
						[
							"step",
							["coalesce", ["get", "p"], 0],
							8, // < 3k
							3000, 7,
							10000, 6,
							20000, 5,
							50000, 4,
							100000, 3,
							300000, 2,
							1000000, 1,
						],
					],
					// Ramps rank one at a time per zoom step, so a zoomed-out view doesn't dump ~35 names at once.
					["step", ["zoom"], 1, 5, 2, 6, 3, 7, 4, 8, 6, 9, 8],
				],
				layout: {
					"text-field": ["get", "n"],
					"text-font": ["Noto Sans Regular"],
					// Keyed on the SAME effective rank as the filter/sort-key above — using raw scalerank here would draw population-rescued cities (e.g. Kelowna) too small.
					"text-size": [
						"interpolate",
						["linear"],
						[
							"min",
							["-", ["get", "s"], ["*", 2, ["coalesce", ["get", "c"], 0]]],
							[
								"step",
								["coalesce", ["get", "p"], 0],
								8,
								3000, 7,
								10000, 6,
								20000, 5,
								50000, 4,
								100000, 3,
								300000, 2,
								1000000, 1,
							],
						],
						0,
						12,
						5,
						9.5,
						10,
						8,
					],
					// MUST use the same effective rank as the filter/text-size above — mismatched, a population-admitted city loses collision to a lower one, reintroducing the bug the filter fixed.
					"symbol-sort-key": [
						"min",
						["-", ["get", "s"], ["*", 2, ["coalesce", ["get", "c"], 0]]],
						[
							"step",
							["coalesce", ["get", "p"], 0],
							8,
							3000, 7,
							10000, 6,
							20000, 5,
							50000, 4,
							100000, 3,
							300000, 2,
							1000000, 1,
						],
					],
					"text-allow-overlap": false,
					"text-padding": 6,
					"text-anchor": "center",
					"text-max-width": 7,
				},
				paint: {
					"text-color": "#85806f", // dim warm grey — subtle orientation anchors (bright white "hurt")
					"text-halo-color": C.ocean, // halo = the map background, for legibility
					"text-halo-width": 1.4,
					"text-halo-blur": 0.4,
				},
			},
			// 9) Highway name labels — ride the road, gated on NE's min_label (LEAD 3), whole NE roads so line-placement has long lines even zoomed out.
			{
				id: "road-label",
				type: "symbol",
				source: "world-base",
				"source-layer": "roads",
				filter: [
					"all",
					["has", "name"],
					[">=", ["zoom"], ["-", ["coalesce", ["get", "min_label"], 11], 3]],
				],
				layout: {
					"symbol-placement": "line",
					"text-field": ["get", "name"],
					"text-font": ["Noto Sans Regular"],
					"text-size": ["interpolate", ["linear"], ["zoom"], 5, 9, 10, 11, 14, 12],
					"symbol-sort-key": ["coalesce", ["get", "min_label"], 11],
					"symbol-spacing": 300,
					"text-allow-overlap": false,
					"text-padding": 4,
				},
				paint: {
					"text-color": "#85806f", // dull warm grey — matches city labels (was too gold)
					"text-halo-color": C.ocean,
					"text-halo-width": 1.6,
					"text-halo-blur": 0.4,
				},
			},
		],
	} as mapboxgl.StyleSpecification;
}
