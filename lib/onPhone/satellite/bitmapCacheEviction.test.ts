// ⚠️ This test pins the drain-to-cap eviction rule shared by satBakeWorker.ts (CACHE_MAX) and satelliteImage.ts (TILE_CACHE_MAX) — change eviction in either file, change it here too.
import { describe, expect, it } from "vitest";

/** The drain loop, verbatim in shape from both caches; returns evicted keys oldest-first. */
function drainToCap(
	cache: Map<string, unknown>,
	cap: number,
	justInserted: string,
): string[] {
	const evicted: string[] = [];
	while (cache.size > cap) {
		const oldest = cache.keys().next().value as string | undefined;
		if (oldest === undefined || oldest === justInserted) break;
		cache.delete(oldest);
		evicted.push(oldest);
	}
	return evicted;
}

const seed = (n: number): Map<string, number> =>
	new Map(Array.from({ length: n }, (_, i) => [`t${i}`, i]));

describe("decoded-tile cache eviction", () => {
	it("drains an OVER-CAP cache all the way down (the cap-reduction case)", () => {
		const cache = seed(256);
		drainToCap(cache, 48, "t255");
		expect(cache.size).toBe(48);
	});

	it("evicts OLDEST first — it is an LRU, not an arbitrary cull", () => {
		const cache = seed(10);
		const evicted = drainToCap(cache, 7, "t9");
		expect(evicted).toEqual(["t0", "t1", "t2"]);
		// The newest survive.
		expect(cache.has("t9")).toBe(true);
		expect(cache.has("t8")).toBe(true);
	});

	it("never evicts the entry just inserted", () => {
		const cache = new Map<string, number>([["fresh", 1]]);
		const evicted = drainToCap(cache, 0, "fresh");
		expect(evicted).toEqual([]);
		expect(cache.has("fresh")).toBe(true);
	});

	it("does nothing when already at or under the cap", () => {
		const cache = seed(48);
		expect(drainToCap(cache, 48, "t47")).toEqual([]);
		expect(cache.size).toBe(48);
	});

	it("⛔ a single-step evictor would NOT satisfy the cap-reduction case", () => {
		const cache = seed(256);
		if (cache.size > 48) {
			const oldest = cache.keys().next().value as string;
			cache.delete(oldest);
		}
		expect(cache.size).toBe(255); // still ~5× over the cap
	});
});
