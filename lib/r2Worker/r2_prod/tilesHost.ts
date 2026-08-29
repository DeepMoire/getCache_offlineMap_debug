/**
 * ⛔ ONE DEFINITION, imported by both /pack and /fires — two string literals in two files could drift into roads-vs-fires split-brain.
 * ⛔ import.meta.env.DEV is the switch on purpose: true only for `npm run dev`, so a real phone (Capacitor/TestFlight/App Store) always gets production. Don't swap it for a hostname check or runtime flag — a runtime toggle can be left on and ship silently depending on an untended Worker.
 * A local override lets a Worker change be tried against the real R2 bucket before `wrangler deploy` reaches tiles-prod.getcache.org.
 * Deploy production: ./deployProduction.sh — asks for a typed confirmation first.
 */
/**
 * ⛔ NO PRODUCTION HOST IS BAKED IN — the app that mounts this child sets it. A hardcoded default here billed the maintainer's R2 account for every stranger who installed the package (RAPPER.md step 3); npm versions are immutable, so a wrong default can't be recalled.
 * module state, not a parameter — packUrl()/firesUrl() are called deep inside the download path (packDownload.ts:686, fireFetch.ts:85); threading a host through would change every signature to the surface for a value that's constant for the app's lifetime.
 * null, not a fallback — any reachable fallback bills whoever owns it. Unconfigured means NO tiles, per the channel rule (deps.json `_channel_why`).
 * LOCAL_DEV_HOST stays hardcoded on purpose: 127.0.0.1 is nobody's resource and costs nobody anything.
 */
let configuredHost: string | null = null;
let configuredDevHost: string | null = null;

/** call ONCE at app boot, before any tile fetch — trailing slashes are trimmed so a URL with or without one can't produce "//pack" */
export function configureTilesHost(host: string): void {
	configuredHost = host.trim().replace(/\/+$/, "") || null;
}

/** r2_dev is a SECOND deployed Worker reading the SAME R2 data as r2_prod — a difference is always CODE, never data. Injected, never baked in, same reason as production: unconfigured → null → the r2Dev row greys out. */
export function configureTilesDevHost(host: string): void {
	configuredDevHost = host.trim().replace(/\/+$/, "") || null;
}

/** For UI that needs to explain why no tiles are coming. */
export function isTilesHostConfigured(): boolean {
	return configuredHost !== null;
}
/**
 * tiles-local.getcache.org is a DNS A-record pointing at 127.0.0.1 (added 27 Aug 2026, unproxied — Cloudflare can't proxy to loopback) — a NAME for localhost matching the tiles-prod/tiles-dev convention, not a server. It's the one tier added by hand; prod/dev get their records from `wrangler deploy` itself.
 * `npm run dev:local` in workers/offline-tiles seeds the local R2 simulator with a public sample archive first, so it needs no Cloudflare account — the one tier an outside contributor can reach. `wrangler dev --remote` still works with real credentials.
 */
// ⚠️ a name with no DNS is strictly worse than an IP — verified live 27 Aug 2026 (dig +short A tiles-local.getcache.org → 127.0.0.1) before relying on the name
const LOCAL_HOST_NAME = "tiles-local.getcache.org:8787";
export const LOCAL_DEV_HOST = `http://${LOCAL_HOST_NAME}`;

/**
 * the three targets: production/r2_prod (tiles-prod.getcache.org, shipped phones), r2Dev/r2_dev (tiles-dev.getcache.org, a deployed sandbox), localDev/local_dev (127.0.0.1:8787, `wrangler dev --remote`). r2_prod/r2_dev/local_dev is what the CONFIG panel and code say — don't invent a fourth name.
 * ⚠️ r2_dev was dropped 24 Aug and restored 27 Aug — `wrangler dev --remote` only covers it while a terminal stays open; the day it closed, the switch went dead. MEASURED the same day: tiles-dev.getcache.org was still live serving a stale pre-fix build, months after its config was deleted.
 */
export type WorkerTarget = "production" | "r2Dev" | "localDev";

/** null when the tier's host was never configured — production and r2Dev are both injected by the app; localDev is always known. */
/** exported so the CONFIG panel can name the host in diagnostics — "production (https://typo.example.org) unreachable" ends the search a bare "production unreachable" would start. */
export function hostFor(t: WorkerTarget): string | null {
	if (t === "localDev") return LOCAL_DEV_HOST;
	if (t === "r2Dev") return configuredDevHost;
	return configuredHost;
}

/** what the phone talks to with no override: always production — local dev must be picked explicitly via the CONFIG panel */
export const DEFAULT_TARGET: WorkerTarget = "production";

/** ⛔ the override exists only in a DEV build — import.meta.env.DEV is a compile-time constant, so a Capacitor/TestFlight/App Store build has this branch as dead code; session-scoped (sessionStorage) so closing the tab forgets it too. */
const OVERRIDE_KEY = "rt_worker_target";

export function getWorkerTarget(): WorkerTarget {
	if (!import.meta.env.DEV) return "production";
	try {
		const v = sessionStorage.getItem(OVERRIDE_KEY);
		if (v === "production" || v === "r2Dev" || v === "localDev") return v;
	} catch {
		// codestyle-allow-swallow: sessionStorage is unavailable in SSR/private mode; the default target is always correct
	}
	return DEFAULT_TARGET;
}

export function setWorkerTarget(t: WorkerTarget): void {
	if (!import.meta.env.DEV) return;
	try {
		sessionStorage.setItem(OVERRIDE_KEY, t);
	} catch {
		// codestyle-allow-swallow: as above — a failed write just means the default stays in force
	}
}

/** ⚠️ functions, not constants, deliberately — these were consts evaluated once at module load, so a toggle wouldn't take effect until a full reload; call these per request, it's one property read. */
export function tilesHost(): string | null {
	return hostFor(getWorkerTarget());
}

/** roads — one request returns the whole pack of tiles for a pin. null when unconfigured; callers MUST check, or a null host interpolates into the literal string "null/pack". */
export function packUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/pack`;
}

/** wildfire hotspots — the Worker proxies NASA FIRMS so the API key stays server-side. null when unconfigured, see packUrl(). */
export function firesUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/fires`;
}

/** back-compat for callers that only report which host is in play (the debug report) — reads the CURRENT target, unlike the old module-load constant. */
export const TILES_HOST_LABEL = "see tilesHost()";

/**
 * picking "local Dev" without `wrangler dev` running fails silently — a map that never fills, not a clear error — so the switch probes first and greys out what can't answer.
 * ⚠️ probe is an OPTIONS preflight, not /bench — /bench does 500 range reads by default; never use it as a liveness check.
 */
/** Last failure reason per host, so a repeated probe does not repeat the log. */
const lastProbeFailure: Record<string, string> = {};

export async function probeTarget(
	t: WorkerTarget,
	timeoutMs = 1500,
): Promise<boolean> {
	const host = hostFor(t);
	// unconfigured isn't "down" but is equally un-probeable — false is what greys the option out
	if (host === null) return false;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		await fetch(`${host}/pack`, {
			method: "OPTIONS",
			signal: ctl.signal,
			mode: "cors",
		});
		// any answer means something is listening — a 4xx still counts; treating "wrong status" as "absent" would grey out a Worker that's up but answering differently
		return true;
	} catch (err) {
		// ⚠️ say WHY, not just THAT — "unreachable" conflates the Worker being down (deploy it) with the NAME not resolving (a stale negative-DNS cache, up to 30 min TTL).
		// MEASURED 27 Aug 2026: tiles-prod was live and serving 342 KB to curl while this panel showed ERR_NAME_NOT_RESOLVED — the resolver was caching a stale NXDOMAIN.
		// logged once per host, not per probe — probeAll runs on every mount.
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
