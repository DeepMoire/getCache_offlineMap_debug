/** glyphStack.ts — the font stack for every symbol layer, chosen from the live map. ⚠️ Never hardcode a text-font array in a layer definition — call glyphStack()/usesBundledGlyphs() instead; the guard in glyphStacks.test.ts fails the build if a literal stack can't resolve offline. */
import type { Map as MapboxMap } from "mapbox-gl";

/** The only family bundled in `static/mobileAssets/worldBase/glyphs/`. */
const OFFLINE_STACK = ["Noto Sans Regular"];

/** The hosted Mapbox style's stack — Medium weight, the app's default. */
const ONLINE_STACK = ["DIN Pro Medium", "Arial Unicode MS Bold"];

/** Bold variant, for count badges and other emphasis. */
const ONLINE_STACK_BOLD = ["DIN Pro Bold", "Arial Unicode MS Bold"];

export function usesBundledGlyphs(map: MapboxMap): boolean {
	try {
		const glyphs = map.getStyle?.()?.glyphs;
		return typeof glyphs === "string" && glyphs.startsWith("/");
	} catch {
		return false;
	}
}

/** The `text-font` value for a symbol layer on THIS map. */
export function glyphStack(map: MapboxMap, weight: "medium" | "bold" = "medium"): string[] {
	if (usesBundledGlyphs(map)) return OFFLINE_STACK;
	return weight === "bold" ? ONLINE_STACK_BOLD : ONLINE_STACK;
}
