import { beforeEach, describe, expect, it, vi } from "vitest";

// The suite runs in the `node` environment (vitest.config.ts), so localStorage
// and location have to be stubbed — same approach as mapViewport.test.ts, which
// covers the sibling camera keys.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
});
vi.stubGlobal("location", { search: "" });

import {
	OFFLINE_MAP_ROUTE,
	ONLINE_MAP_ROUTE,
	isMapPath,
	loadLastMapRoute,
	resetLastMapRouteCache,
	saveLastMapRoute,
	seeOnMapUrl,
} from "./lastMapRoute.svelte";

const KEY = "retreever-last-map-route";

describe("lastMapRoute", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.stubGlobal("location", { search: "" });
		// The route is held in a module-level reactive cell that is seeded ONCE
		// (that is the whole fix — a per-call localStorage read is not reactive).
		// So clearing storage no longer clears the answer; the cell has to be
		// dropped too, or every test after the first inherits its predecessor's
		// value.
		resetLastMapRouteCache();
	});

	describe("the default", () => {
		it("opens the ONLINE map when nothing is stored", () => {
			// First run. The online map is the safe default because it needs no
			// downloaded pack — a brand-new user sent to the offline map would
			// get an empty world.
			expect(loadLastMapRoute()).toBe(ONLINE_MAP_ROUTE);
		});

		it("falls back to ONLINE when the stored value is unrecognised", () => {
			// A stale value from a renamed route, or a corrupt write. Handing an
			// unknown path to `goto` would 404 the MAP tab, so it must be rejected
			// rather than trusted.
			localStorage.setItem(KEY, "/some-route-that-no-longer-exists");
			expect(loadLastMapRoute()).toBe(ONLINE_MAP_ROUTE);
		});
	});

	describe("stickiness — the whole point", () => {
		it("returns the OFFLINE map after the offline route records itself", () => {
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			expect(loadLastMapRoute()).toBe(OFFLINE_MAP_ROUTE);
		});

		it("survives a round trip back to online", () => {
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			saveLastMapRoute(ONLINE_MAP_ROUTE);
			expect(loadLastMapRoute()).toBe(ONLINE_MAP_ROUTE);
		});

		it("ignores a route that is not one of the two maps", () => {
			// Guards against a future third caller poisoning the tab target.
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			saveLastMapRoute("/cache" as never);
			expect(loadLastMapRoute()).toBe(OFFLINE_MAP_ROUTE);
		});
	});

	describe("seeOnMapUrl — every eye follows the sticky choice", () => {
		it("targets the ONLINE map by default, carrying its params", () => {
			const url = seeOnMapUrl({ map: "m1", feature: "f1" });
			expect(url).toBe(`${ONLINE_MAP_ROUTE}?map=m1&feature=f1`);
		});

		it("targets the OFFLINE map once offline is the last-used one", () => {
			// THE REGRESSION THIS LOCKS: tapping an eye while on the offline map
			// used to throw the user onto the online map, silently, mid-task.
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			const url = seeOnMapUrl({ map: "m1", plots: "a,b" });
			expect(url).toBe(`${OFFLINE_MAP_ROUTE}?map=m1&plots=a%2Cb`);
		});

		it("encodes keys that contain URL-significant characters", () => {
			// The hand-rolled callers all used encodeURIComponent; URLSearchParams
			// must not regress that.
			const url = seeOnMapUrl({ map: "a b&c=d" });
			expect(url).toBe(`${ONLINE_MAP_ROUTE}?map=a+b%26c%3Dd`);
		});

		it("accepts a URLSearchParams (the quality704 callers' shape)", () => {
			const q = new URLSearchParams();
			q.set("map", "m1");
			expect(seeOnMapUrl(q)).toBe(`${ONLINE_MAP_ROUTE}?map=m1`);
		});

		it("returns a bare route when there are no params", () => {
			// quality704's goToMapToDropPlot builds an EMPTY param set when the
			// survey has no map yet. A trailing "?" must not appear.
			expect(seeOnMapUrl(new URLSearchParams())).toBe(ONLINE_MAP_ROUTE);
			expect(seeOnMapUrl()).toBe(ONLINE_MAP_ROUTE);
		});
	});

	describe("the sandbox world keeps its own choice", () => {
		it("does not let the practice world change the real app's MAP tab", () => {
			// localStorage is SHARED between the real app and ?sandbox=1, so the
			// key is suffixed per world — the same rule the camera keys follow
			// (mapViewport.ts). Roaming the practice map must never decide which
			// map the real app opens.
			saveLastMapRoute(ONLINE_MAP_ROUTE);

			vi.stubGlobal("location", { search: "?sandbox=1" });
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			expect(loadLastMapRoute()).toBe(OFFLINE_MAP_ROUTE);

			vi.stubGlobal("location", { search: "" });
			expect(loadLastMapRoute()).toBe(ONLINE_MAP_ROUTE);
		});
	});

	describe("isMapPath — which paths light the MAP tab", () => {
		it("is true for BOTH map routes", () => {
			// The bug this fixes: the two routes are SIBLINGS, so the tab bar's
			// generic startsWith(href) test went dark on the offline map — the
			// user was on the map with no tab lit.
			expect(isMapPath(ONLINE_MAP_ROUTE)).toBe(true);
			expect(isMapPath(OFFLINE_MAP_ROUTE)).toBe(true);
		});

		it("is true for sub-paths and query-bearing paths", () => {
			expect(isMapPath("/map/gdal")).toBe(true);
		});

		it("is false for the other tabs", () => {
			expect(isMapPath("/cache")).toBe(false);
			expect(isMapPath("/quality704")).toBe(false);
			expect(isMapPath("/stats")).toBe(false);
			expect(isMapPath("/inbox")).toBe(false);
		});
	});
});
