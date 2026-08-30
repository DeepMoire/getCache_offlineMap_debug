/**
 * ⚠️ If any test here fails, do not relax it — it means a derivation step crept back onto the phone; put the work on the Worker instead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => readFileSync(join(HERE, p), "utf8");

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
const LAYER = stripComments(src("fireLayerV2.ts"));
const ALL_V2 = [CACHE, FETCH, LAYER].join("\n");

describe("the phone does NO geometry — v2's founding rule", () => {
	it("never computes a convex hull or an outline", () => {
		expect(ALL_V2).not.toMatch(/\bhull\b/i);
		expect(ALL_V2).not.toMatch(/fireOutlines?\s*\(/);
	});

	it("never unions or dedupes detections across discs", () => {
		expect(ALL_V2).not.toMatch(/\bunion[A-Z]/);
		expect(ALL_V2).not.toMatch(/\bdedupe\b/i);
	});

	it("never runs a supersede / covered-by test", () => {
		expect(ALL_V2).not.toMatch(/coveredBy/);
		expect(ALL_V2).not.toMatch(/supersede/i);
	});

	it("never classifies urban / industrial on the phone", () => {
		expect(ALL_V2).not.toMatch(/refineUrban|peekUrbanVerdict|classifyUrban/);
	});
});

describe("distance arithmetic is bounded by DISC count, never detection count", () => {
	it("calls kmBetween in exactly one place", () => {
		const calls = LAYER.match(/kmBetween\s*\(/g) ?? [];
		expect(calls).toHaveLength(1);
	});

	it("does no trigonometry of its own anywhere in v2", () => {
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
		// walking .features on the phone is the tell for a reintroduced derivation step — that belongs to Mapbox's worker at render time.
		expect(ALL_V2).not.toMatch(/\.features\s*\.\s*(map|filter|forEach|reduce)/);
		expect(ALL_V2).not.toMatch(/for\s*\([^)]*\bof\s+[^)]*\.features\b/);
	});

	it("parses a payload only to hand it straight to setData", () => {
		// every JSON.parse of a *Json field must be an arg to setData — parsing it into a variable is how a derivation step sneaks back in.
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
		expect(CACHE).toMatch(/getAllProjected/);
		expect(CACHE).not.toMatch(/\.getAll\(\s*\)/);
	});

	it("projects to scalars only — never a payload field", () => {
		// if the projection ever returns pointsJson, the light index becomes the heavy read it was built to replace.
		const proj = CACHE.slice(
			CACHE.indexOf("getAllProjected"),
			CACHE.indexOf("getAllProjected") + 400,
		);
		expect(proj).not.toMatch(/pointsJson|clustersJson|outlinesJson/);
	});
});

describe("v2 does not import v1 — the two systems stay separate", () => {
	it("pulls nothing from the v1 fire modules", () => {
		// a single v1 import would drag its memos and data shape back in and the cutover could never be verified.
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*v4FireCache["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*fireOutline["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*fireRelevance["']/);
		expect(ALL_V2).not.toMatch(/from\s+["'][^"']*\/fireLayer["']/);
	});

	it("uses its own IndexedDB database", () => {
		// sharing rt-fire-cache would mean v2 reading v1's record shape.
		expect(CACHE).toMatch(/dbName:\s*"rt-fire-v2"/);
	});
});

describe("the safety behaviours are still enforced in code", () => {
	it("keeps the last good cache rather than blanking on a missing disc", () => {
		// An empty layer is indistinguishable from "no fires near you".
		expect(LAYER).toMatch(/if\s*\(!disc\)/);
	});

	it("re-checks liveness after every await in the paint path", () => {
		// v1 crashed with "Cannot read properties of undefined (reading 'getOwnSource')" — a route change disposed the map mid-await and the stale entry guard let the second half run anyway.
		expect(LAYER).toMatch(/if\s*\(!isLive\(\)\)\s*return/);
	});
});
