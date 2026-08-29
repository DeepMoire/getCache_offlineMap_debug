// NOTE — the snake-ruler is a LIVE measuring tool, not a saved layer, so it has no visibility toggle here (the Legend still lists it, just not as hideable).

// A child may not import SvelteKit's app/environment — same browser check, inlined.
const browser = typeof window !== "undefined";

// `fires` (wildfire hotspot layer) is not one of the user's own marks — it gets a toggle for legend-row consistency, but it defaults ON and RE-ARMS ITSELF (FIRE_HIDE_TTL_MS below) so hiding it can never become a silent standing preference.
export type OverlayKind = "pins" | "plots" | "shapes" | "pdf" | "fires";

const STORAGE_KEY = "retreever-overlay-visibility";
/** When the fire layer was hidden (epoch ms), or 0; a separate key so the visibility blob keeps its shape. */
const FIRE_HIDDEN_AT_KEY = "retreever-fires-hidden-at";

// 12h ≈ one working day — long enough to work a block, short enough that a toggle flipped in July can't still be hiding fires in August.
export const FIRE_HIDE_TTL_MS = 12 * 60 * 60 * 1000;

type VisState = Record<OverlayKind, boolean>;

const DEFAULTS: VisState = {
	pins: true,
	plots: true,
	shapes: true,
	pdf: true,
	fires: true,
};

/** Any unreadable/absent/garbage stamp counts as expired — every failure path lands on SHOWING fires (fail open, not closed). */
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
			// A stale "hidden" older than the TTL is ignored, not honoured — the safe direction is loud, not quiet. [[no-silent-fallbacks]]
			fires: (parsed.fires ?? true) || fireHideExpired(),
		};
	} catch {
		return { ...DEFAULTS };
	}
}

const state = $state<VisState>(load());

// Heal DISK too, not just memory — leaving `fires:false` on disk while the layer shows visible means state and screen disagree and the next reader sees a lie.
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
		// Stamp WHEN fires were hidden so the TTL can expire it back on; showing them again clears the stamp.
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
