import { noteProbe } from "../../shared/workMeter.svelte";
// ⛔ ONE DEFINITION — /pack and /fires both import from here; two literals drift into roads-vs-fires split-brain.
// ⛔ import.meta.env.DEV is the switch — don't swap for a hostname check or runtime flag; a shipped build would silently depend on an untended Worker.
// ⛔ NO PRODUCTION HOST IS BAKED IN — a hardcoded default bills the maintainer's R2 account for every stranger who installs this package.
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
// ⛔ tiers are named tiles-prod / tiles-dev / tiles-local — a bare IP here breaks the convention.
const LOCAL_HOST_NAME = "tiles-local.getcache.org:8787";
export const LOCAL_DEV_HOST = `http://${LOCAL_HOST_NAME}`;

// ⛔ three tiers only: production/r2_prod, r2Dev/r2_dev, localDev/local_dev — don't invent a fourth name.
export type WorkerTarget = "production" | "r2Dev" | "localDev";

/** null when the tier's host was never configured */
export function hostFor(t: WorkerTarget): string | null {
	if (t === "localDev") return LOCAL_DEV_HOST;
	if (t === "r2Dev") return configuredDevHost;
	return configuredHost;
}

// ⚠️ DEV BUILDS START ON THE DEVELOPER'S OWN MACHINE (Chris, 31 Aug 2026:
// "point at the local one that's broken and he can fix it"). A shipped build
// never reads this — getWorkerTarget()'s !DEV early return hard-locks phones
// to production; THAT line is the safety, not this constant.
export const DEFAULT_TARGET: WorkerTarget = "localDev";

// ⛔ override exists only in a DEV build — import.meta.env.DEV is compile-time, so this branch is dead code on a phone.
const OVERRIDE_KEY = "rt_worker_target";

// ⚠️ Two authorities, two homes: a HUMAN click persists (sessionStorage); the boot
// fallback is memory-only, so every reload starts back at DEFAULT_TARGET (local-first).
// Persisting the fallback let a machine guess masquerade as a choice — the panel then
// opened on production every time, looking like the local-first default never landed.
let fallbackTarget: WorkerTarget | null = null;

export function getWorkerTarget(): WorkerTarget {
	if (!import.meta.env.DEV) return "production";
	try {
		const v = sessionStorage.getItem(OVERRIDE_KEY);
		if (v === "production" || v === "r2Dev" || v === "localDev") return v;
	} catch {
		// codestyle-allow-swallow: sessionStorage unavailable in SSR/private mode
	}
	return fallbackTarget ?? DEFAULT_TARGET;
}

export function setWorkerTarget(t: WorkerTarget, opts?: { fallback?: boolean }): void {
	if (!import.meta.env.DEV) return;
	if (opts?.fallback) {
		fallbackTarget = t;
		return;
	}
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
	if (h !== lastAnnouncedPackHost) {
		lastAnnouncedPackHost = h;
		if (h === null) {
			console.error(
				`[tiles] ⛔ NO HOST for target "${getWorkerTarget()}" — no /pack request will be sent. ` +
					"Nothing will appear in the Network tab. Set VITE_TILES_HOST (or pick a reachable target).",
			);
		} else {
			console.info(`[tiles] ✅ /pack will be fetched from ${h}`);
		}
	}
	return h === null ? null : `${h}/pack`;
}

/** undefined = never announced, null = announced as unconfigured */
let lastAnnouncedPackHost: string | null | undefined;

export function firesUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/fires`;
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
		noteProbe(t, true);
		return true;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		noteProbe(t, false);
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
