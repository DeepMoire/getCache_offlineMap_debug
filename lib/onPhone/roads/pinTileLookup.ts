/**
 * ⚠️ satellite is keyed by pin (`${lng},${lat}`, unique) — roads by grid cell (`${z}/${ix}/${iy}`) would let two pins share one square and serve each other's roads.
 * ⚠️ no I/O decisions in here beyond the key set — pure functions over the keys, testable without a database.
 */
import { isPinTileKey } from "../../contract/grid";

/** A stored roads key, split into the pin that owns it and the tile it draws. */
export interface PinTile {
	key: string;
	lng: number;
	lat: number;
	address: string;
}

export function parsePinTileKey(key: string): PinTile | null {
	if (!isPinTileKey(key)) return null;
	// pin / "<lng>,<lat>" / z / x / y
	const parts = key.split("/");
	if (parts.length !== 5) return null;
	const [lngStr, latStr] = parts[1].split(",");
	const lng = Number(lngStr);
	const lat = Number(latStr);
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
	const address = `${parts[2]}/${parts[3]}/${parts[4]}`;
	return { key, lng, lat, address };
}

/** The centre of a slippy tile, in degrees. Used to measure "nearest pin". */
export function tileCentre(
	z: number,
	x: number,
	y: number,
): { lng: number; lat: number } {
	const n = 2 ** z;
	const lng = ((x + 0.5) / n) * 360 - 180;
	const t = Math.PI - (2 * Math.PI * (y + 0.5)) / n;
	const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
	return { lng, lat };
}

/** Squared-degree distance — ordering only, so no need for haversine's cost. */
function d2(aLng: number, aLat: number, bLng: number, bLat: number): number {
	// Longitude degrees shrink with latitude — without this a far-east pin can beat a nearer-north one at high latitude.
	const k = Math.cos((aLat * Math.PI) / 180);
	const dx = (aLng - bLng) * k;
	const dy = aLat - bLat;
	return dx * dx + dy * dy;
}

/**
 * ⛔ returns ALL owners, not just the nearest — two pins sharing a tile address is normal, not a conflict; draw both, never choose a winner.
 */
function containsAddress(
	z: number,
	x: number,
	y: number,
	address: string,
): boolean {
	const [szRaw, sxRaw, syRaw] = address.split("/");
	const sz = Number(szRaw);
	let sx = Number(sxRaw);
	let sy = Number(syRaw);
	if (!Number.isFinite(sz) || !Number.isFinite(sx) || !Number.isFinite(sy)) {
		return false;
	}
	// ⛔ a deeper request must be answered with the tile that contains it — MapLibre overzooms tiles it already has, not addresses it never got, so descend the request to the stored level and compare there.
	if (sz < z) {
		let ax = x;
		let ay = y;
		for (let level = z; level > sz; level--) {
			ax = Math.floor(ax / 2);
			ay = Math.floor(ay / 2);
		}
		return sx === ax && sy === ay;
	}
	// Climb the stored tile up to the requested zoom; each level halves.
	for (let level = sz; level > z; level--) {
		sx = Math.floor(sx / 2);
		sy = Math.floor(sy / 2);
	}
	return sx === x && sy === y;
}

export function keysForAddress(
	stored: Iterable<string>,
	z: number,
	x: number,
	y: number,
): string[] {
	const centre = tileCentre(z, x, y);
	const hits: Array<{ key: string; d: number }> = [];
	for (const key of stored) {
		const pt = parsePinTileKey(key);
		if (!pt) continue;
		// ⛔ not a string compare — a zoomed-out address must contain the stored one, or any camera above the stored zoom finds nothing and the map goes blank.
		if (!containsAddress(z, x, y, pt.address)) continue;
		hits.push({ key, d: d2(centre.lng, centre.lat, pt.lng, pt.lat) });
	}
	hits.sort((a, b) => a.d - b.d);
	return hits.map((h) => h.key);
}

/**
 * The single nearest owner — kept for callers that want one blob.
 * ⚠️ DO NOT USE THIS FOR RENDERING — see keysForAddress; rendering one owner of a shared address is the half-a-map bug.
 */
export function keyForAddress(
	stored: Iterable<string>,
	z: number,
	x: number,
	y: number,
): string | null {
	return keysForAddress(stored, z, x, y)[0] ?? null;
}
