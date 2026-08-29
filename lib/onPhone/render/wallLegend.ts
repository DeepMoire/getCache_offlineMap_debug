/** wallLegend.ts — layer TOGGLES and colour KEY. ⚠️ Ids here must match wallStyle.ts / wallLabels.ts — offlineLaws.test.ts checks every id exists in the stack, so a rename fails the build instead of silently disabling a switch. */

import {
	PATH_LINE,
	RAIL_LINE,
	ROAD_LINE,
	ROAD_MAJOR_LINE,
} from "./offlineColors";

/** One switch in MapDrawControls' BASEMAP popover. */
export interface LayerToggle {
	readonly key: string;
	readonly label: string;
	readonly ids: readonly string[];
	/** HOW this layer is drawn, in one or two words, shown greyed beside the label. */
	readonly hint?: string;
	/** WHICH DOWNLOAD this layer draws from — the circuit key in workMeter.svelte.ts whose circle the CONFIG row shows; roads, labels, places and hospitals all share `pack`. */
	readonly feed?: "sat" | "pack" | "fires";
}

/** The on/off switches, in render order. "sat"'s "v4-sat" id is a stand-in, not a real layer — per-pin photo layers (v4-sat-<key>-l) are mounted dynamically, so the page sweeps every v4-sat-* layer when this key toggles. */
export const LAYER_TOGGLES: readonly LayerToggle[] = [
	{ key: "sat", label: "Satellite", ids: ["v4-sat"], hint: "always on", feed: "sat" },
	{
		key: "vector",
		label: "Roads/water",
		ids: [
			"v4-roads",
			"v4-path",
			"v4-rail",
			"v4-rail-ties",
		],
		hint: "always on",
		feed: "pack",
	},
	{
		key: "labels",
		label: "Labels",
		ids: ["v4-town-label", "v4-road-label"],
		hint: "pyramid",
		feed: "pack",
	},
	// ⚠️ Places sits above Hospitals — order is by field priority, not mechanism (see the hint column for that).
	{ key: "camps", label: "Places", ids: ["v4-poi-camp"], hint: "cluster", feed: "pack" },
	{ key: "hospitals", label: "Hospitals", ids: ["v4-poi-hospital"], hint: "pyramid", feed: "pack" },
	// Fires' ids is empty on purpose — no v4-fire* layer exists yet, so toggling this row is a no-op. Wire the real ids in here when attachFireLayer() lands — don't add a second fires entry.
	{ key: "fires", label: "Fires", ids: [], hint: "cluster", feed: "fires" },
] as const;

/** Toggle keys `resetLayersAllOn()` must NOT force back on. Empty here — every row in LAYER_TOGGLES defaults on. */
export const OPT_IN_LAYERS: readonly string[] = [];

/** A row in the read-only colour key — the swatch matches how the feature renders: solid line for roads, dashed for trails, rail hatch for railways, filled chip for water bodies. */
export interface LegendEntry {
	label: string;
	color: string;
	swatch: "line" | "dashed" | "fill" | "rail";
}

/** Only what this map actually paints. Land cover is absent on purpose — those fills carry unapproved placeholder hexes (Law 4); add the rows only when the real hexes land. */
export const LEGEND: readonly LegendEntry[] = [
	{ label: "Roads", color: ROAD_LINE, swatch: "line" },
	{ label: "Major roads / highways", color: ROAD_MAJOR_LINE, swatch: "line" },
	{ label: "Trails / paths", color: PATH_LINE, swatch: "dashed" },
	{ label: "Railways", color: RAIL_LINE, swatch: "rail" },
] as const;
