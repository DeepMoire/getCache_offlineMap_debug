/** Tile geometry. Pure maths — no I/O, no MapLibre, no storage. */

/** ⛔ Disc functions (tilesAtZoom, blobTiles, discInTile, clip.ts) are gone, not moved — replaced by the snapped-cell grid (grid.ts); don't resurrect them for radius/circle logic. */

export interface TileId {
	z: number;
	x: number;
	y: number;
}

/** Tile key as stored and as it appears in a `rtv5://` URL. */
export function tileKey(t: TileId): string {
	return `${t.z}/${t.x}/${t.y}`;
}

export function lngToTileX(lng: number, z: number): number {
	return Math.floor(((lng + 180) / 360) * 2 ** z);
}

export function latToTileY(lat: number, z: number): number {
	const r = (lat * Math.PI) / 180;
	return Math.floor(
		((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z,
	);
}

export function tileToLng(x: number, z: number): number {
	return (x / 2 ** z) * 360 - 180;
}

export function tileToLat(y: number, z: number): number {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Great-circle-ish distance in km. Good to well under a metre at this scale. */
export function km(
	lng1: number,
	lat1: number,
	lng2: number,
	lat2: number,
): number {
	const dLat = (lat2 - lat1) * 111.32;
	const dLng =
		(lng2 - lng1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
	return Math.hypot(dLat, dLng);
}
