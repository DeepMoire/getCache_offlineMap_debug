import { noteProbe } from "../../shared/workMeter.svelte";
/**
 * WHICH offline-tiles Worker the app talks to. ONE definition, both routes.
 * ⛔ Two tiers only (local_dev, production) — do not re-add a cloud dev tier without asking first; if deployProduction.sh's confirm guard isn't enough friction, strengthen that instead.
 * ⛔ import.meta.env.DEV is the switch (true only for `npm run dev`) — do not swap for a hostname check or runtime flag; a runtime toggle can be left on and a shipped build silently depends on a Worker nobody promised to keep alive.
 * ⛔ ONE DEFINITION — both /pack and /fires import from here; two literals could drift into split-brain (roads from one target, fires from another).
 * Deploy production: ./deployProduction.sh — asks for confirmation first.
 */
/**
 * ⛔ NO PRODUCTION HOST IS BAKED IN — the app that mounts this child sets it via configureTilesHost(); a hardcoded default would bill the maintainer's R2 account for every stranger who installs this package.
 * LOCAL_DEV_HOST stays hardcoded on purpose — 127.0.0.1 is nobody's resource and costs nobody anything.
 */
let configuredHost: string | null = null;
let configuredDevHost: string | null = null;

/** Call once at app boot, before any tile fetch — trailing slashes are trimmed so `https://x.dev/` and `https://x.dev` cannot produce `//pack`. */
export function configureTilesHost(host: string): void {
	configuredHost = host.trim().replace(/\/+$/, "") || null;
}

// r2_dev is a second deployed Worker (not a second bucket) reading the same R2 data as r2_prod — a difference between them is always code, never data; unconfigured → null → the r2Dev row greys out.
export function configureTilesDevHost(host: string): void {
	configuredDevHost = host.trim().replace(/\/+$/, "") || null;
}

/** For UI that needs to explain why no tiles are coming. */
export function isTilesHostConfigured(): boolean {
	return configuredHost !== null;
}
/**
 * THE LOCAL TIER — `tiles-local.getcache.org`, the third of dev/prod/local.
 * ⛔ ONE CONVENTION — tiers are named tiles-prod / tiles-dev / tiles-local; a bare IP here breaks that (unreadable as a tier).
 */
const LOCAL_HOST_NAME = "tiles-local.getcache.org:8787";
export const LOCAL_DEV_HOST = `http://${LOCAL_HOST_NAME}`;

// three tiers: production/r2_prod (tiles-prod.getcache.org, real users), r2Dev/r2_dev (tiles-dev.getcache.org, sandbox), localDev/local_dev (127.0.0.1:8787, wrangler dev --remote) — don't invent a fourth name.
export type WorkerTarget = "production" | "r2Dev" | "localDev";

/** null when the tier's host was never configured — production and r2Dev are injected by the app so either can be null; localDev is always known. */
/** Exported so the CONFIG panel can name the host in its diagnostics (e.g. "production (https://x) unreachable" vs just "production unreachable"). */
export function hostFor(t: WorkerTarget): string | null {
	if (t === "localDev") return LOCAL_DEV_HOST;
	if (t === "r2Dev") return configuredDevHost;
	return configuredHost;
}

/** With no override the phone always talks to production; local dev must be picked explicitly via the CONFIG panel. */
export const DEFAULT_TARGET: WorkerTarget = "production";

// ⛔ the override exists only in a DEV build — import.meta.env.DEV is compile-time, so this whole branch is dead code in a Capacitor/TestFlight/App Store build; session-scoped so closing the tab forgets it too.
const OVERRIDE_KEY = "rt_worker_target";

export function getWorkerTarget(): WorkerTarget {
	if (!import.meta.env.DEV) return "production";
	try {
		const v = sessionStorage.getItem(OVERRIDE_KEY);
		if (v === "production" || v === "r2Dev" || v === "localDev") return v;
	} catch {
		// codestyle-allow-swallow: sessionStorage is unavailable in SSR and in some private modes; the default target is always a correct answer.
	}
	return DEFAULT_TARGET;
}

export function setWorkerTarget(t: WorkerTarget): void {
	if (!import.meta.env.DEV) return;
	try {
		sessionStorage.setItem(OVERRIDE_KEY, t);
	} catch {
		// codestyle-allow-swallow: as above — a failed write just means the default stays in force, which is the safe outcome.
	}
}

// ⚠️ functions, not constants — a const evaluated at module load can't see a target chosen later; the toggle would look inert until a full reload. Call per request.
export function tilesHost(): string | null {
	return hostFor(getWorkerTarget());
}

/** Roads: one request returns the whole pack for a pin. null when unconfigured — callers MUST check; interpolating null would silently fetch the literal URL "null/pack". */
export function packUrl(): string | null {
	const h = tilesHost();
	// a null host is a silent failure — the fetch is skipped before the network, so DevTools > Network shows nothing; logged on state change only, not per call, since packUrl() runs every bake slice.
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

/** Last host packUrl() reported, so it logs transitions only; undefined = never announced, null = announced as unconfigured. */
let lastAnnouncedPackHost: string | null | undefined;

/** Wildfire hotspots — the Worker proxies NASA FIRMS so the API key stays server-side; null when unconfigured, see packUrl(). */
export function firesUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/fires`;
}

/** Back-compat for callers that just report which host is in play; reads the CURRENT target, unlike the old module-load constant. */
export const TILES_HOST_LABEL = "see tilesHost()";

// probe an OPTIONS preflight (CORS handler, zero R2 reads) so it costs nothing even against production — never use /bench as a liveness check (500 range reads by default).
/** Last failure reason per host, so a repeated probe does not repeat the log. */
const lastProbeFailure: Record<string, string> = {};

export async function probeTarget(
	t: WorkerTarget,
	timeoutMs = 1500,
): Promise<boolean> {
	const host = hostFor(t);
	// nothing configured is not "down" but is equally un-probeable — false is what greys the option out.
	if (host === null) return false;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		await fetch(`${host}/pack`, {
			method: "OPTIONS",
			signal: ctl.signal,
			mode: "cors",
		});
		// any answer (even 4xx) means something is listening — treating "wrong status" as "absent" would grey out a Worker that's up but answering differently.
		noteProbe(t, true);
		return true;
	} catch (err) {
		// distinguish WHY, not just that it failed — "unreachable" can mean the Worker is down (deploy it) or the name doesn't resolve (stale negative DNS); logged once per host, not per probe.
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
