/** ⚰️ TOMBSTONE WITH A JOB — do not delete: the writer is gone but old devices still hold baked lines in rt-vectors, and getVectorKeys()/deleteVectorAt() are the only way to reclaim that space (retire only once no device still holds rt-vectors data — tracked in docs/TODO.md). */

import { migrateIdbDatabase } from "../idbRename";
import { makeKeyedIdbStore } from "../keyedIdbStore";

// rt-vectors renamed from retreever-v3-vectors-v9 — v9 stays OUT of STALE_DBS since migrateIdbDatabase still reads it as the fallback source.
const DB_NAME = "rt-vectors";
/** LIVE vectors DB name — exported so the v4 /blobs inspector can protect it from the legacy-wipe. */
export const LEGACY_VECTORS_DB_NAME = DB_NAME;
const STALE_DBS = [
	"retreever-v3-vectors",
	"retreever-v3-vectors-v2",
	"retreever-v3-vectors-v3",
	"retreever-v3-vectors-v4",
	"retreever-v3-vectors-v5",
	"retreever-v3-vectors-v6",
	"retreever-v3-vectors-v7",
	"retreever-v3-vectors-v8",
	"rt-wall-tiles",
];
const STORE = "lines";
if (typeof indexedDB !== "undefined") {
	for (const old of STALE_DBS) indexedDB.deleteDatabase(old);
	void migrateIdbDatabase("retreever-v3-vectors-v9", DB_NAME, STORE);
}

const idb = makeKeyedIdbStore<GeoJSON.Feature[]>({
	dbName: DB_NAME,
	storeName: STORE,
});

/** Delete one area's baked lines (budget eviction / orphan sweep). */
export async function deleteVectorAt(key: string): Promise<void> {
	return idb.delete(key);
}

/** Every stored area's key ("lng,lat") — for the reconcile to find gaps. */
export async function getVectorKeys(): Promise<string[]> {
	return idb.keys();
}

/** The stored lines for ONE area key, or [] if none. */
export async function getVectorFeaturesAt(key: string): Promise<GeoJSON.Feature[]> {
	return (await idb.get(key)) ?? [];
}

// NOTE: size readout comes from coverageRegistry's coverageSizes, NOT stored GeoJSON — never add a getAllVectorFeatures()/vectorStats() that loads every feature on a timer; that pinned the main-thread heap at 1 GB+.
