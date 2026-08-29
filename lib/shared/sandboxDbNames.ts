export const SANDBOX_SUFFIX = "-sandbox";

let sandboxActive = false;

/** Called by enterSandbox/exitSandbox to flip the offline-storage target. */
export function setSandboxStorageActive(active: boolean): void {
	sandboxActive = active;
	// Mirror onto a window global so rapper (must NOT import proprietary $lib/mobile — open-core rule) can read sandbox state and redirect "maps" → "maps-sandbox".
	if (typeof window !== "undefined") {
		(window as { __rt_sandbox_active?: boolean }).__rt_sandbox_active = active;
	}
}

export function isSandboxStorageActive(): boolean {
	return sandboxActive;
}

/** Resolve the live DB name for a base name — `<name>-sandbox` in sandbox. */
export function currentDbName(realName: string): string {
	return sandboxActive ? realName + SANDBOX_SUFFIX : realName;
}

const resetFns = new Set<() => void>();

/** Offline module registers a fn that clears its cached open-DB handle. */
export function registerOfflineDbReset(fn: () => void): void {
	resetFns.add(fn);
}

/** ⛔ SEPARATE FROM `resetOfflineDbHandles`, DELIBERATELY — sandbox toggling needs reopen, but a wipe needs reads to refuse reopening or `deleteDatabase` blocks. */
interface WipeLatch {
	/** Stop this module's reads reopening the DB. */
	latch: () => void;
	/** Allow reads again — ONLY when the wipe did not happen. */
	unlatch: () => void;
}

const wipeLatchFns = new Set<WipeLatch>();

/** A module registers the pair that stops, and restores, its reads during a wipe. */
export function registerWipeLatch(l: WipeLatch): void {
	wipeLatchFns.add(l);
}

/** Latch every registered reader OFF before deleting. Reads become misses. */
export function latchOfflineReadsForWipe(): void {
	for (const l of wipeLatchFns) {
		try {
			l.latch();
		} catch {
			/* best-effort: a failed latch just means that delete may block */
		}
	}
}

/** ⛔ Never call after a successful wipe — this is the only escape from a permanent blackout: a latched read returns null silently forever ("roads disappeared and never came back"). */
export function unlatchOfflineReadsAfterFailedWipe(): void {
	for (const l of wipeLatchFns) {
		try {
			l.unlatch();
		} catch {
			/* best-effort */
		}
	}
}

/** Drop every cached offline-DB handle so the next open() reopens correctly. */
export function resetOfflineDbHandles(): void {
	for (const fn of resetFns) {
		try {
			fn();
		} catch {
			/* best-effort: a failed reset just means that module reopens lazily */
		}
	}
}

/** Delete every "<name>-sandbox" offline DB — wipes the sandbox's offline cache without touching the real ones. */
export async function deleteSandboxOfflineDbs(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const bases = ["rt-tiles-v3", "rt-satellite", "rt-vectors", "rt-mapRegistry"];
	await Promise.all(
		bases.map(
			(b) =>
				new Promise<void>((resolve) => {
					const req = indexedDB.deleteDatabase(b + SANDBOX_SUFFIX);
					req.onsuccess = () => resolve();
					req.onerror = () => resolve();
					req.onblocked = () => resolve();
				}),
		),
	);
}
