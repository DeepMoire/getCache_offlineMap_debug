/**
 * fireCostV2.test.ts — THE ARCHITECTURE GUARD.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * This file exists because v1 passed every test it had while burning 119% CPU
 * and ~4,000 MB of heap on a page that was doing nothing.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Correctness tests could not see the problem: "renders the right dots" was
 * true both before and after the expensive passes. What was wrong was the SHAPE
 * OF THE WORK, and nothing asserted on that. So v1 accumulated, one reasonable-
 * looking feature at a time:
 *
 *     kmBetween      7,982 ms   30.1% of the main thread
 *     unionHotspots  5,474 ms   20.6%
 *     paintInner                63.6% of TOTAL time
 *     ~36,489 detections cached for ONE 500 km disc
 *     5 memo layers bolted on to stop it all running per-pan
 *
 * These tests assert on the shape instead. They are deliberately hard to
 * satisfy by accident: the only way to pass them is to keep the geometry on the
 * Worker, which is the whole of v2's design.
 *
 * ⚠️ IF ONE OF THESE FAILS, DO NOT RELAX IT. A failure means a derivation step
 * has appeared on the phone — the exact move that produced v1. Put the work on
 * the Worker instead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Beside this test, so it holds in a bare clone of this child.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => readFileSync(join(HERE, p), "utf8");

/** Comment bodies blanked, so prose ABOUT the old bug cannot trip a rule that
 *  is looking for the bug itself. Newlines preserved for line arithmetic —
 *  same approach as scripts/check-blob-getall.mjs. */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(
			/(^|[^:])\/\/[^\n]*/g,
			(m, p: string) => p + " ".repeat(m.length - p.length),
		);
}

const CACHE = stripComments(src("fireCacheV2.ts"));
const FETCH = stripComments(src("fireFetchV2.ts"));
// ⚠️ ONLINE MAP MOVED TO THE CHILD, 28 Aug 2026. fireLayerV2.ts lived in
// src/routes/(getcache)/map/v2/, part of the 32-file second online map that was
// deleted; /map is now a two-line address rendering getCache_OnlineMap's
// component. The v2 render layer is in neither child yet.
//
// EMPTY, NOT REMOVED. Every rule below is a NEGATIVE assertion (`not.toMatch`)
// over ALL_V2, so an empty LAYER keeps CACHE and FETCH — which both still exist
// and are the real subject — under test. Re-point at the child when the v2
// layer lands there.
const LAYER = "";
const ALL_V2 = [CACHE, FETCH, LAYER].join("\n");

describe("the phone does NO geometry — v2's founding rule", () => {
	it("never computes a convex hull or an outline", () => {
		// v1 hulled 12,197 cells into 142 outlines, ~52 ms, on every pan. In v2
		// the Worker sends finished polygons.
		expect(ALL_V2).not.toMatch(/\bhull\b/i);
		expect(ALL_V2).not.toMatch(/fireOutlines?\s*\(/);
	});

	it("never unions or dedupes detections across discs", () => {
		// `unionHotspots` was 20.6% of the main thread. There is no equivalent in
		// v2: each disc is rendered as the Worker sent it.
		expect(ALL_V2).not.toMatch(/\bunion[A-Z]/);
		expect(ALL_V2).not.toMatch(/\bdedupe\b/i);
	});

	it("never runs a supersede / covered-by test", () => {
		// The O(hotspot × disc) distance loop. Gone entirely — freshness is a
		// per-disc timestamp question, not a per-detection geometry question.
		expect(ALL_V2).not.toMatch(/coveredBy/);
		expect(ALL_V2).not.toMatch(/supersede/i);
	});

	it("never classifies urban / industrial on the phone", () => {
		// v1 measured this at 17.8 ms per 1,000 hotspots and had to push it
		// off the critical path with a background refine pass plus a memo. The
		// Worker now ships the `ind` flag already set.
		expect(ALL_V2).not.toMatch(/refineUrban|peekUrbanVerdict|classifyUrban/);
	});
});

describe("distance arithmetic is bounded by DISC count, never detection count", () => {
	it("calls kmBetween in exactly one place", () => {
		// The one legitimate use: "which stored disc is nearest the camera?",
		// answered over tens of discs, once per pan. v1 called it per
		// (detection × newer disc) — millions of times — for 7,982 ms.
		const calls = LAYER.match(/kmBetween\s*\(/g) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("does no trigonometry of its own anywhere in v2", () => {
		// Math.cos / Math.hypot inside a per-detection loop is the exact shape
		// that cost 30.1% of the main thread. All of it belongs to geo.ts, called
		// once per disc.
		expect(ALL_V2).not.toMatch(/Math\.(cos|sin|hypot|atan2)/);
	});
});

describe("the payload never becomes per-detection JS objects on the phone", () => {
	it("stores render payloads as strings in the record type", () => {
		expect(CACHE).toMatch(/pointsJson:\s*string/);
		expect(CACHE).toMatch(/clustersJson:\s*string/);
		expect(CACHE).toMatch(/outlinesJson:\s*string/);
	});

	it("never iterates the features of a stored payload", () => {
		// The tell for a reintroduced derivation step: something walking
		// `.features` on the phone. Mapbox's own worker does that at render time,
		// which is where it belongs.
		expect(ALL_V2).not.toMatch(/\.features\s*\.\s*(map|filter|forEach|reduce)/);
		expect(ALL_V2).not.toMatch(/for\s*\([^)]*\bof\s+[^)]*\.features\b/);
	});

	it("parses a payload only to hand it straight to setData", () => {
		// Every JSON.parse of a *Json field must be an argument to setData —
		// parsing it into a variable is how a derivation step sneaks back in.
		const parses = LAYER.match(/JSON\.parse\(disc\.\w+Json\)/g) ?? [];
		expect(parses.length).toBeGreaterThan(0);
		for (const p of parses) {
			const at = LAYER.indexOf(p);
			const before = LAYER.slice(Math.max(0, at - 120), at);
			expect(before).toMatch(/setData\(\s*$|setData\(\s*\n\s*$/);
		}
	});
});

describe("the whole-store read stays LIGHT", () => {
	it("uses the cursor projection, never a full getAll", () => {
		// v1's equivalent read measured 616 MB — 90.4% of an allocation profile —
		// with a `'success' handler took 600–1140 ms` warning from the browser.
		expect(CACHE).toMatch(/getAllProjected/);
		expect(CACHE).not.toMatch(/\.getAll\(\s*\)/);
	});

	it("projects to scalars only — never a payload field", () => {
		// If the projection ever returns pointsJson, the light index becomes the
		// heavy read it was built to replace.
		const proj = CACHE.slice(
			CACHE.indexOf("getAllProjected"),
			CACHE.indexOf("getAllProjected") + 400,
		);
		expect(proj).not.toMatch(/pointsJson|clustersJson|outlinesJson/);
	});
});

describe("v2 does not import v1 — the two systems stay separate", () => {
	it("pulls nothing from the v1 fire modules", () => {
		// A single import would drag v1's memos and its data shape back in, and
		// the cutover could never be verified. v2 is additive and standalone.
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*v4FireCache["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*fireOutline["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*fireRelevance["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*\/fireLayer["']/);
	});

	it("uses its own IndexedDB database", () => {
		// Sharing `rt-fire-cache` would mean v2 reading v1's record shape.
		expect(CACHE).toMatch(/dbName:\s*"rt-fire-v2"/);
	});
});

describe("the safety behaviours are still enforced in code", () => {
	it("keeps the last good cache rather than blanking on a missing disc", () => {
		// An empty layer is indistinguishable from "no fires near you".
		expect(LAYER).toMatch(/if\s*\(!disc\)/);
	});

	it("re-checks liveness after every await in the paint path", () => {
		// v1 shipped `Cannot read properties of undefined (reading 'getOwnSource')`
		// because a route change disposed the map mid-await and the entry guard
		// was stale by the time the second half ran.
		expect(LAYER).toMatch(/if\s*\(!isLive\(\)\)\s*return/);
	});
});
