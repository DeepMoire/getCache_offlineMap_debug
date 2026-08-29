/** ⚠️ /offline must always show exactly what's on disk — one flash of stale data breaks that promise and the user can no longer trust what they see. */

import {
	latchOfflineReadsForWipe,
	unlatchOfflineReadsAfterFailedWipe,
	resetOfflineDbHandles,
} from "../../shared/sandboxDbNames";

/** Databases the wipe destroys. Tiles + bookkeeping only — never user data. */
export const WIPE_DBS = [
	"gc-offlineTiles",
	"gc-offlineSatellite",
	"rt-vectors",
	"rt-mapRegistry",
] as const;

/** ⛔ NEVER add these to WIPE_DBS. The user's own data lives here. */
export const NEVER_WIPE = ["rt-treeStuff"] as const;

export interface WipeResult {
	/** Database name → how it went. */
	readonly deleted: Record<string, "gone" | "blocked" | "absent">;
	/** True when every target is confirmed gone. */
	readonly clean: boolean;
}

function deleteDb(name: string): Promise<"gone" | "blocked"> {
	return new Promise((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve("gone");
		req.onerror = () => resolve("blocked");
		// ⚠️ onblocked is not a failure — it means the delete is queued behind an open connection; onsuccess still fires once it closes, so wait rather than reporting blocked immediately.
		req.onblocked = () => {
			setTimeout(() => resolve("blocked"), BLOCKED_GRACE_MS);
		};
	});
}

/** How long to let a queued delete finish before calling it blocked. */
const BLOCKED_GRACE_MS = 3000;

/** How long to let in-flight IndexedDB transactions (short: a put batch or key probe) drain after stopping the bake service. */
const IN_FLIGHT_GRACE_MS = 400;

export async function wipeOfflineData(): Promise<WipeResult> {
	console.warn("[wipe] ── starting ──");
	const existing = new Set<string>();
	// `databases()` is not in older Safari; absent means we just try them all.
	if (typeof indexedDB.databases === "function") {
		try {
			for (const d of await indexedDB.databases()) {
				if (d.name) existing.add(d.name);
			}
		} catch {
			/* fall through — attempt every name */
		}
	}

	const deleted: Record<string, "gone" | "blocked" | "absent"> = {};
	for (const name of WIPE_DBS) {
		if (existing.size > 0 && !existing.has(name)) {
			deleted[name] = "absent";
			continue;
		}
		if (name === "gc-offlineTiles") {
			try {
				console.warn(`[wipe] tiles on disk before: ${await countTiles()}`);
			} catch {
				/* diagnostic only */
			}
		}
		console.warn(`[wipe] deleting ${name}…`);
		deleted[name] = await deleteDb(name);
		console.warn(`[wipe]   ${name}: ${deleted[name]}`);
	}

	const clean = Object.values(deleted).every((v) => v !== "blocked");
	console.warn(
		clean
			? "[wipe] ✅ CLEAN — every offline database is gone. Reloading…"
			: "[wipe] ❌ BLOCKED — nothing deleted. Close other tabs on this origin.",
		deleted,
	);
	return { deleted, clean };
}

/** ⚠️ Close connections and CONFIRM every delete before reloading — reloading first re-opens the DBs and cancels the queued deletes (reload wins the race). */

/** ⛔ Fns to stop before wiping (pollers/services on a timer) — registered by the CALLER, never imported here; importing pulls in the whole app and breaks this module's tests. */
const stoppers = new Set<() => void>();

/** Register something to stop before the wipe (e.g. the bake service). */
export function registerWipeStopper(fn: () => void): () => void {
	stoppers.add(fn);
	return () => stoppers.delete(fn);
}

/** ⚠️ Reuses the existing registry (registerOfflineDbReset/resetOfflineDbHandles) rather than adding a second — two registries means a module can register with one and not the other, and the wipe blocks on an unknown handle. */

export async function wipeOfflineDataAndReload(): Promise<void> {
	// 1) STOP THE APP. ⚠️ Closing cached handles alone is not enough — the bake service reopens the tile DB every ~20s and blocks the delete just as hard as a cached handle.
	for (const stop of stoppers) {
		try {
			stop();
		} catch {
			/* best-effort: a failed stopper just means that delete may block */
		}
	}
	// Let any transaction already in flight finish and release its lock.
	await new Promise((r) => setTimeout(r, IN_FLIGHT_GRACE_MS));

	// 2) ⛔ Latch reads off FIRST, then drop handles — closing handles alone isn't enough since idbGetTile reopens the DB on every tile request and re-blocks the delete.
	latchOfflineReadsForWipe();
	resetOfflineDbHandles();

	// 3) Delete and WAIT. No reload until these actually finish.
	const res = await wipeOfflineData();

	if (!res.clean) {
		// Must restore reads here (data's still there) — leaving the latch on through a failed wipe would make every tile read a permanent silent miss.
		unlatchOfflineReadsAfterFailedWipe();

		// Do NOT reload here — that recreates the databases and hides the failure; tell the human instead.
		console.error(
			"[wipe] FAILED — databases still held open, nothing was deleted.",
			res.deleted,
			"\nClose other tabs on this origin and press WIPE again.",
		);
		throw new Error("wipe blocked: " + JSON.stringify(res.deleted));
	}

	// 4) Provably empty → safe to reload.
	console.log("[wipe] clean:", res.deleted);
	location.reload();
}

/** How many tiles are in the store right now (diagnostic only). */
function countTiles(): Promise<number> {
	return new Promise((resolve) => {
		const req = indexedDB.open("gc-offlineTiles");
		req.onsuccess = () => {
			const db = req.result;
			if (![...db.objectStoreNames].includes("tiles")) {
				db.close();
				resolve(0);
				return;
			}
			const c = db.transaction("tiles", "readonly").objectStore("tiles").count();
			c.onsuccess = () => {
				resolve(c.result);
				db.close();
			};
			c.onerror = () => {
				resolve(-1);
				db.close();
			};
		};
		req.onerror = () => resolve(-1);
	});
}
