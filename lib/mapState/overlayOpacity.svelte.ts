// Shared overlay-opacity state.
//
// Two surfaces drive this slider:
//   - The inbox feature-detail SideSheet (where the user inspects a PDF
//     overlay feature) — primary location.
//   - The map page's layers panel (MapsLayersPanel2) — secondary, for
//     in-map tuning.
//
// MapDrawControls.svelte registers an applier (an `(opacity) => void`
// callback). Whenever a slider moves it calls `setPercent`, which:
//   1. updates `value` (so both sliders re-render in sync), AND
//   2. synchronously invokes every registered applier, so the map's
//      raster-opacity paint property updates the same tick.
//
// The applier pattern bypasses Svelte's reactive tracking across modules
// (a fragile thing for module-level state) — we just call the listeners
// directly. Simpler and more reliable.
//
// 0.5 default — a new overlay arrives half-transparent so the basemap
// underneath stays readable until the user dials it up. Must match the
// initial `raster-opacity` in the harness's mobMapOverlay.ts so there's no flash
// before the applier syncs.

type Applier = (opacity: number) => void;

class OverlayOpacityStore {
	value = $state(0.5);
	#appliers = new Set<Applier>();

	constructor(initial: number) {
		this.value = initial;
	}

	setPercent(pct: number): void {
		const next = Math.max(0, Math.min(100, pct)) / 100;
		this.value = next;
		for (const fn of this.#appliers) fn(next);
	}

	get percent(): number {
		return Math.round(this.value * 100);
	}

	/** Register a consumer (typically a map page) that wants to push the
	 *  current opacity into a Mapbox layer whenever a slider moves. Fires
	 *  once on register with the current value so freshly mounted maps
	 *  catch up. Returns an unregister function — call it on unmount. */
	register(fn: Applier): () => void {
		this.#appliers.add(fn);
		fn(this.value);
		return () => {
			this.#appliers.delete(fn);
		};
	}
}

export const overlayOpacity = new OverlayOpacityStore(0.5);

// Blanket fill-opacity for ALL drawn polygons — the Legend's Polygon-row
// slider. CENTRE-RESTING like the PDF slider: 0.5 = "as designed", left
// fades every fill toward zero, right BOOSTS fills past their designed
// strength (value × 2 = the multiplier over each polygon's own fill
// opacity — per-feature slider / stack damper / default — capped at fully
// opaque). Outlines are untouched. Applied to the completed-fill layer via
// applyPolygonFillOpacity in $parent/siblings/.../mapDraw.ts.
export const polygonOpacity = new OverlayOpacityStore(0.5);
