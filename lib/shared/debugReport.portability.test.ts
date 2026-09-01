/** ⚠️ Import boundary test — OFFLINE_MAP_SPEC.md §9 rule 5. Don't import outside the allow-list below or this fails. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
	fileURLToPath(new URL("./debugReport.ts", import.meta.url)),
	"utf8",
);

/** Import specifiers this module may legitimately reach for. */
const ALLOWED = [
	"./",
	"../contract",
	"../onPhone/store/coverageRegistry",
	"../worker/worker-local-dev/tilesHost",
	// wallLegend: a literal switches table (key/label/ids/feed) — no UI/store/runtime, safe to allow.
	"../onPhone/render/wallLegend",
];

/** Boundary breach markers, matched against the WHOLE specifier — a bare "svelte" would also hit `workMeter.svelte`, so the framework ban is exact-match below instead. */
const BANNED = [
	"$tinyStore",
	"mapStore",
	// Breach direction is now $lib/mobile/ (below), not $parent/siblings — this file's own home after the move.
	"$lib/mobile/",
	"$mobRoutes",
	"$app/",
	"@supabase",
	"$lib/mobile/components/",
	"$lib/mobile/stores/",
];

/** Framework/runtime specifiers, banned by EXACT match — this module must run without any Svelte runtime present (test, Worker, or plain page). */
const BANNED_EXACT = ["svelte", "svelte/store", "mapbox-gl", "maplibre-gl"];

function imports(src: string): string[] {
	return [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("debugReport stays portable", () => {
	it("imports nothing outside the allow-list", () => {
		const offenders = imports(SRC).filter(
			(s) =>
				!s.startsWith(".") &&
				!ALLOWED.some((a) => s.startsWith(a)),
		);
		expect(offenders).toEqual([]);
	});

	it("never reaches for the app's stores or UI", () => {
		for (const bad of BANNED) {
			expect(
				imports(SRC).some((s) => s.includes(bad)),
				`debugReport.ts must not import ${bad} — it is the one file that has to travel`,
			).toBe(false);
		}
	});

	it("pulls in no framework or renderer", () => {
		for (const bad of BANNED_EXACT) {
			expect(
				imports(SRC).includes(bad),
				`debugReport.ts must not import ${bad} — it has to run without a renderer`,
			).toBe(false);
		}
	});

	it("takes pins as a parameter rather than reading them", () => {
		// Rule 5: pins must stay a parameter, never read from a store — that would collapse the interface.
		expect(SRC).toMatch(/pins\?:\s*LngLatPin\[\]/);
	});
});
