// Regression guard: the dedup key must cover EVERY overlay — keyed on the first only, a second imported PDF collided key-wise and silently never rendered.

import { describe, expect, it } from "vitest";
import { overlayRenderCacheKey } from "./overlayManager.svelte";

const overlay = (mapFeatureKey: string, overlayStorageKey: string | null) => ({
	mapFeatureKey,
	overlayStorageKey,
});

describe("overlayRenderCacheKey", () => {
	it("CHANGES when a second overlay is added to the same map — the bug", () => {
		const mapKey = "map-1";
		const one = [overlay("feat-a", "sheet-a.webp")];
		const two = [...one, overlay("feat-b", "sheet-b.webp")];
		expect(overlayRenderCacheKey(mapKey, two)).not.toBe(
			overlayRenderCacheKey(mapKey, one),
		);
	});

	it("is STABLE when nothing changed — the dedup still works", () => {
		const features = [
			overlay("feat-a", "sheet-a.webp"),
			overlay("feat-b", "sheet-b.webp"),
		];
		expect(overlayRenderCacheKey("map-1", features)).toBe(
			overlayRenderCacheKey("map-1", features),
		);
	});

	it("CHANGES when an overlay is removed", () => {
		const two = [
			overlay("feat-a", "sheet-a.webp"),
			overlay("feat-b", "sheet-b.webp"),
		];
		expect(overlayRenderCacheKey("map-1", [two[0]])).not.toBe(
			overlayRenderCacheKey("map-1", two),
		);
	});

	it("CHANGES when a blob is swapped in place (raw local → optimized)", () => {
		// The no-blink swap path: same feature, new bucket. Must still redraw.
		expect(
			overlayRenderCacheKey("map-1", [overlay("feat-a", "sheet-a.webp")]),
		).not.toBe(
			overlayRenderCacheKey("map-1", [
				overlay("feat-a", "sheet-a.local.webp"),
			]),
		);
	});

	it("CHANGES between maps carrying identically-named overlays", () => {
		const features = [overlay("feat-a", "sheet-a.webp")];
		expect(overlayRenderCacheKey("map-1", features)).not.toBe(
			overlayRenderCacheKey("map-2", features),
		);
	});

	it("distinguishes overlay ORDER — order decides stacking", () => {
		const a = overlay("feat-a", "sheet-a.webp");
		const b = overlay("feat-b", "sheet-b.webp");
		expect(overlayRenderCacheKey("map-1", [a, b])).not.toBe(
			overlayRenderCacheKey("map-1", [b, a]),
		);
	});

	it("handles a map with no overlays", () => {
		expect(overlayRenderCacheKey("map-1", [])).toBe("map-1|");
		expect(overlayRenderCacheKey(null, [])).toBe("|");
	});
});
