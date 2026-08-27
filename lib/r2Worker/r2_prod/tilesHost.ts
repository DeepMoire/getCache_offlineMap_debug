/**
 * WHICH offline-tiles Worker the app talks to. ONE definition, both routes.
 *
 * ⛔ WHY THIS FILE EXISTS AT ALL
 *
 * `wrangler deploy` publishes straight to tiles.retreever.org — the hostname
 * every shipped phone talks to. A local override lets a Worker change be
 * tried on your own machine, against the real R2 bucket, before it ever
 * reaches that hostname.
 *
 * TWO TIERS, ON PURPOSE (Chris's call, 24 Aug 2026, after weighing a third
 * "dev" cloud tier and deciding against it): local_dev and production. Local
 * `wrangler dev --remote` already tests against real R2 data with no deploy
 * step, so a cloud staging Worker added upkeep (a second live Worker, a
 * third `wrangler` invocation, three-way state everywhere WorkerTarget is
 * used) without adding test fidelity a local run doesn't already have.
 *
 * The "don't push to prod by accident" risk this was meant to guard against
 * is handled at the actual dangerous step instead: `deployProduction.sh`
 * requires a typed confirmation before `wrangler deploy` runs bare. That
 * guards the ACTION; a third toggle position here only would have decorated
 * the read side. Do not re-add a cloud dev tier without asking first — if
 * the confirm guard isn't enough friction, that's the thing to strengthen.
 *
 * ⛔ WHY import.meta.env.DEV IS THE RIGHT SWITCH, AND WHAT IT IS NOT
 *
 * It is true ONLY for `npm run dev`. A Capacitor / TestFlight / App Store build
 * is a production Vite build, so a real phone ALWAYS gets the production
 * Worker. Do not swap this for a hostname check or a runtime flag: a runtime
 * toggle can be left switched on, and then a shipped build quietly depends on
 * a Worker nobody promised to keep alive.
 *
 * ⛔ ONE DEFINITION ON PURPOSE. Both /pack (roads) and /fires import from here.
 * When these were two string literals in two files they were free to drift, and
 * a half-migrated pair would have meant roads from one target and fires from
 * another — the kind of split-brain that reads as "it works sometimes".
 *
 * Deploy production:  ./deployProduction.sh   ← asks for confirmation first
 */
/**
 * ⛔ NO PRODUCTION HOST IS BAKED IN. THE APP THAT MOUNTS THIS CHILD SETS IT.
 *
 * This file used to open with:
 *
 *     export const PRODUCTION_HOST = "https://tiles.retreever.org";
 *
 * That is a bill, not a default. This child is published as its own AGPL
 * package, so a stranger who installed it streamed tiles off the maintainer's
 * R2 bucket, on the maintainer's account, indistinguishable from real traffic — and
 * npm versions are immutable, so a wrong default cannot be recalled by a later
 * release. It was RAPPER.md step 3, "the one leak still parked".
 *
 * WHY MODULE STATE AND NOT A PARAMETER. packUrl() is called at
 * roads/packDownload.ts:686 and firesUrl() at fires/fireFetch.ts:85 — deep
 * inside the download path, never passed down. Threading a host through would
 * change signatures the whole way to the surface, for a value that is constant
 * for the lifetime of the app. One call at boot is the smaller change.
 *
 * WHY NULL AND NOT A FALLBACK. Any fallback that happens to be reachable is a
 * fallback that bills whoever owns it. Unconfigured means NO tiles — which is
 * the channel rule this child already lives by (deps.json `_channel_why`):
 * "Anything the channel does not provide comes back null and the child renders
 * nothing rather than crashing."
 *
 * LOCAL_DEV_HOST below stays hardcoded on purpose: 127.0.0.1 is nobody's
 * resource and costs nobody anything.
 */
let configuredHost: string | null = null;
let configuredDevHost: string | null = null;

/** Call ONCE at app boot, before any tile fetch. Trailing slashes are trimmed
 *  so `https://x.dev/` and `https://x.dev` cannot produce `//pack`. */
export function configureTilesHost(host: string): void {
	configuredHost = host.trim().replace(/\/+$/, "") || null;
}

/**
 * THE CLOUD DEV WORKER — same injection rule as production, same reason.
 *
 * `r2_dev` is a SECOND deployed Worker, not a second bucket: it reads the very
 * same R2 data as `r2_prod`, so a difference between them is always CODE and
 * never data. That is the whole point of having it — you deploy a change there
 * and compare against production without touching what shipped phones read.
 *
 * Injected, never baked in, for exactly the reason the production host is (see
 * the block above): this child is published on its own, and a hardcoded origin
 * would bill whoever owns it. Unconfigured → null → the r2Dev row greys out.
 */
export function configureTilesDevHost(host: string): void {
	configuredDevHost = host.trim().replace(/\/+$/, "") || null;
}

/** For UI that needs to explain why no tiles are coming. */
export function isTilesHostConfigured(): boolean {
	return configuredHost !== null;
}
/**
 * THE LOCAL TIER — `tiles-local.retreever.org`, the third of dev/prod/local.
 *
 * ⛔ ONE CONVENTION, READ AT A GLANCE. The three tiers are named the same way
 * on purpose: tiles-prod / tiles-dev / tiles-local. A bare IP here broke that
 * — it was the one row you could not read as a tier, and the panel showed
 * "127.0.0.1:8787" beside two dotted hostnames.
 *
 * `tiles-local.retreever.org` is a DNS record pointing at 127.0.0.1. It costs
 * nothing (no Worker, no bill, no Cloudflare account for whoever uses it) and
 * resolves to the developer's own machine, exactly as the bare IP did. It is a
 * NAME for localhost, not a server.
 *
 * ⚠️ UNTIL THAT RECORD EXISTS, keep the loopback address: a name with no DNS
 * is strictly worse than an ugly IP — it fails at resolution with no clue,
 * which is precisely the failure that cost 27 Aug 2026. Flip LOCAL_HOST_NAME
 * to the hostname the day the record is created, and not before.
 *
 * `wrangler dev --remote` in workers/offline-tiles serves it. `--remote` is
 * required to reach the real R2 bucket — the checked-in planet.pmtiles is a
 * 0-byte placeholder.
 */
const LOCAL_HOST_NAME = "127.0.0.1:8787"; // → "tiles-local.retreever.org" once DNS exists
export const LOCAL_DEV_HOST = `http://${LOCAL_HOST_NAME}`;

/**
 * THE THREE PLACES BLOBS CAN COME FROM. Chris's naming, 27 Aug 2026.
 *
 *   production / r2_prod — tiles.retreever.org. Every shipped phone. Real users.
 *   r2Dev      / r2_dev  — tiles-dev.retreever.org. A deployed sandbox worker.
 *   localDev   / local_dev — 127.0.0.1:8787, `wrangler dev --remote`.
 *
 * The r2_prod / r2_dev / local_dev spellings are what the CONFIG panel shows
 * and what we say out loud; the camelCase ids are the same three things in
 * code. Don't invent a fourth name for any of them.
 *
 * WHY r2_dev CAME BACK (it was dropped 24 Aug, restored 27 Aug). The argument
 * for dropping it was that `wrangler dev --remote` tests the same thing with
 * less upkeep. True — but it only works while a terminal is open, and the day
 * that terminal was closed the switch went dead and read as a broken app.
 * MEASURED the same day: tiles-dev.retreever.org was STILL LIVE and still
 * serving the pre-fix v29 build, months after its config block was deleted —
 * so the upkeep was being paid without the benefit. Adopting it is cheaper
 * than pretending it is gone.
 */
export type WorkerTarget = "production" | "r2Dev" | "localDev";

/** null when the tier's host was never configured — production and r2Dev are
 *  both injected by the app, so either can be null; localDev is always known. */
/** EXPORTED so the CONFIG panel can NAME the host in its diagnostics. A log
 *  saying "production unreachable" sends you looking at Cloudflare; one saying
 *  "production (https://typo.example.org) unreachable" ends the search. */
export function hostFor(t: WorkerTarget): string | null {
	if (t === "localDev") return LOCAL_DEV_HOST;
	if (t === "r2Dev") return configuredDevHost;
	return configuredHost;
}

/** What the phone talks to with no override: always production. Local dev
 *  must be picked explicitly via the CONFIG panel — see the DEV note above. */
export const DEFAULT_TARGET: WorkerTarget = "production";

/**
 * ⛔ THE OVERRIDE EXISTS ONLY IN A DEV BUILD.
 *
 * The warning above says a runtime toggle can be left switched on and then a
 * shipped build quietly depends on a Worker nobody promised to keep alive.
 * That risk is real, so the switch is not defended by remembering to turn it
 * off — `import.meta.env.DEV` is a compile-time constant, so in a Capacitor /
 * TestFlight / App Store build this whole branch is DEAD CODE that Vite drops.
 * A production build cannot read the override even if something writes it.
 *
 * Session-scoped (sessionStorage) so it also cannot outlive the tab it was set
 * in — closing the tab is enough to forget it.
 */
const OVERRIDE_KEY = "rt_worker_target";

export function getWorkerTarget(): WorkerTarget {
	if (!import.meta.env.DEV) return "production";
	try {
		const v = sessionStorage.getItem(OVERRIDE_KEY);
		if (v === "production" || v === "r2Dev" || v === "localDev") return v;
	} catch {
		// codestyle-allow-swallow: sessionStorage is unavailable in SSR and in
		// some private modes; the default target is always a correct answer.
	}
	return DEFAULT_TARGET;
}

export function setWorkerTarget(t: WorkerTarget): void {
	if (!import.meta.env.DEV) return;
	try {
		sessionStorage.setItem(OVERRIDE_KEY, t);
	} catch {
		// codestyle-allow-swallow: as above — a failed write just means the
		// default stays in force, which is the safe outcome.
	}
}

/**
 * ⚠️ FUNCTIONS, NOT CONSTANTS — deliberately.
 *
 * These were `export const PACK_URL = ...`, evaluated once at module load. A
 * const cannot see a target chosen later, so a toggle would have appeared to do
 * nothing until a full reload — and "the switch does nothing" is how you end up
 * testing production while believing you are on staging. Call these per
 * request; it is one property read.
 */
export function tilesHost(): string | null {
	return hostFor(getWorkerTarget());
}

/** Roads. One request returns the whole pack of tiles for a pin.
 *  null when no host is configured — callers MUST check. Interpolating null
 *  would fetch the literal string "null/pack", which is a silent wrong URL. */
export function packUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/pack`;
}

/** Wildfire hotspots. The Worker proxies NASA FIRMS so the API key stays
 *  server-side. null when unconfigured — see packUrl(). */
export function firesUrl(): string | null {
	const h = tilesHost();
	return h === null ? null : `${h}/fires`;
}

/** Back-compat for callers that only report which host is in play (the debug
 *  report). Reads the CURRENT target, unlike the old module-load constant. */
export const TILES_HOST_LABEL = "see tilesHost()";

/**
 * IS THIS WORKER ACTUALLY THERE?
 *
 * A developer who picks "local Dev" without `wrangler dev` running gets no
 * error — just a map that never fills, which reads as "the offline map is
 * broken" rather than "nothing is listening on 8787". So the switch asks first
 * and greys out what cannot answer.
 *
 * Probe is an OPTIONS preflight, not /bench: the CORS handler answers it
 * without a single R2 read, so this costs nothing even against production.
 * (/bench does 500 range reads by default — never use it as a liveness check.)
 */
export async function probeTarget(
	t: WorkerTarget,
	timeoutMs = 1500,
): Promise<boolean> {
	const host = hostFor(t);
	// Nothing configured is not "down", but it is equally un-probeable, and
	// false is what the switch needs to grey the option out.
	if (host === null) return false;
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		await fetch(`${host}/pack`, {
			method: "OPTIONS",
			signal: ctl.signal,
			mode: "cors",
		});
		// ANY answer means something is listening. A 4xx still proves reachable,
		// and treating "wrong status" as "absent" would grey out a Worker that
		// is up but answering differently than expected.
		return true;
	} catch {
		// codestyle-allow-swallow: unreachable IS the answer here, not an error.
		return false;
	} finally {
		clearTimeout(timer);
	}
}
