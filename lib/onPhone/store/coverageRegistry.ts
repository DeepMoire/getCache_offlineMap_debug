import { migrateIdbDatabase } from "./idbRename";
import { makeKeyedIdbStore } from "./keyedIdbStore";

const DB_NAME = "rt-mapRegistry";
const STORE = "coverage";
if (typeof indexedDB !== "undefined") {
	void migrateIdbDatabase("retreever-v3-registry", DB_NAME, STORE);
}

/** Hard storage cap for baked offline areas (satellite + lines); LRU-evicted over this. */
export const OFFLINE_BUDGET_BYTES = 1024 * 1024 * 1024;

/** Per-area byte estimate for areas not yet downloaded (~3.2 MB photo + line pack). */
export const EST_AREA_BYTES = 3.5 * 1024 * 1024;

export interface CoverageRecord {
	areaKey: string;
	lng: number;
	lat: number;
	hasPhoto: boolean;
	hasLines: boolean;
	bytes: number;
	photoBytes?: number;
	lineBytes?: number;
	lineCount?: number;
	/** blobVersion: geometry signature this area was built under; mismatch (or undefined) means a STALE blob needing re-download. */
	blobVersion?: string;
	/** bakedAt: epoch ms of the last successful download; distinct from lastTouched. Absent on records before 28 Aug 2026. */
	bakedAt?: number;
	lastTouched: number;
}

// ⚠️ COVERAGE_MIRROR_ENABLED is false — naive mirroring re-serialized the whole store every 20s and wedged app boot; re-enable only with a throttled, off-boot write path.
const COVERAGE_MIRROR_ENABLED = false;

/** Optional cloud mirror injected by the host; null unless registered, and gated by COVERAGE_MIRROR_ENABLED regardless. */
export interface CoverageMirror {
	write(rec: CoverageRecord): Promise<void>;
	remove(areaKey: string): Promise<void>;
}
let coverageMirror: CoverageMirror | null = null;

/** Register the host's cloud mirror. Never required. */
export function setCoverageMirror(m: CoverageMirror | null): void {
	coverageMirror = m;
}
async function mirrorToTinyBase(rec: CoverageRecord): Promise<void> {
	if (!COVERAGE_MIRROR_ENABLED) return;
	try {
		await coverageMirror?.write(rec);
	} catch {
		// codestyle-allow-swallow: the registry is the source of truth; a failed cloud-mirror write must not break baking
	}
}
async function unmirrorFromTinyBase(areaKey: string): Promise<void> {
	if (!COVERAGE_MIRROR_ENABLED) return;
	try {
		await coverageMirror?.remove(areaKey);
	} catch {
		// codestyle-allow-swallow: mirror cleanup is best-effort
	}
}

const idb = makeKeyedIdbStore<CoverageRecord>({
	dbName: DB_NAME,
	storeName: STORE,
});

/** One-time backfill of existing registry records into the TinyBase mirror; idempotent, best-effort. Call once on boot. */
export async function backfillCoverageMirror(): Promise<void> {
	if (!COVERAGE_MIRROR_ENABLED) return; // DISABLED — see mirrorToTinyBase note above
	try {
		const recs = await allCoverage();
		for (const r of recs) await mirrorToTinyBase(r);
	} catch {
		// codestyle-allow-swallow: mirror backfill is best-effort; the registry stays authoritative
	}
}

/** Every coverage record (for the reconcile + the size readout). */
export async function allCoverage(): Promise<CoverageRecord[]> {
	return idb.getAll();
}

/** Sets lastTouched: touchAt (verbatim) > touch (now) > prior stamp — a no-op re-bake must not reset recency. */
export async function noteCoverage(
	areaKey: string,
	lng: number,
	lat: number,
	patch: {
		bakedAt?: number;
		hasPhoto?: boolean;
		hasLines?: boolean;
		bytes?: number;
		photoBytes?: number;
		lineBytes?: number;
		lineCount?: number;
		blobVersion?: string;
	},
	touch = false,
	touchAt?: number,
): Promise<void> {
	const prev = await idb.get(areaKey);
	const lastTouched = Number.isFinite(touchAt)
		? (touchAt as number)
		: touch
			? Date.now()
			: (prev?.lastTouched ?? Date.now());
	const rec: CoverageRecord = {
		areaKey,
		lng,
		lat,
		hasPhoto: patch.hasPhoto ?? prev?.hasPhoto ?? false,
		hasLines: patch.hasLines ?? prev?.hasLines ?? false,
		bytes: patch.bytes ?? prev?.bytes ?? 0,
		photoBytes: patch.photoBytes ?? prev?.photoBytes ?? 0,
		lineBytes: patch.lineBytes ?? prev?.lineBytes ?? 0,
		lineCount: patch.lineCount ?? prev?.lineCount ?? 0,
		blobVersion: patch.blobVersion ?? prev?.blobVersion,
		lastTouched,
	};
	await idb.put(rec.areaKey, rec);
	void mirrorToTinyBase(rec);
}

/** Remove a record (after its tiles are deleted). */
export async function dropCoverage(areaKey: string): Promise<void> {
	await idb.delete(areaKey);
	void unmirrorFromTinyBase(areaKey);
}

// NOTE: eviction lives in offlineBakeService.bakeAll(), not here — don't re-add a registry-only implementation, it can't see orphan blobs.
