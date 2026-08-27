import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SELECTED-AND-UNREACHABLE TRAP.
 *
 * MEASURED 27 Aug 2026 on localhost:5174/offline/debug: the CONFIG panel showed
 * r2_prod lit green AND greyed out at the same time, with r2_dev and local_dev
 * also grey. Every row was `disabled`, so no click could move off the dead
 * tier. Nothing downloaded and the panel offered no way out.
 *
 * The cause was one guard. probeAll's fallback read:
 *
 *     if (reachable[target] === false && reachable.production !== false)
 *
 * `production` is the DEFAULT target, so the branch only ever runs when
 * production is the dead one — and in exactly that case the second clause is
 * false. The recovery path could not fire in the only situation it was written
 * for.
 *
 * These are source assertions rather than a mounted-component test because the
 * child ships no Svelte test harness; the failure was a logic guard visible in
 * the text, and a grep-shaped test that fails loudly beats no test at all.
 */

const PANEL = readFileSync(join(__dirname, "OfflineConfigPanel.svelte"), "utf8");

describe("worker tier fallback", () => {
	it("does not gate the fallback on production being alive", () => {
		// The exact shape of the bug. Matched as CODE, not prose: the fix's own
		// comment quotes the old guard to explain it, and a bare substring check
		// fails on that quotation — which would train the next person to delete
		// the explanation to get the suite green.
		const code = PANEL.split("\n")
			.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
			.join("\n");
		expect(code).not.toContain("reachable.production !== false");
	});

	it("considers every tier when the current one is dead, not just production", () => {
		const fallback = PANEL.slice(PANEL.indexOf("if (reachable[target] === false)"));
		for (const tier of ["production", "r2Dev", "localDev"]) {
			expect(fallback).toContain(tier);
		}
	});

	it("says something when no tier answers, instead of failing silently", () => {
		// A dead panel with a silent console is the failure shape this whole
		// subsystem keeps reproducing. [[no-silent-fallbacks]]
		expect(PANEL).toContain("NO worker is reachable");
	});
});

/**
 * r2_dev COULD NEVER BE REACHED UNDER A PLAIN WRAPPER.
 *
 * probeTarget asks hostFor("r2Dev") -> configuredDevHost, which stays null
 * until configureTilesDevHost() is called. MEASURED 27 Aug 2026: the only
 * caller in the workspace was ReTreever/src/hooks.client.ts:45, so the tier
 * worked under ReTreever and was permanently grey under rapper — a control
 * advertising a sandbox the user could never select.
 *
 * The child configures its own tiers (see the long note in routes/+layout.svelte
 * on why this belongs to the child and not the wrapper), so the dev tier has to
 * be configured in the same place as production or it is dead by construction.
 */
const LAYOUT = readFileSync(join(__dirname, "..", "..", "routes", "+layout.svelte"), "utf8");

describe("r2_dev tier is configurable", () => {
	it("the child's boot configures the dev host, not only production", () => {
		expect(LAYOUT).toContain("configureTilesDevHost");
	});

	it("reads it from the environment rather than baking an origin in", () => {
		// Baking a real origin here would bill whoever owns it — the same rule
		// that keeps packUrl() answering null until configured.
		expect(LAYOUT).toContain("VITE_TILES_DEV_HOST");
		expect(LAYOUT).not.toMatch(/configureTilesDevHost\(\s*["'`]https?:/);
	});
});
