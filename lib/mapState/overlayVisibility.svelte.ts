// Overlay visibility — which of the user's drawn map overlays are shown.
//
// A worked map gets BUSY (dozens of plot pins, drawn shapes). This is the single
// source of truth for show/hide per overlay TYPE, flipped by the Legend rows and
// honoured by every render surface (pinMarkers.sync for pin/plot DOM markers, the
// completed-feature GL layers for polygons + lines, overlayManager for the PDF
// overlay layers). Module-level singleton so all three runtime contexts + both
// maps (online Sandbox, offline) read ONE state — no per-route fork.
//
// Persisted to localStorage so a decluttered map stays decluttered across reloads,
// the same way the basemap key persists.
//
// NOTE — the snake-ruler is a LIVE measuring tool, not a saved layer, so it has no
// visibility toggle here; it only exists while you're actively measuring. The Legend
// still LISTS it (it's a real mark you make), it just isn't hideable.

import { browser } from "$app/environment";

// NOTE — `fires` is NOT one of the user's own marks; it is the wildfire hotspot
// layer, and it is the one kind here that is not really "yours to declutter".
// It gets a toggle because every other legend row has one and a lone
// un-toggleable row reads as a bug, but it defaults ON and RE-ARMS ITSELF: see
// FIRE_HIDE_TTL_MS below. A planter who hides fires while working a block must
// not silently still have them hidden a week later.
export type OverlayKind = "pins" | "plots" | "shapes" | "pdf" | "fires";

const STORAGE_KEY = "retreever-overlay-visibility";
/** When the fire layer was hidden (epoch ms), or 0. Separate key so the
 *  visibility blob keeps its shape. */
const FIRE_HIDDEN_AT_KEY = "retreever-fires-hidden-at";

/**
 * How long "hide fires" lasts before it expires back to ON.
 *
 * Hiding hazard information is a MOMENTARY act ("I'm reading my plot numbers
 * and the flames are in the way"), never a standing preference. Every other
 * overlay here is the user's own drawing, so hiding it forever is fine; fire is
 * someone else's ground truth, and a toggle they flipped once in July must not
 * be why they don't see a fire in August. 12 h ≈ one working day.
 */
export const FIRE_HIDE_TTL_MS = 12 * 60 * 60 * 1000;

type VisState = Record<OverlayKind, boolean>;

const DEFAULTS: VisState = {
	pins: true,
	plots: true,
	shapes: true,
	pdf: true,
	fires: true,
};

/**
 * Has a "fires hidden" stamp aged out? Any unreadable/absent//garbage stamp
 * counts as expired, so every failure path lands on SHOWING fires.
 */
function fireHideExpired(): boolean {
	try {
		const at = Number(localStorage.getItem(FIRE_HIDDEN_AT_KEY));
		if (!Number.isFinite(at) || at <= 0) return true;
		return Date.now() - at >= FIRE_HIDE_TTL_MS;
	} catch {
		return true;
	}
}

function load(): VisState {
	if (!browser) return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULTS };
		const parsed = JSON.parse(raw) as Partial<VisState>;
		return {
			pins: parsed.pins ?? true,
			plots: parsed.plots ?? true,
			shapes: parsed.shapes ?? true,
			pdf: parsed.pdf ?? true,
			// Fires re-arm on their own — a stale "hidden" older than the TTL is
			// ignored rather than honoured ([[no-silent-fallbacks]] in spirit: the
			// safe direction is loud, not quiet).
			fires: (parsed.fires ?? true) || fireHideExpired(),
		};
	} catch {
		return { ...DEFAULTS };
	}
}

const state = $state<VisState>(load());

// If the fire hide expired during load(), heal DISK too — not just memory.
// Leaving `fires:false` on disk with the layer visible means the stored state
// and the screen disagree, and the next reader (a test, a devtools poke, a
// future migration) sees a lie. Clearing the stamp is what actually ends the
// hide; the value above only reflects it.
if (browser && state.fires) {
	try {
		if (localStorage.getItem(FIRE_HIDDEN_AT_KEY) !== null) {
			localStorage.removeItem(FIRE_HIDDEN_AT_KEY);
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		}
	} catch {
		// codestyle-allow-swallow: a blocked localStorage must not break the map.
	}
}

function persist(): void {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// codestyle-allow-swallow: a full/blocked localStorage must not break the map.
	}
}

export const overlayVisibility = {
	get pins() {
		return state.pins;
	},
	get plots() {
		return state.plots;
	},
	get shapes() {
		return state.shapes;
	},
	get pdf() {
		return state.pdf;
	},
	get fires() {
		return state.fires;
	},
	/** Read one kind by key (lets generic UI rows bind without a switch). */
	isVisible(kind: OverlayKind): boolean {
		return state[kind];
	},
	toggle(kind: OverlayKind): void {
		this.set(kind, !state[kind]);
	},
	set(kind: OverlayKind, visible: boolean): void {
		state[kind] = visible;
		// Stamp WHEN fires were hidden, so the TTL above can expire it back on.
		// Showing them again clears the stamp.
		if (kind === "fires" && browser) {
			try {
				if (visible) localStorage.removeItem(FIRE_HIDDEN_AT_KEY);
				else localStorage.setItem(FIRE_HIDDEN_AT_KEY, String(Date.now()));
			} catch {
				// codestyle-allow-swallow: a blocked localStorage must not break the map.
			}
		}
		persist();
	},
};
