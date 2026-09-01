// ⛔ ONE DEFINITION — /pack and /fires both import from here; two literals drift into roads-vs-fires split-brain.
// ⛔ import.meta.env.DEV is the switch — don't swap for a hostname check or runtime flag; a shipped build would silently depend on an untended Worker.
// ⛔ NO PRODUCTION HOST IS BAKED IN — a hardcoded default bills the maintainer's R2 account for every stranger who installs this package; npm versions can't be recalled.
// ⛔ null, never a fallback — any reachable fallback bills whoever owns it.
let configuredHost: string | null = null;
let configuredDevHost: string | null = null;

/** ⚠️ call once at app boot, before any tile fetch */
export function configureTilesHost(host: string): void {
	configuredHost = host.trim().replace(/\/+$/, "") || null;
}

export function configureTilesDevHost(host: string): void {
	configuredDevHost = host.trim().replace(/\/+$/, "") || null;
}

export function isTilesHostConfigured(): boolean {
	return configuredHost !== null;
}
// ⚠️ a name with no DNS record is worse than an IP — check `dig +short A` resolves before changing this.
const LOCAL_HOST_NAME = "tiles-local.getcache.org:8787";
export const LOCAL_DEV_HOST = `http://${LOCAL_HOST_NAME}`;

// ⛔ three tiers only: worker-cloud-prod, worker-cloud-dev, worker-local-dev — don't invent a fourth name.
export type WorkerTarget = "worker-cloud-prod" | "worker-cloud-dev" | "worker-local-dev";

/** null when the tier's host was never configured */
export function hostFor(t: WorkerTarget): string | null {
	if (t === "worker-local-dev") return LOCAL_DEV_HOST;
	if (t === "worker-cloud-dev") return configuredDevHost;
	return configuredHost;
}

export const DEFAULT_TARGET: WorkerTarget = "worker-cloud-prod";

// ⛔ override exists only in a DEV build — import.meta.env.DEV is compile-time, so this branch is dead code on a phone.
const OVERRIDE_KEY = "rt_worker_target";

export function getWorkerTarget(): WorkerTarget {
	if (!import.meta.env.DEV) return "worker-cloud-prod";
	try {
		const v = sessionStorage.getItem(OVERRIDE_KEY);
		if (v === "worker-cloud-prod" || v === "worker-cloud-dev" || v === "worker-local-dev") return v;
		// Pre-rename stored values (31 Aug 2026) — sessionStorage, so this
		// mapping only matters to tabs that lived through the rename.
		if (v === "production") return "worker-cloud-prod";
		if (v === "r2Dev") return "worker-cloud-dev";
		if (v === "localDev") return "worker-local-dev";
	} catch {
		// codestyle-allow-swallow: sessionStorage unavailable in SSR/private mode
	}
	return DEFAULT_TARGET;
}

export function setWorkerTarget(t: WorkerTarget): void {
	if (!import.meta.env.DEV) return;
	try {
		sessionStorage.setItem(OVERRIDE_KEY, t);
	} catch {
		// codestyle-allow-swallow: default target stays in force
	}
}

// ⚠️ functions, not constants — a const read at module load can't see a target chosen later.
export function tilesHost(): string | null {
	return hostFor(getWorkerTarget());
}

/** ⚠️ null when unconfigured — callers MUST check, or null interpolates into the literal URL "null/pack" */
export function packUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/pack`;
}

export function firesUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/fires`;
}

/** Full /hospitals URL for one anchor — the online map's world hospital layer.
 *  The child receives this READY-MADE (mapTypes.ts `hospitalsUrl` option):
 *  route names and hosts are ours, never baked into a published child. */
export function hospitalsUrl(lng: number, lat: number): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/hospitals?lng=${lng}&lat=${lat}`;
}

export const TILES_HOST_LABEL = "see tilesHost()";

// ⚠️ probe with an OPTIONS preflight — never /bench as a liveness check (500 range reads by default).
/** last failure reason per host */
const lastProbeFailure: Record<string, string> = {};

export async function probeTarget(
	t: WorkerTarget,
	timeoutMs = 1500,
): Promise<boolean> {
	const host = hostFor(t);
	if (host === null) return false;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		await fetch(`${host}/pack`, {
			method: "OPTIONS",
			signal: ctl.signal,
			mode: "cors",
		});
		// ⚠️ any answer, even 4xx, counts as up — greying out on status hides a Worker that's up but answering differently.
		return true;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		if (lastProbeFailure[host] !== why) {
			lastProbeFailure[host] = why;
			const dns = /name not resolved|ERR_NAME|getaddrinfo|ENOTFOUND/i.test(why);
			console.warn(
				`[tiles] ${t} probe failed: ${why}` +
					(dns
						? ` — this is DNS, NOT the Worker. The name did not resolve, so nothing was ever contacted. If it was deployed recently a resolver may be caching "does not exist" for up to 30 min (check: dig +short ${new URL(host).hostname}).`
						: " — something answered the name but not the request."),
			);
		}
		return false;
	} finally {
		clearTimeout(timer);
	}
}
