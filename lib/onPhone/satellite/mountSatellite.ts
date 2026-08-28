/**
 * MOUNTING THE PHOTOS — the code that puts a baked satellite image ON the map.
 *
 * ⛔ THIS EXISTS BECAUSE IT WAS WRITTEN TWICE-MINUS-ONCE. ReTreever's
 * `/offline` page carried ~90 lines of image-source mounting inline, and the
 * SAME view under `/offline/debug` — which renders the child's Demo component —
 * carried none. So the debugger showed no satellite while the real page showed
 * it fine, and every hour spent asking "why doesn't satellite render?" was
 * spent looking at the page that never had the code. MEASURED 27 Aug 2026:
 * /offline 1603 lines, /offline/debug 34.
 *
 * A debugger that renders different pixels than the thing it debugs is worse
 * than no debugger: it produces confident wrong answers. So the mount lives
 * HERE, in the child, and both pages call it.
 *
 * WHY IT COULD MOVE AT ALL: the mount is pure. It touches the MapLibre map,
 * the photo blob, and its own two registries. No mapStore, no hitchState, no
 * feature geometry — none of the proprietary surface the open-core rule keeps
 * in ReTreever/src. Area SELECTION is where that boundary really sits, and it
 * stays with the caller.
 */
import type * as mapboxgl from "maplibre-gl";
import type maplibregl from "maplibre-gl";
import { getSatImageByKey, satImageKey, type Bounds } from "./satelliteImage";
import { SAT_INSERT_BEFORE } from "../render/wallStyle";

/** One mounted-photo set, owned by one map. Created per map, disposed with it. */
export interface SatelliteMount {
	/** Mount the already-baked photo for this centre, if one is on disk. */
	display(center: [number, number]): Promise<void>;
	/** Drop a photo and release its blob. */
	unmount(key: string): void;
	/** Keys currently on the map — the caller's sweep reads this. */
	mounted(): ReadonlySet<string>;
	/** Revoke every object URL and forget everything. Call on teardown. */
	dispose(): void;
}

/** MapLibre layer id for an area key — `,` and `-` are not id-safe. */
export function satLayerId(key: string): string {
	return `v4-sat-${key.replace(/[^a-z0-9]/gi, "_")}`;
}

/**
 * @param map        the live MapLibre map
 * @param onMounted  called after a photo lands, so the caller can re-raise
 *                   anything that must stay above it (labels, draw tools).
 */
export function createSatelliteMount(
	map: maplibregl.Map,
	onMounted?: () => void,
): SatelliteMount {
	const mountedSat = new Set<string>();
	// Per-key object-URL registry. createObjectURL PINS the photo blob in
	// memory until revoked; without this every unmount stranded the blob —
	// the steady RAM climb.
	const satUrls = new Map<string, string>();

	const mountSat = (key: string, blob: Blob, bounds: Bounds): void => {
		const id = satLayerId(key);
		const existing = map.getSource(id) as maplibregl.ImageSource | undefined;
		if (existing) {
			// AN ALREADY-MOUNTED PHOTO MUST STILL FOLLOW ITS NEW BOUNDS — a
			// re-bake can move them, and a stale mount pins the photo to the
			// old footprint.
			const [uw, us, ue, un] = bounds;
			const url = URL.createObjectURL(blob);
			const prev = satUrls.get(key);
			satUrls.set(key, url);
			try {
				existing.updateImage({
					url,
					coordinates: [
						[uw, un],
						[ue, un],
						[ue, us],
						[uw, us],
					] as never,
				});
				// Only revoke AFTER the swap succeeded — revoking a URL the
				// source is still reading blanks the photo.
				if (prev) URL.revokeObjectURL(prev);
			} catch {
				// codestyle-allow-swallow: a failed in-place update leaves the
				// previous (valid) image mounted. The next pass retries.
				satUrls.set(key, prev ?? url);
			}
			mountedSat.add(key);
			return;
		}
		const url = URL.createObjectURL(blob);
		satUrls.set(key, url);
		const [w, s, e, n] = bounds;
		map.addSource(id, {
			type: "image",
			url,
			coordinates: [
				[w, n],
				[e, n],
				[e, s],
				[w, s],
			] as never,
		});
		map.addLayer(
			{
				id: `${id}-l`,
				type: "raster",
				source: id,
				// NO fade — Law 3 (no blink). A cross-fade on mount is a
				// visible gap in presence.
				paint: { "raster-fade-duration": 0 },
			} as mapboxgl.LayerSpecification,
			// UNDER the wall-map roads, so streets draw on top of the photo.
			// wallStyle owns that ordering rule.
			map.getLayer(SAT_INSERT_BEFORE) ? SAT_INSERT_BEFORE : undefined,
		);
		mountedSat.add(key);
		onMounted?.();
	};

	const unmount = (key: string): void => {
		const id = satLayerId(key);
		if (map.getLayer(`${id}-l`)) map.removeLayer(`${id}-l`);
		if (map.getSource(id)) map.removeSource(id);
		mountedSat.delete(key);
		// Release the blob the object-URL was pinning (the leak fix).
		const u = satUrls.get(key);
		if (u) {
			URL.revokeObjectURL(u);
			satUrls.delete(key);
		}
	};

	return {
		// READ-ONLY. getSatImageByKey is a pure IndexedDB read — this never
		// bakes and never downloads. The app-wide bake service is the only
		// thing that fetches.
		async display(center: [number, number]): Promise<void> {
			const key = satImageKey(center);
			if (mountedSat.has(key)) return;
			const img = await getSatImageByKey(key);
			if (img) mountSat(key, img.blob, img.bounds);
		},
		unmount,
		mounted: () => mountedSat,
		dispose(): void {
			for (const u of satUrls.values()) URL.revokeObjectURL(u);
			satUrls.clear();
			mountedSat.clear();
		},
	};
}
