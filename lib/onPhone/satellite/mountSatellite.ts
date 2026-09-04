// ⛔ Both /offline and /offline/debug must call this shared mount — it stays pure (map, blob, its own registries only); area SELECTION stays with the caller.
import type * as mapboxgl from "maplibre-gl";
import type maplibregl from "maplibre-gl";
import {
	BAKE_RADIUS_KM,
	getSatImageByKey,
	satImageKey,
	type Bounds,
} from "./satelliteImage";
import { SAT_INSERT_BEFORE } from "../render/wallStyle";
import { kmToDegSpan } from "../../shared/kmGeo";

/** One mounted-photo set, owned by one map. Created per map, disposed with it. */
export interface SatelliteMount {
	/** Mount the already-baked photo for this centre, if one is on disk. */
	display(center: [number, number]): Promise<void>;
	/**
	 * Law 5 enforcer — mount the photos NEAR this camera, unmount the ones far
	 * outside it. Returns how many photos are on the map after the pass.
	 */
	reconcile(
		camera: Bounds,
		anchors: readonly [number, number][],
	): Promise<number>;
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

// ── THE VIEWPORT CULL (direction2.6) ────────────────────────────────────────
// Before this, the page mounted EVERY baked photo on disk, forever: RAM grew
// with the PIN COUNT (~9 MB decoded per 1536-px photo — 321 pins ≈ 2.9 GB),
// not the screen (Law 5). The cull is GEOMETRY ONLY, never zoom (Law 1): a
// photo inside the camera is mounted at every zoom; what it reacts to is
// distance from the screen. Two rings give hysteresis — mount near, unmount
// far — so a photo near the edge does not flap on every pan, and a re-entry
// remounts from IndexedDB (a millisecond read) before the disc can scroll
// into view (Law 3, no blink).

/** Whole viewports added per side of the camera before a photo may MOUNT. */
export const SAT_MOUNT_VIEWPORTS = 1;
/** Whole viewports per side beyond which a mounted photo is UNMOUNTED — wider than the mount ring on purpose (hysteresis). */
export const SAT_UNMOUNT_VIEWPORTS = 2;

/** Camera bounds grown by `n` viewport spans per side. */
function expanded(camera: Bounds, n: number): Bounds {
	const [w, s, e, no] = camera;
	const dx = (e - w) * n;
	const dy = (no - s) * n;
	return [w - dx, s - dy, e + dx, no + dy];
}

/** Does the photo's disc (±BAKE_RADIUS_KM around the centre) intersect a [w,s,e,n] box? Lng span is lat-dependent (shared/kmGeo math). */
function discIntersects(center: [number, number], b: Bounds): boolean {
	const { dLat, dLng } = kmToDegSpan(BAKE_RADIUS_KM, center[1]);
	return (
		center[0] + dLng >= b[0] &&
		center[0] - dLng <= b[2] &&
		center[1] + dLat >= b[1] &&
		center[1] - dLat <= b[3]
	);
}

export interface PhotoCullPlan {
	/** Anchors whose photo should be mounted now (inside the mount ring). */
	mount: [number, number][];
	/** Keys of anchors inside the (wider) keep ring — a mounted photo OUTSIDE this set gets unmounted. */
	keep: Set<string>;
}

/**
 * PURE — which photos belong on the map for this camera. No map, no IndexedDB:
 * testable with plain numbers (Law 7). ⚠️ Antimeridian-crossing cameras are out
 * of scope — getBounds() spans the world there anyway, which mounts everything,
 * which is the correct (presence-preserving) answer for a world view.
 */
export function photoCullPlan(
	camera: Bounds,
	anchors: readonly [number, number][],
): PhotoCullPlan {
	const mountRing = expanded(camera, SAT_MOUNT_VIEWPORTS);
	const keepRing = expanded(camera, SAT_UNMOUNT_VIEWPORTS);
	const mount: [number, number][] = [];
	const keep = new Set<string>();
	for (const c of anchors) {
		if (discIntersects(c, keepRing)) keep.add(satImageKey(c));
		if (discIntersects(c, mountRing)) mount.push(c);
	}
	return { mount, keep };
}

export function createSatelliteMount(
	map: maplibregl.Map,
	onMounted?: () => void,
): SatelliteMount {
	const mountedSat = new Set<string>();
	// Per-key object-URL registry — createObjectURL pins the blob in memory until revoked; without this, unmount strands it (steady RAM climb).
	const satUrls = new Map<string, string>();

	const mountSat = (key: string, blob: Blob, bounds: Bounds): void => {
		const id = satLayerId(key);
		const existing = map.getSource(id) as maplibregl.ImageSource | undefined;
		if (existing) {
			// An already-mounted photo must still follow its new bounds — a re-bake can move them, and a stale mount pins the old footprint.
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
				// Only revoke after the swap succeeded — revoking a URL the source is still reading blanks the photo.
				if (prev) URL.revokeObjectURL(prev);
			} catch {
				// codestyle-allow-swallow: a failed in-place update leaves the previous (valid) image mounted. The next pass retries.
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
				// No fade — Law 3 (no blink): a cross-fade on mount is a visible gap in presence.
				paint: { "raster-fade-duration": 0 },
			} as mapboxgl.LayerSpecification,
			// Under the wall-map roads, so streets draw on top of the photo — wallStyle owns that ordering rule.
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
		const u = satUrls.get(key);
		if (u) {
			URL.revokeObjectURL(u);
			satUrls.delete(key);
		}
	};

	return {
		// Read-only — getSatImageByKey is a pure IndexedDB read; the app-wide bake service is the only thing that fetches.
		async display(center: [number, number]): Promise<void> {
			const key = satImageKey(center);
			if (mountedSat.has(key)) return;
			const img = await getSatImageByKey(key);
			if (img) mountSat(key, img.blob, img.bounds);
		},
		async reconcile(
			camera: Bounds,
			anchors: readonly [number, number][],
		): Promise<number> {
			const { mount, keep } = photoCullPlan(camera, anchors);
			// The sweep runs BEFORE mounting (reconcile invariant) — unmount
			// everything outside the keep ring, revoking each object URL or
			// the blob stays pinned (steady RAM climb).
			for (const key of [...mountedSat]) if (!keep.has(key)) unmount(key);
			let shown = 0;
			for (const c of mount) {
				await this.display(c);
				if (mountedSat.has(satImageKey(c))) shown++;
			}
			return shown;
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
