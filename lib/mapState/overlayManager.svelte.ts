import type { Map as MapboxMap } from "mapbox-gl";
import type {
	MapHostFeature as MapSessionFeature,
	MapHostPorts,
	MapHostStore as MapStore,
} from "../shared/mapHostPorts";
import { overlayOpacity } from "./overlayOpacity.svelte";
import { overlayVisibility } from "./overlayVisibility.svelte";
import type { Coord } from "$parent/siblings/getCache_OnlineMap/lib/coord";
import { toCoord } from "$parent/siblings/getCache_OnlineMap/lib/coord";

/** Mapbox corner order [TL,TR,BR,BL]; a null slot means non-finite/out-of-range input (NaN defence) — caller skips the overlay. */
type OverlayQuad = [Coord | null, Coord | null, Coord | null, Coord | null];

/** Axis-aligned quad from a `[w,s,e,n]` bbox (the default placement). */
function boundsToQuad(
	bounds: [number, number, number, number] | null,
): OverlayQuad {
	if (!bounds) return [null, null, null, null];
	const [w, s, e, n] = bounds;
	return [toCoord(w, n), toCoord(e, n), toCoord(e, s), toCoord(w, s)];
}

/** True-quad placement from stored 4 corners `[[lng,lat]×4]` (`[TL,TR,BR,BL]`); null → caller falls back to the bbox. */
function overlayCornersToQuad(
	corners: MapSessionFeature["overlayCorners"],
): OverlayQuad | null {
	if (!corners) return null;
	const [tl, tr, br, bl] = corners;
	return [
		toCoord(tl[0], tl[1]),
		toCoord(tr[0], tr[1]),
		toCoord(br[0], br[1]),
		toCoord(bl[0], bl[1]),
	];
}

const reportedLocalOverlayKeys = new Set<string>();

// Mirrors mobMapOverlay's IMAGE_SOURCE_ID — only the FIRST overlay mounts on this bare id; the no-blink swap path only ever targets that one.
const OVERLAY_SOURCE_ID = "map-overlay-image";

// Dedup key must cover EVERY overlay, not just the first — keying on the first alone let a second imported PDF silently never render.
export function overlayRenderCacheKey(
	mapKey: string | null,
	features: readonly Pick<
		MapSessionFeature,
		"mapFeatureKey" | "overlayStorageKey"
	>[],
): string {
	return `${mapKey ?? ""}|${features
		.map((f) => `${f.mapFeatureKey}:${f.overlayStorageKey ?? ""}`)
		.join(",")}`;
}

export interface OverlayManager {
	readonly activeOverlay: { name: string } | null;
	renderActiveMapOverlay(): Promise<void>;
	/** Call before renderActiveMapOverlay() after a style reload wipes the image source. */
	bustCache(): void;
	/** Run inside an `$effect`. */
	attachOpacity(): () => void;
	applyPdfVisibility(): void;
	/** Run inside an `$effect`. */
	attachActiveMapDispatch(): () => void;
	showWaiting(corners: readonly [Coord, Coord, Coord, Coord]): void;
	hideWaiting(): void;
}

export function createOverlayManager(
	getMap: () => MapboxMap | null,
	mapStore: MapStore,
	ports: Pick<MapHostPorts, "ui">,
): OverlayManager {
	const reportSwallowed = ports.ui.reportSwallowed;
	let activeOverlay = $state<{ name: string } | null>(null);

	// Returns EVERY overlay feature on the map, not just the first — was once a `.find()`, which silently dropped a second imported PDF.
	function activeOverlayFeatures(): MapSessionFeature[] {
		return (
			mapStore.activeMap?.features.filter(
				(f) => f.featureType === "overlay" && !!f.overlayStorageKey,
			) ?? []
		);
	}

	// The FIRST overlay always gets the bare (undefined) slot — the no-blink swap path and id-hardcoding plumbing rely on that.
	function overlaySlot(
		f: MapSessionFeature,
		index: number,
	): string | undefined {
		if (index === 0) return undefined;
		return f.mapFeatureKey.replace(/[^a-zA-Z0-9_-]/g, "");
	}

	let renderedOverlayKey: string | null = null;
	// Tracks the same-feature blob swap (no-blink updateImage) vs a map switch / new overlay (full re-render).
	let renderedOverlayMapKey: string | null = null;
	let renderedOverlayFeatureKey: string | null = null;
	// Count of overlays the last render mounted; a change here means added/removed and must fall through to a full re-render (the no-blink swap can't express it).
	let renderedOverlayCount = 0;

	async function renderActiveMapOverlay() {
		const m = getMap();
		if (!m) return;
		const targetMapKey = mapStore.activeMap?.mapKey ?? null;
		const features = activeOverlayFeatures();
		const overlay = await import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay");
		overlay.removeMapOverlay(m);
		activeOverlay = null;
		if (features.length === 0) return;
		// Mount feature 0 first — later sheets stack ABOVE earlier ones where they overlap (Mapbox: last-added wins at equal z).
		for (const [index, feature] of features.entries()) {
			if (!feature.overlayStorageKey || !feature.overlayBounds) continue;
			await mountOverlayFeature(
				m,
				overlay,
				feature,
				overlaySlot(feature, index),
				targetMapKey,
			);
			// Bail if the user switched maps mid-loop — don't paint a stale map's overlays onto the new one.
			if ((mapStore.activeMap?.mapKey ?? null) !== targetMapKey) return;
		}
		const first = features[0];
		activeOverlay = {
			name: first.featureName ?? first.overlayStorageKey ?? "",
		};
	}

	async function mountOverlayFeature(
		m: MapboxMap,
		overlay: typeof import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay"),
		feature: MapSessionFeature,
		slot: string | undefined,
		targetMapKey: string | null,
	) {
		const storageKey = feature.overlayStorageKey;
		if (!storageKey || !feature.overlayBounds) return;
		try {
			// Two render paths: `vtiles:<mapKey>` → vector tile pyramid (KML); anything else → single WebP ImageSource + 4 corners (PDF).
			if (storageKey.startsWith("vtiles:")) {
				const vtileMapKey = storageKey.slice("vtiles:".length);
				const ok = await overlay.addMapVectorTileOverlay(m, {
					mapKey: vtileMapKey,
				});
				if (!ok) {
					// Restore-on-new-device: synced mapTable thinks it has vector tiles but they're not on disk — inbox UI must prompt re-import.
					console.warn(
						"[MapDrawControls] vtiles missing on disk for",
						vtileMapKey,
					);
				}
			} else {
				// Prefer the TRUE 4-corner quad (quad-mode import) over the bbox-derived axis-aligned one; toCoord validates finite/in-range (NaN defence) — invalid input means a corrupt feature, skip loudly.
				const quad = overlayCornersToQuad(feature.overlayCorners);
				const [nw, ne, se, sw] = quad ?? boundsToQuad(feature.overlayBounds);
				if (!nw || !ne || !se || !sw) {
					console.warn(
						"[MapDrawControls] invalid overlay placement, skipping:",
						feature.overlayCorners ?? feature.overlayBounds,
					);
				} else {
					if (
						storageKey.endsWith(".local.webp") &&
						!reportedLocalOverlayKeys.has(storageKey)
					) {
						reportedLocalOverlayKeys.add(storageKey);
						reportSwallowed(
							"overlayManager:unbakedLocalOverlay",
							new Error(
								"overlay still on instant-import local raster (server bake never swapped in)",
							),
							{ key: storageKey },
						);
					}
					await overlay.addMapOverlay(m, {
						key: storageKey,
						corners: [nw, ne, se, sw],
						slot,
					});
					// Text labels (from the PDF's text layer) mount ABOVE the raster — sharp numbers over the softened image; no labels stored → no layer.
					if (feature.overlayLabels?.length) {
						overlay.addMapOverlayLabels(m, feature.overlayLabels, slot);
					}
					{
						ports.ui.devlog?.({
							evt: "overlay-mounted",
							key: storageKey,
							labels: feature.overlayLabels?.length ?? null,
						});
					}
					// Wait for the WebP to actually PAINT before hiding the waiting box — hiding on addMapOverlay's resolve (source added, image still decoding) flashes blank basemap.
					void import("$parent/siblings/getCache_OnlineMap/lib/mobMapWaitingBox").then(
						({ hideWaitingBoxOnceRendered }) => hideWaitingBoxOnceRendered(m),
					);
				}
			}
			// Bail if the user switched maps again mid-render — remove only THIS slot; the caller's loop-guard stops the rest.
			if ((mapStore.activeMap?.mapKey ?? null) !== targetMapKey) {
				overlay.removeMapOverlay(m, slot);
				return;
			}
			// Fresh layers mount at addMapOverlay's default opacity — push the current slider value immediately or a moved slider gets silently ignored.
			overlay.setMapOverlayOpacity(m, overlayOpacity.value, slot);
			// Fresh layers mount visible — re-apply the Legend's PDF toggle so a hidden overlay stays hidden across map switches / style reloads.
			overlay.setMapOverlayVisibility(m, overlayVisibility.pdf, slot);
		} catch (err) {
			// addMapOverlay/addMapVectorTileOverlay throw unguarded (bad tile URL, corrupt bounds, duplicate source) — route to reportSwallowed (not console.error) so failures don't go invisible; don't re-throw, one bad overlay shouldn't crash the map.
			reportSwallowed("overlayManager:renderOverlay", err, {
				mapKey: targetMapKey,
				overlayStorageKey: feature?.overlayStorageKey ?? null,
			});
		}
	}

	// True only when: (a) same map+feature already rendered, (b) single image (not vtiles), (c) the Mapbox image source is still live.
	function canSwapImageInPlace(
		feature: MapSessionFeature | null,
		mapKey: string | null,
		storageKey: string,
	): boolean {
		if (!feature || !mapKey) return false;
		if (mapKey !== renderedOverlayMapKey) return false;
		if (feature.mapFeatureKey !== renderedOverlayFeatureKey) return false;
		if (storageKey.startsWith("vtiles:")) return false;
		if (!feature.overlayBounds) return false;
		if (!getMap()?.getSource(OVERLAY_SOURCE_ID)) return false;
		return true;
	}

	// No-blink swap: updateImage swaps the texture in place so the overlay never flashes the basemap (OFFLINE_PLAN.md law 3); falls back to full re-render if there's no live image source.
	async function swapActiveMapOverlay(feature: MapSessionFeature) {
		const m = getMap();
		if (!m) return;
		if (!feature.overlayStorageKey || !feature.overlayBounds) return;
		const quad = overlayCornersToQuad(feature.overlayCorners);
		const [nw, ne, se, sw] = quad ?? boundsToQuad(feature.overlayBounds);
		if (!nw || !ne || !se || !sw) {
			void renderActiveMapOverlay();
			return;
		}
		try {
			const overlay = await import(
				"$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay"
			);
			const swapped = await overlay.swapMapOverlayImage(m, {
				key: feature.overlayStorageKey,
				corners: [nw, ne, se, sw],
			});
			if (!swapped) {
				void renderActiveMapOverlay();
				return;
			}
			overlay.setMapOverlayOpacity(m, overlayOpacity.value);
			overlay.setMapOverlayVisibility(m, overlayVisibility.pdf);
			activeOverlay = {
				name: feature.featureName ?? feature.overlayStorageKey,
			};
		} catch (err) {
			console.error(
				"[MapDrawControls] overlay swap failed, full re-render",
				err,
			);
			void renderActiveMapOverlay();
		}
	}

	return {
		get activeOverlay() {
			return activeOverlay;
		},
		renderActiveMapOverlay,
		bustCache() {
			renderedOverlayKey = null;
			// A style reload wipes every mounted layer — reset the count too, or the swap-vs-rerender decision goes stale.
			renderedOverlayCount = 0;
		},
		applyPdfVisibility() {
			const m = getMap();
			if (!m) return;
			// Reads the CURRENT store value (not reactive) — the host's `$effect` owns the reactive read and re-fires this on change.
			void import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay").then(
				(overlay) => overlay.setMapOverlayVisibility(m, overlayVisibility.pdf),
			);
		},
		attachOpacity() {
			const m = getMap();
			if (!m)
				return () => {
					/* no map — nothing to detach */
				};
			// Applier pattern, not a reactive read — cross-module Svelte rune tracking is flaky.
			// Applies to EVERY mounted overlay — one slider governs all sheets, matching the single MAP OPACITY control.
			return overlayOpacity.register((opacity) => {
				void import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay").then(
					(overlay) => overlay.setMapOverlayOpacity(m, opacity),
				);
			});
		},
		attachActiveMapDispatch() {
			if (!getMap())
				return () => {
					/* no map — nothing to detach */
				};
			// mapStore PUSHES, not a reactive $derived read — $derived is unreliable under HMR and can leave a deleted map's overlay as a ghost. [[cross-module-state-use-applier-pattern]]
			return mapStore.onActiveMapChange(() => {
				const m = getMap();
				if (!m) return;
				const mapKey = mapStore.activeMap?.mapKey ?? null;
				const features = activeOverlayFeatures();
				const feature = features[0] ?? null;
				const key = feature?.overlayStorageKey ?? "";
				const cacheKey = overlayRenderCacheKey(mapKey, features);
				if (cacheKey === renderedOverlayKey) return;
				const countUnchanged = features.length === renderedOverlayCount;
				const swap =
					countUnchanged && canSwapImageInPlace(feature, mapKey, key);
				renderedOverlayKey = cacheKey;
				renderedOverlayMapKey = mapKey;
				renderedOverlayFeatureKey = feature?.mapFeatureKey ?? null;
				renderedOverlayCount = features.length;
				if (swap && feature) {
					void swapActiveMapOverlay(feature);
				} else {
					void renderActiveMapOverlay();
				}
			});
		},
		showWaiting(corners) {
			const m = getMap();
			if (!m) return;
			void import("$parent/siblings/getCache_OnlineMap/lib/mobMapWaitingBox").then(
				({ showWaitingBox }) => {
					const map = getMap();
					if (map) showWaitingBox(map, corners);
				},
			);
		},
		hideWaiting() {
			const m = getMap();
			if (!m) return;
			void import("$parent/siblings/getCache_OnlineMap/lib/mobMapWaitingBox").then(
				({ hideWaitingBox }) => {
					const map = getMap();
					if (map) hideWaitingBox(map);
				},
			);
		},
	};
}
