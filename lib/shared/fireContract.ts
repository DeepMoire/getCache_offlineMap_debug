/** fireContract.ts — fire layer shape. ⚠️ Never re-declare FIRE_RADIUS_KM or the hotspot shape elsewhere; fireCache.ts re-exports these. */

/** Radius, in km, of one fire disc. */
export const FIRE_RADIUS_KM = 500;

export type FireConfidence = "low" | "nominal" | "high";

/** One hotspot, trimmed to what the map actually renders. */
export interface FireHotspot {
	/** [lng, lat] — GeoJSON order. */
	readonly coordinates: [number, number];
	/** Acquisition time, UTC epoch ms. Drives the age-colour ramp. */
	readonly t: number;
	readonly c: FireConfidence;
	/** Fire radiative power, MW. */
	readonly frp: number;
	/** Pixel footprint in km. Optional — an older cached record predates it. */
	readonly px?: number;
	/** Day / Night overpass. Night reads are less solar-contaminated. */
	readonly dn?: "D" | "N";
}
