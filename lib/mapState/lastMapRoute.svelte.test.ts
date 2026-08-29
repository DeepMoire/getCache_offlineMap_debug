import { beforeEach, describe, expect, it, vi } from "vitest";

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
		// the route is cached in a module-level cell seeded once — clearing storage alone doesn't clear it; resetLastMapRouteCache() must run too, or tests inherit state
		resetLastMapRouteCache();
	});

	describe("the default", () => {
		it("opens the ONLINE map when nothing is stored", () => {
			expect(loadLastMapRoute()).toBe(ONLINE_MAP_ROUTE);
		});

		it("falls back to ONLINE when the stored value is unrecognised", () => {
			// unknown stored route must be rejected, not trusted — handing it to goto would 404 the MAP tab
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
			// regression lock: tapping an eye while offline used to silently throw the user onto the online map mid-task
			saveLastMapRoute(OFFLINE_MAP_ROUTE);
			const url = seeOnMapUrl({ map: "m1", plots: "a,b" });
			expect(url).toBe(`${OFFLINE_MAP_ROUTE}?map=m1&plots=a%2Cb`);
		});

		it("encodes keys that contain URL-significant characters", () => {
			// URLSearchParams must not regress the encodeURIComponent behaviour the hand-rolled callers relied on
			const url = seeOnMapUrl({ map: "a b&c=d" });
			expect(url).toBe(`${ONLINE_MAP_ROUTE}?map=a+b%26c%3Dd`);
		});

		it("accepts a URLSearchParams (the quality704 callers' shape)", () => {
			const q = new URLSearchParams();
			q.set("map", "m1");
			expect(seeOnMapUrl(q)).toBe(`${ONLINE_MAP_ROUTE}?map=m1`);
		});

		it("returns a bare route when there are no params", () => {
			// quality704's empty param set (goToMapToDropPlot) must not produce a trailing "?"
			expect(seeOnMapUrl(new URLSearchParams())).toBe(ONLINE_MAP_ROUTE);
			expect(seeOnMapUrl()).toBe(ONLINE_MAP_ROUTE);
		});
	});

	describe("the sandbox world keeps its own choice", () => {
		it("does not let the practice world change the real app's MAP tab", () => {
			// ⚠️ localStorage is shared with ?sandbox=1 (key suffixed per world) — the sandbox must never decide the real app's map tab
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
			// regression: the routes are siblings, so a generic startsWith(href) tab-bar test went dark on the offline map (no tab lit)
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
