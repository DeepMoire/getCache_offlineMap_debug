/**
 * roadPicture — THE PHONE SIDE OF "ROADS AS A PICTURE".
 * ⛔ a grid address CANNOT centre on a point — not with a finer grid, Plus Codes, S2, or geohash; only bounds reach zero error (`gridVsBounds.test.ts`). Roads travel as a PNG plus the box it covers, like satellite already did.
 * ⚠️ NO I/O AND NO MAP OBJECT IN HERE — pure functions only ("is this a picture, and where does it go?"), so this stays testable in isolation. Map wiring lives at the call site.
 */
import type { Box } from "./pinBox";

/** The key prefix the Worker uses for a road picture. MUST match packBuilder. */
export const PNG_KEY_PREFIX = "png/";

/** Is this pack key a road picture rather than a vector tile? */
export function isRoadPictureKey(key: string): boolean {
	return key.startsWith(PNG_KEY_PREFIX);
}

/**
 * The pin a picture key names. `png/-119.01750,48.13640` → the pin itself.
 * ⛔ this is why the key is a GPS point, not a grid address — a `z/x/y` key throws away the pin (lossy on purpose, like rounding 47.9 to 50: you cannot unround).
 */
export function pinOfRoadPictureKey(
	key: string,
): { lng: number; lat: number } | null {
	if (!isRoadPictureKey(key)) return null;
	const [lng, lat] = key.slice(PNG_KEY_PREFIX.length).split(",").map(Number);
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
	return { lng, lat };
}

/** ⚠️ must match the Worker's spelling EXACTLY — 5 decimal places, no spaces — or the phone looks up a key that isn't there. */
export function roadPictureKey(lng: number, lat: number): string {
	return `${PNG_KEY_PREFIX}${lng.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * MapLibre's `coordinates` for an image source: four corners, clockwise from top-left.
 * ⛔ order is not arbitrary — [NW, NE, SE, SW]. Get it wrong and the image is mirrored or rotated rather than erroring.
 */
export function imageCoordinates(
	box: Box,
): [[number, number], [number, number], [number, number], [number, number]] {
	return [
		[box.w, box.n],
		[box.e, box.n],
		[box.e, box.s],
		[box.w, box.s],
	];
}

/** ⚠️ returns null rather than letting a malformed box become NaN coordinates — a NaN camera red-screens the map (see nan-camera-getbounds-crash). */
export function boxFromManifest(raw: unknown): Box | null {
	if (!raw || typeof raw !== "object") return null;
	const b = raw as Record<string, unknown>;
	const { w, s, e, n } = b;
	if (
		typeof w !== "number" ||
		typeof s !== "number" ||
		typeof e !== "number" ||
		typeof n !== "number"
	)
		return null;
	if (![w, s, e, n].every(Number.isFinite)) return null;
	// ⚠️ a box with inverted or zero extent places an image as a point or mirrored.
	if (!(e > w) || !(n > s)) return null;
	return { w, s, e, n };
}

/** What the map needs to hang one picture: the pixels' key, and where it goes. */
export interface RoadPicture {
	key: string;
	box: Box;
}

export function roadPictureFromManifest(manifest: {
	tiles: Array<{ k: string }>;
	box?: unknown;
}): RoadPicture | null {
	const entry = manifest.tiles.find((t) => isRoadPictureKey(t.k));
	if (!entry) return null;
	const box = boxFromManifest(manifest.box);
	// ⛔ a picture without its box is useless and must not be guessed at — the previous generation of this bug guessed the box and drew roads 89 km from the pin (measured at Timbuktu).
	if (!box) return null;
	return { key: entry.k, box };
}
