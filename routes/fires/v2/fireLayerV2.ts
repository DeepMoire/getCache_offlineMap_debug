/**
 * fireLayerV2 — the wildfire layer.
 *
 * PAINT IS `setData` AND NOTHING ELSE. No geometry on the paint path, ever —
 * the Worker did that work (`fireFetchV2.ts`). Reintroducing a union, a hull or
 * a clone here is what made v1 unusable.
 *
 * Layer ids, colours, zoom gates, cluster aggregation and the tap card must
 * stay indistinguishable from v1 — a planter cannot be able to tell which
 * version is running. Every constant below was tuned against a field complaint.
 */

import type * as mapboxgl from "mapbox-gl";
import {
	fireDiscIndex,
	type FireDiscV2,
	fireDiscKey,
	readFireDisc,
} from "./fireCacheV2";
import { beginWork } from "../../../lib/shared/workMeter.svelte";
import { kmBetween } from "../../../lib/shared/kmGeo";
import { vlog } from "../../../lib/shared/verboseLog";

/** Layer + source ids. One set per map, so the two maps never collide. */
export interface FireLayerV2Ids {
	readonly src: string;
	readonly cluster: string;
	readonly clusterIcon: string;
	readonly flame: string;
	readonly outlineSrc: string;
	readonly outline: string;
}

export const ONLINE_FIRE_V2_IDS: FireLayerV2Ids = {
	src: "rt2-fire-geo",
	cluster: "rt2-fire-cluster",
	clusterIcon: "rt2-fire-cluster-count",
	flame: "rt2-fire-flame-single",
	outlineSrc: "rt2-fire-outline-geo",
	outline: "rt2-fire-outline",
};

export const OFFLINE_FIRE_V2_IDS: FireLayerV2Ids = {
	src: "v42-fire-geo",
	cluster: "v42-fire-cluster",
	clusterIcon: "v42-fire-cluster-count",
	flame: "v42-fire-flame-single",
	outlineSrc: "v42-fire-outline-geo",
	outline: "v42-fire-outline",
};

/**
 * The outline is the most "fire app" looking thing on the map, so it gets the
 * strictest gate. z11 was tried and rejected: at survey zoom a screen of
 * scattered red polygons reads as pollution. 13 is block scale — where "is the
 * fire inside this line" is a question anyone is asking. Dots and clusters
 * carry the warning at every zoom, so nothing is lost by waiting.
 */
const OUTLINE_MIN_ZOOM = 13;

/** CONTEXT accent (--palette-terracotta). NEVER red: red is the
 *  destructive-action colour, and a hotspot is information, not a button. */
const FIRE_DOT = "#b36940";
/** The hot end of the intensity ramp — terracotta-hint. Still not red;
 *  severity is a warmer step within the same family. */
const FIRE_HOT = "#d18a5e";
/** The ONE red in this layer. Wildfire agencies (BC Wildfire included) draw
 *  boundaries in this colour; matching the convention is what makes the shape
 *  legible at a glance. */
const FIRE_OUTLINE_RED = "#d9422b";

/** The flame glyph, registered by the host map's icon loader under this name. */
const FIRE_ICON = "rt-fire-flame";

const EMPTY_FC: GeoJSON.FeatureCollection = {
	type: "FeatureCollection",
	features: [],
};

/**
 * How close a disc's centre must be to the camera for its data to be considered
 * "covering this view". Smaller than the 500 km radius on purpose: a disc whose
 * very edge grazes the viewport is not good coverage of what you are looking at.
 */
const FIRE_TRIGGER_KM = 150;

export interface AttachFireV2Options {
	readonly ids?: FireLayerV2Ids;
	/**
	 * FALSE for the offline viewer. The app-wide bake service owns every
	 * download; a second downloader racing it double-fetches and fights over the
	 * same cache entries.
	 */
	readonly canFetch?: boolean;
	/** Called after a paint that changed what is on screen, with the disc that
	 *  supplied it — lets a host show the freshness stamp. */
	readonly onPainted?: (disc: FireDiscV2 | null) => void;
}

export interface FireLayerV2Handle {
	(): void;
	/** Force a repaint from disk — for a legend toggle or a bake-generation bump. */
	repaint: () => void;
}

/**
 * Add the sources and layers. Idempotent — safe to call on every `style.load`,
 * which is required because a style change wipes every layer the app added.
 */
function addFireV2Layers(map: mapboxgl.Map, ids: FireLayerV2Ids): void {
	if (map.getSource(ids.src)) return;

	// ── OUTLINES ── added FIRST so the dots and clusters draw on top of it.
	map.addSource(ids.outlineSrc, { type: "geojson", data: EMPTY_FC });
	map.addLayer({
		id: ids.outline,
		type: "line",
		source: ids.outlineSrc,
		minzoom: OUTLINE_MIN_ZOOM,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			"line-color": FIRE_OUTLINE_RED,
			// Thin and UNFILLED: a filled shape reads as a surveyed perimeter. This
			// is a hull around satellite pixels; claiming more would be dishonest.
			"line-width": [
				"interpolate",
				["linear"],
				["zoom"],
				6,
				0.8,
				10,
				1.2,
				14,
				1.6,
			],
			// Fade in across one zoom level — a shape that pops into existence
			// reads as a glitch.
			"line-opacity": [
				"interpolate",
				["linear"],
				["zoom"],
				OUTLINE_MIN_ZOOM,
				0,
				OUTLINE_MIN_ZOOM + 1,
				0.85,
			],
		},
	});

	// ── DETECTIONS ── native Mapbox clustering, which runs in the GL worker.
	map.addSource(ids.src, {
		type: "geojson",
		data: EMPTY_FC,
		cluster: true,
		clusterRadius: 50,
		clusterMaxZoom: 11,
		// Clusters do not inherit properties — they must be aggregated explicitly.
		// MAX, never a sum: colour tracks the single worst fire inside, so many
		// mild fires cannot make a cluster read as an inferno.
		clusterProperties: {
			// Industrial FRP is excluded from the heat: a flare stack burning at a
			// steady 40 MW must not colour the wildfire beside it.
			maxFrp: [
				"max",
				[
					"case",
					["==", ["coalesce", ["get", "ind"], 0], 1],
					0,
					["coalesce", ["get", "frp"], 0],
				],
			],
			// How many members are industrial — lets an entirely-industrial cluster
			// dim itself rather than masquerade as a fire.
			indCount: ["+", ["coalesce", ["get", "ind"], 0]],
		},
	});

	// Gentle growth with count: "a lot over there", never a hazard banner over
	// the block. Capped at 15 px / 0.55 so terrain, roads and the user's pins
	// read straight through — a wider ramp swallows whole valleys at regional
	// zoom and the map stops looking like a planting app. The COUNT carries
	// magnitude; the circle does not have to shout it too.
	map.addLayer({
		id: ids.cluster,
		type: "circle",
		source: ids.src,
		filter: ["has", "point_count"],
		paint: {
			"circle-color": [
				"interpolate",
				["linear"],
				["coalesce", ["get", "maxFrp"], 0],
				0,
				FIRE_DOT,
				200,
				FIRE_HOT,
			],
			"circle-radius": [
				"interpolate",
				["linear"],
				["get", "point_count"],
				2,
				7,
				25,
				11,
				200,
				15,
			],
			"circle-opacity": 0.55,
		},
	});

	// The flame INSIDE a cluster circle — so a cluster and a lone fire speak one
	// visual language rather than dots-vs-flames.
	map.addLayer({
		id: ids.clusterIcon,
		type: "symbol",
		source: ids.src,
		filter: ["has", "point_count"],
		layout: {
			"icon-image": FIRE_ICON,
			"icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.18, 12, 0.3],
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
		},
	});

	// Lone detections, above clusterMaxZoom.
	map.addLayer({
		id: ids.flame,
		type: "symbol",
		source: ids.src,
		filter: ["!", ["has", "point_count"]],
		layout: {
			"icon-image": FIRE_ICON,
			"icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.16, 14, 0.34],
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
		},
		paint: {
			// Dimmed, never hidden — suppressing outright is a claim a satellite
			// pixel cannot support. For a hazard, fail toward SHOWING.
			"icon-opacity": [
				"case",
				["==", ["coalesce", ["get", "ind"], 0], 1],
				0.35,
				1,
			],
		},
	});
}

/**
 * Three `setData` calls and nothing else. Metered so the WORK panel counts fire
 * paints. Returns the disc that supplied the pixels, or null when none is cached.
 */
async function paintV2(
	map: mapboxgl.Map,
	ids: FireLayerV2Ids,
	center: readonly [number, number],
	isLive: () => boolean,
): Promise<FireDiscV2 | null> {
	const done = beginWork("fire paint");
	try {
		const disc = await readFireDisc(fireDiscKey(center));
		// A route change can dispose the map while the IndexedDB read is in flight,
		// so the guard taken on ENTRY is stale here:
		//   TypeError: Cannot read properties of undefined (reading 'getOwnSource')
		// Re-check liveness AFTER every await, never before.
		if (!isLive()) return null;
		const src = map.getSource(ids.src) as mapboxgl.GeoJSONSource | undefined;
		const outlineSrc = map.getSource(ids.outlineSrc) as
			| mapboxgl.GeoJSONSource
			| undefined;
		if (!src || !outlineSrc) return null;

		if (!disc) {
			// NEVER clear on "no disc yet" — an empty layer is indistinguishable
			// from "no fires near you". Leave whatever is already drawn; a real
			// disc replaces it the moment one lands.
			return null;
		}

		// Parsing a stored string yields a plain object with no `$state` proxies,
		// which is what the GL worker boundary needs — a proxy corrupts the
		// transfer and the features silently vanish.
		src.setData(JSON.parse(disc.pointsJson) as GeoJSON.FeatureCollection);
		outlineSrc.setData(
			JSON.parse(disc.outlinesJson) as GeoJSON.FeatureCollection,
		);
		return disc;
	} catch (err) {
		done(true);
		throw err;
	} finally {
		done(); // no-op if the catch above already closed it
	}
}

/**
 * Attach the v2 fire layer to a map. Returns a disposer that is also callable
 * as `.repaint()`.
 */
export function attachFireLayerV2(
	map: mapboxgl.Map,
	opts: AttachFireV2Options = {},
): FireLayerV2Handle {
	const ids = opts.ids ?? ONLINE_FIRE_V2_IDS;
	const canFetch = opts.canFetch !== false;
	let disposed = false;
	/** The ONE liveness answer, handed to every async that can outlive the map.
	 *  Never probe the map itself for this — a disposed map throws on access. */
	const isLive = (): boolean => !disposed;

	const ensure = async (): Promise<void> => {
		if (!isLive()) return;
		addFireV2Layers(map, ids);
		const c = map.getCenter();
		const centre: [number, number] = [c.lng, c.lat];

		// Which stored disc covers where we are LOOKING? Answer from the LIGHT
		// index — centres and times only. Loading full records to decide this cost
		// 616 MB.
		const index = await fireDiscIndex();
		if (!isLive()) return;
		let best: { key: string; center: readonly [number, number] } | null = null;
		let bestKm = Number.POSITIVE_INFINITY;
		for (const d of index) {
			// The only distance arithmetic left on this path, and it must stay
			// bounded by the DISC count — per (detection × disc) measured 7,982 ms.
			const km = kmBetween(centre, [d.center[0], d.center[1]]);
			if (km < bestKm && km < FIRE_TRIGGER_KM) {
				bestKm = km;
				best = d;
			}
		}

		const disc = await paintV2(map, ids, best?.center ?? centre, isLive);
		if (!isLive()) return;
		opts.onPainted?.(disc);

		// Pure viewer: painting from disk is the whole job.
		if (!canFetch) return;
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			vlog("fire", "offline — showing cached disc, no fetch attempted");
			return;
		}
		// No fetch here by design: the bake service owns every download, and a map
		// that downloads races it.
	};

	void ensure();
	const onStyle = (): void => void ensure();
	const onMove = (): void => void ensure();
	map.on("style.load", onStyle);
	map.on("moveend", onMove);

	const handle = (): void => {
		disposed = true;
		map.off("style.load", onStyle);
		map.off("moveend", onMove);
	};
	handle.repaint = (): void => void ensure();
	return handle as FireLayerV2Handle;
}
