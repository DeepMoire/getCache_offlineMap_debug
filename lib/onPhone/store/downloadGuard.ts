/** downloadGuard — a HARD circuit breaker on offline-map network volume; a safety floor, never a tuning knob. Once tripped, only a reload resets it — a runaway must not be able to un-trip itself. */
import * as Sentry from "@sentry/sveltekit";

/** One satellite bake's tile grid. ~13 legit (3 km z14); >this = an absurd area → stop cold. */
const PER_BAKE_TILE_CAP = 400;
/** Total satellite tiles fetched this session; ~13/area so hundreds of areas — a runaway blows past it, a human won't. */
const SESSION_TILE_CAP = 5000;
/** Total v4 vector /pack downloads across the session. ⚠️ A budget must count what the user does (bake an area), never what the implementation happens to do (issue a request). */
const SESSION_PACK_CAP = 5000;

let sessionTiles = 0;
let sessionPacks = 0;
let tripped = false;
let trippedReason = "";

/** Thrown by every guard once tripped; callers should let it propagate — it aborts the bake/download loop loudly. */
export class DownloadBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DownloadBudgetError";
	}
}

export function isDownloadGuardTripped(): boolean {
	return tripped;
}

function trip(reason: string, extra: Record<string, unknown>): never {
	// Flip the breaker + alert Sentry exactly once; subsequent guards just throw.
	if (!tripped) {
		tripped = true;
		trippedReason = reason;
		// Loud operator signal — this should NEVER fire in normal use.
		console.error(
			`[downloadGuard] 🛑 CIRCUIT TRIPPED — offline-map download runaway blocked: ${reason}`,
			{ ...extra, sessionTiles, sessionPacks },
		);
		try {
			Sentry.captureMessage(
				`[downloadGuard] offline-map runaway BLOCKED — ${reason}`,
				{
					level: "fatal",
					extra: { ...extra, sessionTiles, sessionPacks },
					tags: { area: "offline-download-guard" },
				},
			);
		} catch {
			// Sentry must never mask the real failure — the throw below is what matters.
		}
	}
	throw new DownloadBudgetError(reason);
}

/** Call BEFORE fetching a satellite disc's tiles; trips if this bake's grid is absurdly large, before a single byte downloads. */
export function guardBakeGrid(
	tileCount: number,
	ctx: Record<string, unknown>,
): void {
	if (tripped) throw new DownloadBudgetError(trippedReason);
	if (tileCount > PER_BAKE_TILE_CAP) {
		trip(`single satellite bake grid ${tileCount} > cap ${PER_BAKE_TILE_CAP}`, {
			tileCount,
			...ctx,
		});
	}
}

/** Call once per satellite tile fetched; trips when the running session total blows the ceiling (catches multi-bake / reconcile-loop runaways). */
export function noteSatelliteTiles(n: number): void {
	if (tripped) throw new DownloadBudgetError(trippedReason);
	sessionTiles += n;
	if (sessionTiles > SESSION_TILE_CAP) {
		trip(`session satellite tiles ${sessionTiles} > cap ${SESSION_TILE_CAP}`, {
			sessionTiles,
		});
	}
}

/** Call before each v4 vector /pack download; trips on an implausible number of downloads in one session. */
export function guardPackDownload(ctx: Record<string, unknown>): void {
	if (tripped) throw new DownloadBudgetError(trippedReason);
	sessionPacks += 1;
	if (sessionPacks > SESSION_PACK_CAP) {
		trip(`session pack downloads ${sessionPacks} > cap ${SESSION_PACK_CAP}`, {
			sessionPacks,
			...ctx,
		});
	}
}
