/**
 * pinTileLookup — WHICH PIN'S ROADS ANSWER THIS TILE ADDRESS?
 *
 * ── THE BUG THIS CLOSES, MEASURED ─────────────────────────────────────────
 *
 * Roads used to be stored under a bare grid address (`8/49/93`). A z8 square is
 * ~104 km wide, so two pins routinely share one — and the second pin was served
 * the first pin's roads. From the user's own blob inspector, minutes apart:
 *
 *     Moran WY        pin -110.7261,44.0618   roads box n=44.3334   →   408 m off
 *     Yellowstone WY  pin -110.7470,44.6629   roads box n=44.3334   →  50.4 km off
 *                                                        ^^^^^^^ IDENTICAL
 *
 * The second pin sat 36.6 km NORTH of the top edge of its own roads. It was not
 * inside its own data at all.
 *
 * ⚠️ THE SATELLITE NEVER HAD THIS BUG, and the difference is one line:
 *     satImageKey  = `${lng},${lat}`     ← the pin. Unique. Never shared.
 *     cellTileKey  = `${z}/${ix}/${iy}`  ← a square. Shared by neighbours.
 * Same map, same pins, same moment: 5 m versus 50 km. The user, who was right:
 * "I make the pin first, so we have the GPS point. You just get the satellite
 * image and then the roads blob and you put them both in the same spot."
 *
 * ── SO WHY IS A LOOKUP NEEDED AT ALL? ─────────────────────────────────────
 *
 * Because MapLibre asks for `z/x/y` and nothing else — it cannot name a pin.
 * Roads are stored per-pin (`pin/<lng>,<lat>/<z>/<x>/<y>`), so one address can
 * have several owners, and this module picks one: THE NEAREST PIN.
 *
 * That is not a tie-break of convenience — it is the correct answer. The tile
 * the user is looking at belongs to the pin they are nearest to; serving any
 * other pin's copy is precisely the bug above.
 *
 * ⚠️ NO I/O DECISIONS IN HERE BEYOND THE KEY SET. Pure functions over the keys,
 * so the choice is testable without a database.
 */
import { isPinTileKey } from "../../contract/grid";

/** A stored roads key, split into the pin that owns it and the tile it draws. */
export interface PinTile {
	key: string;
	lng: number;
	lat: number;
	address: string;
}

/**
 * Parse `pin/<lng>,<lat>/<z>/<x>/<y>`. Returns null for anything else — a
 * legacy bare `z/x/y` key included, which is how old blobs are ignored rather
 * than mistaken for a pin's.
 */
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
	// Longitude degrees shrink with latitude; without this a far-east pin can
	// beat a nearer-north one at high latitude.
	const k = Math.cos((aLat * Math.PI) / 180);
	const dx = (aLng - bLng) * k;
	const dy = aLat - bLat;
	return dx * dx + dy * dy;
}

/**
 * EVERY key holding roads for this address — one per pin that owns it.
 *
 * ⛔ THIS RETURNS ALL OWNERS, AND THAT IS THE WHOLE POINT.
 *
 * The first version returned only the NEAREST pin's key. That fixed the
 * collision (a pin being served someone else's roads) by picking a winner —
 * and picking a winner means every other pin's copy of that tile is never
 * drawn. MEASURED on screen, the user's Greybull pin: its own box was correct
 * to 123 m in every direction, and half its roads were still missing, because
 * the shared tiles resolved to the neighbouring pin instead.
 *
 * The user described it exactly before I found it: "half of it's missing
 * because it doesn't want to overlap the other one... they don't butt up
 * against each other so it ends up stuck in the middle."
 *
 * ⚠️ TWO PINS SHARING A TILE ADDRESS IS NORMAL, NOT A CONFLICT. Both copies
 * are real roads at real coordinates in the same tile's coordinate space, so
 * the answer is to draw BOTH — never to choose. Choosing is what made the
 * collision fix into a new kind of hole.
 */
/**
 * Does the tile `z/x/y` contain the stored tile at `address`?
 *
 * True when they are the SAME tile, or when `z/x/y` is an ancestor of it — a
 * z5 tile contains 8×8 z8 tiles beneath it. Walking the stored address UP to
 * the requested zoom is exact integer arithmetic (halve x and y per level), so
 * there is no tolerance and no rounding to get wrong.
 *
 * Requests DEEPER than the stored level are not handled here on purpose:
 * MapLibre overzooms upward by itself, so a z12 camera is served the z8 tile
 * by the renderer, not by this lookup.
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
	// ⛔ A DEEPER REQUEST MUST BE ANSWERED WITH THE TILE THAT CONTAINS IT.
	//
	// This was `if (sz < z) return false;` — "stored is shallower than asked,
	// the renderer's own overzoom covers that." It does not. MapLibre overzooms
	// a tile it ALREADY HAS; this protocol is asked per address and answered
	// "no tile", so there is nothing to overzoom from. Every request deeper
	// than the stored level (8) got nothing.
	//
	// MEASURED 27 Aug 2026, one page load, both lines from the same 4 tiles:
	//     pass done — 1 area(s), 4 tiles, 0.5 MB in 6.9s
	//     map is reading NOTHING from disk (4 tiles asked, 0 found)
	// and against real prod keys in a test: found at z8..z12, MISSING at
	// z13, z14 — the zooms the camera actually sits at. Downloaded, stored,
	// unreachable.
	//
	// A z13 tile is geometrically INSIDE the z8 tile that holds it, so the
	// honest answer to "what roads are at this z13 address?" is that z8 tile.
	// Descend the REQUEST to the stored level and compare there — the mirror
	// of the climb below, which already handles the shallower direction.
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
		// ⛔ NOT A STRING COMPARE. A ZOOMED-OUT ADDRESS CONTAINS THE STORED ONE.
		//
		// This was `pt.address !== address`, an exact `z/x/y` match, which meant
		// a request for a SHALLOWER tile than the one on disk found nothing.
		// Blobs are stored at BLOB_TILE_Z (8); the moment the camera sat above
		// z8 every lookup missed and the map went blank — with megabytes of
		// roads on disk. MEASURED 27 Aug 2026, both lines seconds apart:
		//     ✅ 2 road layer(s) drawing from 961 blob(s)
		//     961 blob(s) on disk but NO ROADS DRAWING — check the zoom span
		//
		// A z5 tile geometrically CONTAINS the z8 tiles under it, so the honest
		// answer to "what roads are in this z5 tile?" is every stored tile whose
		// footprint falls inside it. MapLibre only overzooms UP, so without this
		// there is no way to draw anything below the stored level at all.
		if (!containsAddress(z, x, y, pt.address)) continue;
		hits.push({ key, d: d2(centre.lng, centre.lat, pt.lng, pt.lat) });
	}
	// Nearest FIRST — not to exclude anyone, only so the pin the user is looking
	// at contributes its layers before the neighbours' in the merged tile.
	hits.sort((a, b) => a.d - b.d);
	return hits.map((h) => h.key);
}

/**
 * The single nearest owner. Kept for callers that genuinely want one blob.
 *
 * ⚠️ DO NOT USE THIS FOR RENDERING — see `keysForAddress`. Rendering one owner
 * of a shared address is precisely the half-a-map bug.
 */
export function keyForAddress(
	stored: Iterable<string>,
	z: number,
	x: number,
	y: number,
): string | null {
	return keysForAddress(stored, z, x, y)[0] ?? null;
}
