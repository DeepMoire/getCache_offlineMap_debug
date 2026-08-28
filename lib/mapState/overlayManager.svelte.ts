// Map-overlay controller. Renders EVERY overlay on the active map (PDFs
// rendered to WebPs, or a KML's vector-tile pyramid) — a map may carry any
// number of PDF sheets, and all of them draw. Owns: the reactive
// `activeOverlay` flag, (re)rendering on map switch, the no-blink in-place
// image swap (raw local raster → optimized server WebP), and the opacity slider.
//
// Factory (not a singleton) — MapDrawControls is reused across routes (live
// map, offline V3/V4, preview), so each instance needs its own overlay state.
// Same shape as createUserLocator(() => map).
import type { Map as MapboxMap } from "mapbox-gl";
// 28 Aug 2026: the host store + reportSwallowed now come IN through
// ../shared/mapHostPorts (a child may not import the host lib); the two overlay
// stores are siblings in this folder.
import type {
	MapHostFeature as MapSessionFeature,
	MapHostPorts,
	MapHostStore as MapStore,
} from "../shared/mapHostPorts";
import { overlayOpacity } from "./overlayOpacity.svelte";
import { overlayVisibility } from "./overlayVisibility.svelte";
import type { Coord } from "$parent/siblings/getCache_OnlineMap/lib/coord";
import { toCoord } from "$parent/siblings/getCache_OnlineMap/lib/coord";

/** Mapbox image-source corner order: [topLeft, topRight, bottomRight,
 *  bottomLeft]. A null in any slot means the input was non-finite / out of
 *  range (NaN defence) — the caller skips the overlay. */
type OverlayQuad = [Coord | null, Coord | null, Coord | null, Coord | null];

/** Axis-aligned quad from a `[w,s,e,n]` bbox (the default placement). */
function boundsToQuad(
	bounds: [number, number, number, number] | null,
): OverlayQuad {
	if (!bounds) return [null, null, null, null];
	const [w, s, e, n] = bounds;
	return [toCoord(w, n), toCoord(e, n), toCoord(e, s), toCoord(w, s)];
}

/** True-quad placement from stored 4 corners `[[lng,lat]×4]` (`[TL,TR,BR,BL]`),
 *  or null when the feature has no quad (→ caller falls back to the bbox). */
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

// Un-swapped instant-import rasters (".local.webp") mean the background
// server bake never landed for that import — the field-offline case. One
// operator breadcrumb per key per session tells Sentry how many devices
// still carry them, without flooding on every map switch.
const reportedLocalOverlayKeys = new Set<string>();

// Mirrors mobMapOverlay's IMAGE_SOURCE_ID — used to detect a live image source
// for the no-blink optimize-swap path (raw local raster → optimized server WebP).
// The FIRST overlay always mounts on the bare (un-suffixed) ids, and the swap
// path only ever targets that one, so this stays a plain constant.
const OVERLAY_SOURCE_ID = "map-overlay-image";

/** The dedup key deciding whether an active-map change needs a redraw.
 *
 *  Gates on the map PLUS every overlay's (featureKey, bucket) so a redundant
 *  dispatch is skipped, while adding / replacing / removing an overlay on the
 *  CURRENT map still redraws.
 *
 *  It must cover EVERY overlay, not just the first. Keying on the first alone
 *  meant importing a second PDF into a map that already had one produced an
 *  identical key — the dispatcher returned early and the new sheet never
 *  rendered, even though the import succeeded and the row existed. Exported
 *  for the regression test. */
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
	/** Non-null when an overlay is currently painted on the active map.
	 *  Reactive — read it in the template. */
	readonly activeOverlay: { name: string } | null;
	/** Tear down + re-render the active map's overlay from its stored key. */
	renderActiveMapOverlay(): Promise<void>;
	/** Bust the redraw-dedup cache so the next render isn't short-circuited.
	 *  Call before renderActiveMapOverlay() after a style reload wiped the
	 *  custom image source. */
	bustCache(): void;
	/** Register the opacity-slider applier on the raster layer. Returns
	 *  cleanup. Run inside an `$effect`. */
	attachOpacity(): () => void;
	/** Push the Legend's PDF show/hide toggle onto the mounted overlay
	 *  layers. Call from an `$effect` that reads `overlayVisibility.pdf`. */
	applyPdfVisibility(): void;
	/** Subscribe to active-map changes and (re)draw the overlay on each.
	 *  Returns cleanup. Run inside an `$effect`. */
	attachActiveMapDispatch(): () => void;
	/** Drop the on-map "waiting for the PDF" placeholder (black box + white
	 *  border + cleanCache animation) at `corners` ([TL,TR,BR,BL]). Shown
	 *  while a raw PDF round-trips the cloud converter; cleared by
	 *  `hideWaiting()` (or automatically when the real overlay renders). */
	showWaiting(corners: readonly [Coord, Coord, Coord, Coord]): void;
	/** Remove the waiting placeholder + its animation marker. */
	hideWaiting(): void;
}

/**
 * @param ports — the host's door (28 Aug 2026). Only `ports.ui.reportSwallowed`
 *   is read here: the child cannot import the host's reporter, so the host
 *   hands it in. Pick<> keeps callers/tests from having to build every port.
 */
export function createOverlayManager(
	getMap: () => MapboxMap | null,
	mapStore: MapStore,
	ports: Pick<MapHostPorts, "ui">,
): OverlayManager {
	const reportSwallowed = ports.ui.reportSwallowed;
	let activeOverlay = $state<{ name: string } | null>(null);

	/** EVERY overlay feature on the active map, in feature order. A map may
	 *  carry any number of PDF sheets — an import is a feature of the map
	 *  you're on, so two sheets covering adjacent ground both belong here and
	 *  both draw. (This used to be a `.find()` returning only the first, which
	 *  is why a second imported PDF silently never appeared.) */
	function activeOverlayFeatures(): MapSessionFeature[] {
		return (
			mapStore.activeMap?.features.filter(
				(f) => f.featureType === "overlay" && !!f.overlayStorageKey,
			) ?? []
		);
	}

	/** A stable, Mapbox-id-safe slot per overlay feature. Keyed on the feature
	 *  key so a given overlay keeps its layer across re-renders. The FIRST
	 *  overlay uses the bare ids (undefined slot) so the no-blink swap path
	 *  and any id-hardcoding plumbing keep working untouched. */
	function overlaySlot(
		f: MapSessionFeature,
		index: number,
	): string | undefined {
		if (index === 0) return undefined;
		return f.mapFeatureKey.replace(/[^a-zA-Z0-9_-]/g, "");
	}

	// The overlay belongs to whichever map is active. On every map switch the
	// previous WebP is removed and the newly-active map's overlay feature — if
	// any — is re-rendered from its stored key + bounds. Cheap: no PDF parse,
	// no network — just a file read + an image source swap.
	let renderedOverlayKey: string | null = null;
	// Tracked so the dispatcher can tell a same-feature blob swap (no-blink
	// updateImage) from a map switch / new overlay (full re-render).
	let renderedOverlayMapKey: string | null = null;
	let renderedOverlayFeatureKey: string | null = null;
	// How many overlays the last render mounted. A CHANGE in this count means a
	// sheet was added or removed, which the single-source no-blink swap cannot
	// express — that case must fall through to a full re-render.
	let renderedOverlayCount = 0;

	async function renderActiveMapOverlay() {
		const m = getMap();
		if (!m) return;
		const targetMapKey = mapStore.activeMap?.mapKey ?? null;
		const features = activeOverlayFeatures();
		const overlay = await import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay");
		// No slot → sweep EVERY mounted overlay, so overlays belonging to the
		// map we're leaving never linger on the one we're arriving at.
		overlay.removeMapOverlay(m);
		activeOverlay = null;
		if (features.length === 0) return;
		// Mount in order: feature 0 first, so later sheets stack ABOVE earlier
		// ones where they overlap (last-added wins in Mapbox at equal z).
		for (const [index, feature] of features.entries()) {
			if (!feature.overlayStorageKey || !feature.overlayBounds) continue;
			await mountOverlayFeature(
				m,
				overlay,
				feature,
				overlaySlot(feature, index),
				targetMapKey,
			);
			// The user may have switched maps mid-loop — stop rather than
			// paint the rest of a stale map's overlays onto the new one.
			if ((mapStore.activeMap?.mapKey ?? null) !== targetMapKey) return;
		}
		const first = features[0];
		activeOverlay = {
			name: first.featureName ?? first.overlayStorageKey ?? "",
		};
	}

	/** Mount ONE overlay feature into its own slot. */
	async function mountOverlayFeature(
		m: MapboxMap,
		overlay: typeof import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay"),
		feature: MapSessionFeature,
		slot: string | undefined,
		targetMapKey: string | null,
	) {
		// Caller already skipped features without these, but narrow here too so
		// this stays safe standalone.
		const storageKey = feature.overlayStorageKey;
		if (!storageKey || !feature.overlayBounds) return;
		try {
			// Two render paths (MAP_IMPORTS_UNIFIED.md):
			//   1. `vtiles:<mapKey>` → vector tile-pyramid (KML), mounts a
			//      Mapbox VectorSource against the on-disk .pbf tree with
			//      fill/line/circle layers reading simplestyle props.
			//   2. anything else → single-WebP ImageSource + 4 corners. PDF
			//      path: one WebP, four corners, no tile tree.
			if (storageKey.startsWith("vtiles:")) {
				const vtileMapKey = storageKey.slice("vtiles:".length);
				const ok = await overlay.addMapVectorTileOverlay(m, {
					mapKey: vtileMapKey,
				});
				if (!ok) {
					// Restore-on-new-device case — the synced mapTable thinks
					// it has vector tiles, but they aren't on disk. The
					// inbox UI is responsible for prompting a re-import.
					console.warn(
						"[MapDrawControls] vtiles missing on disk for",
						vtileMapKey,
					);
				}
			} else {
				// Placement corners: prefer the TRUE 4-corner quad (quad-mode
				// import — un-reprojected page draped on its real, possibly
				// rotated footprint) when present; otherwise derive an
				// axis-aligned quad from the [w,s,e,n] bbox (default import).
				// toCoord validates finite + in-range (NaN defence); invalid
				// input means the stored feature is corrupt → skip loudly.
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
					// Crisp text labels (extracted from the PDF's text layer
					// at import) mount ABOVE the raster — sharp numbers over
					// the softening image. No labels stored → no layer.
					if (feature.overlayLabels?.length) {
						overlay.addMapOverlayLabels(m, feature.overlayLabels, slot);
					}
					{
						// TEMP dev diagnostic (remove with /api/devlog): did
						// stored labels reach the renderer on this device?
						// 28 Aug 2026: the host's devlog arrives via ports.ui.devlog
						// (optional — a host without the diagnostic just skips it).
						ports.ui.devlog?.({
							evt: "overlay-mounted",
							key: storageKey,
							labels: feature.overlayLabels?.length ?? null,
						});
					}
					// The real overlay is mounted — tear down any waiting box
					// on the same spot, but only once the WebP has actually
					// PAINTED. addMapOverlay resolves when the source is added;
					// the image decodes async, so hiding immediately flashes
					// blank basemap for a beat. OnceRendered waits for the
					// first idle frame containing the loaded overlay.
					void import("$parent/siblings/getCache_OnlineMap/lib/mobMapWaitingBox").then(
						({ hideWaitingBoxOnceRendered }) => hideWaitingBoxOnceRendered(m),
					);
				}
			}
			// The user may have switched maps again mid-render — bail rather
			// than leave a stale overlay onto the wrong map. Remove only THIS
			// slot; the caller's loop-guard stops the rest.
			if ((mapStore.activeMap?.mapKey ?? null) !== targetMapKey) {
				overlay.removeMapOverlay(m, slot);
				return;
			}
			// The layer was just (re)created with addMapOverlay's default
			// opacity. If the user had moved the slider away from that, push
			// the current store value onto this fresh layer immediately.
			overlay.setMapOverlayOpacity(m, overlayOpacity.value, slot);
			// Fresh layers mount visible — re-apply the Legend's PDF toggle so
			// a hidden overlay stays hidden across map switches / style reloads.
			overlay.setMapOverlayVisibility(m, overlayVisibility.pdf, slot);
		} catch (err) {
			// The the harness overlay helpers (addMapOverlay / addMapVectorTileOverlay)
			// call map.addSource/addLayer unguarded — a bad tile URL, a corrupt
			// bounds, or a duplicate source throws HERE. A bare console.error is
			// NOT Sentry (breadcrumb at best), so a whole class of "my imported
			// map won't render" failures went invisible. Route it to the
			// operator channel. Re-render is driven by store changes, so we don't
			// re-throw (no user-facing crash for a single overlay that failed).
			reportSwallowed("overlayManager:renderOverlay", err, {
				mapKey: targetMapKey,
				overlayStorageKey: feature?.overlayStorageKey ?? null,
			});
		}
	}

	// Can we hot-swap just the image texture on the existing source, or do we
	// need to tear down and rebuild the whole overlay layer?  Returns true only
	// when (a) the same map + same feature are already rendered, (b) it's a
	// single image (not vtiles), and (c) the Mapbox image source is still live.
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

	// No-blink swap: the same overlay feature got a new backing blob (the optimized
	// server WebP replacing the raw local raster). updateImage swaps the texture in
	// place — the overlay never flashes the basemap (OFFLINE_PLAN.md law 3). Falls
	// back to a full re-render if there's no live image source to swap into.
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
			// A style reload wipes every mounted layer, so nothing is rendered
			// any more — clearing the count keeps the swap-vs-rerender decision
			// honest on the next dispatch.
			renderedOverlayCount = 0;
		},
		// Flip layout visibility on whatever overlay layers are mounted. Reads
		// the CURRENT store value (not reactive) — the host's $effect owns the
		// reactive read so the toggle re-fires this on every change.
		applyPdfVisibility() {
			const m = getMap();
			if (!m) return;
			void import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay").then(
				(overlay) => overlay.setMapOverlayVisibility(m, overlayVisibility.pdf),
			);
		},
		// Register an applier on the shared opacity store (not a reactive
		// read — cross-module rune tracking is flaky). Fires on register and
		// every slider move, so the layer always matches the slider.
		attachOpacity() {
			const m = getMap();
			if (!m)
				return () => {
					/* no map — nothing to detach */
				};
			// Applies to EVERY mounted overlay — one slider governs all the
			// sheets on the map, matching the single MAP OPACITY control.
			return overlayOpacity.register((opacity) => {
				void import("$parent/siblings/getCache_OnlineMap/lib/mobMapOverlay").then(
					(overlay) => overlay.setMapOverlayOpacity(m, opacity),
				);
			});
		},
		// Redraw on every active-map change. mapStore PUSHES (not a reactive
		// $derived read, which Svelte tracks unreliably under HMR and can leave
		// a deleted map's overlay as a ghost). [[cross-module-state-use-applier-pattern]]
		attachActiveMapDispatch() {
			if (!getMap())
				return () => {
					/* no map — nothing to detach */
				};
			return mapStore.onActiveMapChange(() => {
				const m = getMap();
				if (!m) return;
				const mapKey = mapStore.activeMap?.mapKey ?? null;
				const features = activeOverlayFeatures();
				const feature = features[0] ?? null;
				const key = feature?.overlayStorageKey ?? "";
				const cacheKey = overlayRenderCacheKey(mapKey, features);
				if (cacheKey === renderedOverlayKey) return;
				// The no-blink in-place swap handles ONE overlay's blob changing
				// (raw local raster → optimized server WebP). It can't express
				// "a whole new overlay appeared", so it only applies while the
				// overlay COUNT is unchanged; otherwise do the full re-render.
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
