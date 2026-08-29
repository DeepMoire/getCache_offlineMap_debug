/** One-shot purge of the deleted road-raster store (v4RoadRasters.ts / rasterDecode.ts, removed 2026-08-17). */
/** ⚠️ Do not re-add a picture of the roads — if a zoom band looks empty, fix it with a shallower ring in the pack (Worker-side), not a raster. */
/** ⚠️ The DB names below are the real historical persisted names (not the later "raster" naming) — they must stay exactly as written or the purge misses the data. */
const DEAD_DB_NAME = "retreever-v4-thumbs";
/** The later, short-lived rename — a handful of devices got this one instead. */
const DEAD_DB_NAME_ALT = "retreever-v4-rasters";

let purged = false;

/** Safe to call repeatedly and on devices that never had the DBs. ⚠️ Deliberately never throws — housekeeping must never take down the map; a blocked delete just resolves and the next launch retries. */
export function purgeDeadRoadRasters(): void {
	if (purged || typeof indexedDB === "undefined") return;
	purged = true;
	for (const name of [DEAD_DB_NAME, DEAD_DB_NAME_ALT]) {
		try {
			const req = indexedDB.deleteDatabase(name);
			// blocked fires when another tab still holds the DB open — let it go; the next launch retries regardless.
			req.onblocked = () => {};
			req.onerror = () => {};
		} catch {
			// indexedDB unavailable (private mode, locked profile) — ignore.
		}
	}
}
