/** offlineColors.ts — THE ONE source of truth for offline-map colours; ⛔ USER-OWNED, never change any hex without explicit permission. */

/** Every blue water LINE — base rivers, big-tile rivers, small-tile rivers. */
export const WATER_LINE = "#091777";

/** Pooled water FILL (lakes) — dark dark blue. Also the ocean / background. */
export const WATER_FILL = "#05101f";

/** Every road LINE — the DEFAULT/secondary road colour (kind `medium_road` and anything unmatched); major + minor classes branch to their own hues below. */
export const ROAD_LINE = "#413413";

/** Major arterials (kind `major_road`/`highway`) — muted rust-brown, HUE only (same thin width as all roads); user-chosen. */
export const ROAD_MAJOR_LINE = "#80563C";

/** Paths/trails (kind `path`) — dark, dull green, dashed in its own layer; deliberately dim/receded so they don't pop. */
export const PATH_LINE = "#3d4a30";

/** Railways (kind `rail`) — dark desaturated grey-blue, ladder-dashed in its own layer, distinct from roads (brown) and trails (green). */
export const RAIL_LINE = "#4a525e";

/** Accent gold for GL layer paints — JS-side twin of the app's `--rt-gold-1`/`--color-accent` CSS token (Mapbox paint can't read CSS vars); keep the same value. */
export const ACCENT_GOLD_LINE = "#f5d565";

