// ⚠️ don't change rounding or formula shape here — every consumer must agree EXACTLY, or tile/blob geometry needs re-baking.

export type LngLat = [number, number];

/** [w, s, e, n] in degrees. */
export type DegBounds = [number, number, number, number];

/** km radius → degree spans at a latitude. Pole guard (|| 1e-6) avoids ÷0 at ±90°; never engages within real latitudes. */
export function kmToDegSpan(
	km: number,
	latDeg: number,
): { dLat: number; dLng: number } {
	const dLat = km / 111;
	const dLng = km / (111 * Math.cos((latDeg * Math.PI) / 180) || 1e-6);
	return { dLat, dLng };
}

/** The [w, s, e, n] box spanning ±km around a centre. */
export function degBoxAround(center: LngLat, km: number): DegBounds {
	const [lng, lat] = center;
	const { dLat, dLng } = kmToDegSpan(km, lat);
	return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** Flat-earth km between two [lng,lat] points (cos taken at `a`'s latitude — fine at blob scale). */
export function kmBetween(a: LngLat, b: LngLat): number {
	const dLat = (b[1] - a[1]) * 111;
	const dLng = (b[0] - a[0]) * 111 * Math.cos((a[1] * Math.PI) / 180);
	return Math.hypot(dLat, dLng);
}
