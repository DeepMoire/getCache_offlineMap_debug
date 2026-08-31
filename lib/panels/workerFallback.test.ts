import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ⚠️ the tier auto-fallback is DELETED, not dormant — probeAll used to switch to the
// first alive tier (production first), landing every fresh install without a local
// worker on the maintainer's R2 and hiding the local-first default. Local-first holds
// even when local is dead; a dead tier says how to start it.

const PANEL = readFileSync(join(__dirname, "OfflineConfigPanel.svelte"), "utf8");

describe("no worker tier auto-switch", () => {
	it("boot never switches tiers by itself — the fallback machinery is gone", () => {
		expect(PANEL).not.toContain("{ fallback: true }");
		const probe = PANEL.slice(PANEL.indexOf("async function probeAll"));
		expect(probe).not.toMatch(/setWorkerTarget\(/);
	});

	it("a dead current tier is announced, never failed silently", () => {
		// A dead panel with a silent console is a failure shape this subsystem keeps reproducing. [[no-silent-fallbacks]]
		expect(PANEL).toContain("is not answering");
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
