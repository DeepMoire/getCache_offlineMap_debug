import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ⚠️ don't gate the fallback on `reachable.production !== false` — that clause is only reached when production IS the dead target, so it's always false exactly when the recovery path is needed.

const PANEL = readFileSync(join(__dirname, "OfflineConfigPanel.svelte"), "utf8");

describe("worker tier fallback", () => {
	it("does not gate the fallback on production being alive", () => {
		// Matched as CODE, not prose — a bare substring check would also match the fix's own comment quoting the old guard, so comment lines are filtered out first.
		const code = PANEL.split("\n")
			.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
			.join("\n");
		expect(code).not.toContain("reachable.production !== false");
	});

	it("considers every tier when the current one is dead, not just production", () => {
		const fallback = PANEL.slice(PANEL.indexOf('if (reach(target) === "err")'));
		for (const tier of ["production", "r2Dev", "localDev"]) {
			expect(fallback).toContain(tier);
		}
	});

	it("says something when no tier answers, instead of failing silently", () => {
		// A dead panel with a silent console is a failure shape this subsystem keeps reproducing. [[no-silent-fallbacks]]
		expect(PANEL).toContain("NO worker is reachable");
	});
});

// ⚠️ r2_dev must be configured in the same place as production (configureTilesDevHost) or it's dead by construction — configuredDevHost stays null until called. Both hosts are configured via configureTilesFromEnv(), called from the child's boot.
const LAYOUT = readFileSync(join(__dirname, "..", "..", "routes", "+layout.svelte"), "utf8");
const TILES_FROM_ENV = readFileSync(
	join(__dirname, "..", "r2Worker", "local_dev", "tilesFromEnv.ts"),
	"utf8",
);

describe("r2_dev tier is configurable", () => {
	it("the child's boot configures the dev host, not only production", () => {
		expect(LAYOUT).toContain("configureTilesFromEnv()");
		expect(TILES_FROM_ENV).toContain("configureTilesDevHost");
	});

	it("reads it from the environment rather than baking an origin in", () => {
		// Baking a real origin here would bill whoever owns it — same rule that keeps packUrl() answering null until configured.
		expect(TILES_FROM_ENV).toContain("VITE_TILES_DEV_HOST");
		expect(TILES_FROM_ENV).not.toMatch(/configureTilesDevHost\(\s*["'`]https?:/);
	});
});

// ⚠️ a transient network result must never become permanent UI state — a tier probed dead once must stay retryable, never left rendered `disabled` forever.
describe("a tier that failed once can be retried", () => {
	it("worker rows are never rendered `disabled`", () => {
		// Scoped to the Workers loop — the layers loop below legitimately uses `disabled` for a compile-time bisect, not a network state.
		const workersBlock = PANEL.slice(
			PANEL.indexOf("{#each TARGETS as t"),
			PANEL.indexOf("{#if layers.length"),
		);
		expect(workersBlock).not.toContain("disabled=");
	});

	it("clicking a dead tier re-probes it instead of returning early", () => {
		const pick = PANEL.slice(
			PANEL.indexOf("async function pickTarget"),
			PANEL.indexOf("async function probeAll"),
		);
		expect(pick).toContain("await probeTarget(t)");
		// The old body was a bare `if (reachable[t] === false) return;`.
		expect(pick).not.toMatch(/if \(reachable\[t\] === false\) return;/);
	});

	it("tells the user the row is clickable", () => {
		expect(PANEL).toContain("CLICK TO RETRY");
	});
});
