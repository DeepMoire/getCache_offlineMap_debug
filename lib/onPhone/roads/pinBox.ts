// ⛔ The bug is a storage format that cannot centre on anything, not a miscalculation — don't try to fix it with tile-path arithmetic; that's how three days went.
// ⚠️ Do not add I/O here — this module takes numbers and returns numbers only; I/O makes geometry driftable again.
import { km } from "../../contract/geo";

/** A box in degrees; `[w,s,e,n]` matches MapLibre's `bounds` and the satellite blob's stored format. */
export interface Box {
	w: number;
	s: number;
	e: number;
	n: number;
}

// ⛔ Must exactly match the Worker's radiusBox constants (workers/offline-tiles/src/grid.ts) — don't "improve" them, drift desyncs where the image is placed vs drawn. gridVsBounds.test.ts catches it; don't silence that test.
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQUATOR = 111_320;

/** Divides the east/west step by cos(lat) — skip it and the box is too narrow (e.g. ~20 km instead of 30 km at 47.9°N). */
export function boxAround(lng: number, lat: number, radiusKm: number): Box {
	if (!Number.isFinite(lng) || !Number.isFinite(lat))
		throw new Error(`boxAround: bad pin ${lng},${lat}`);
	if (!(radiusKm > 0)) throw new Error(`boxAround: bad radius ${radiusKm}`);

	const dLat = (radiusKm * 1000) / M_PER_DEG_LAT;
	// Clamp cos(lat) so a polar pin yields a wide box, not Infinity/NaN (which red-screens the map); 0.05 matches the Worker's clamp.
	const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
	const dLng = (radiusKm * 1000) / (M_PER_DEG_LNG_EQUATOR * cos);

	return {
		w: lng - dLng,
		e: lng + dLng,
		s: lat - dLat,
		n: lat + dLat,
	};
}

/** The box's centre. For a box from `boxAround` this returns the pin. */
export function centreOf(b: Box): { lng: number; lat: number } {
	return { lng: (b.w + b.e) / 2, lat: (b.s + b.n) / 2 };
}

/** Distance from the box's centre to the pin — near 0 means centred; a large value means the box sits beside the pin, not around it. */
export function offsetFromPinKm(b: Box, lng: number, lat: number): number {
	const c = centreOf(b);
	return km(lng, lat, c.lng, c.lat);
}

/** Distance from the pin to the box's farthest corner — for a square box this is the diagonal (~1.41 × radius), not the radius. */
export function reachKm(b: Box, lng: number, lat: number): number {
	return Math.max(
		km(lng, lat, b.w, b.n),
		km(lng, lat, b.e, b.n),
		km(lng, lat, b.w, b.s),
		km(lng, lat, b.e, b.s),
	);
}

/** Width and height in km, for reading a box at a glance. */
export function sizeKm(b: Box): { widthKm: number; heightKm: number } {
	const midLat = (b.s + b.n) / 2;
	return {
		widthKm: km(b.w, midLat, b.e, midLat),
		heightKm: km(b.w, b.s, b.w, b.n),
	};
}

/** Is this point inside the box? */
export function contains(b: Box, lng: number, lat: number): boolean {
	return lng >= b.w && lng <= b.e && lat >= b.s && lat <= b.n;
}

/** `[w,s,e,n]` — the tuple MapLibre and the satellite blob both already use. */
export function toBounds(b: Box): [number, number, number, number] {
	return [b.w, b.s, b.e, b.n];
}
