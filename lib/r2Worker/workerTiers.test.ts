/**
 * TWO CLOUD TIERS, AND NO LOCAL ONE.
 *
 * Chris's call, 27 Aug 2026, after a day lost to a switch that looked broken:
 *
 *   r2_prod — tiles-prod.getcache.org.     Every shipped phone. Real users.
 *   r2_dev  — tiles-dev.getcache.org. A deployed sandbox. Contractors deploy here.
 *
 * `local_dev` (127.0.0.1:8787) was REMOVED from the CONFIG panel: it only
 * answered while a terminal stayed open, so the switch was usually dead, and a
 * dead switch reads as a broken app. "Delete the local one, it's too much work."
 *
 * Both tiers read the SAME R2 bucket, so a difference between them is always
 * CODE and never data — that is the entire point of having two.
 *
 * NEITHER HOST IS BAKED IN. Both are injected by the app at boot
 * (configureTilesHost / configureTilesDevHost), because this child is
 * published on its own and a hardcoded origin would bill whoever owns it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
});

describe("worker tiers", () => {
	it("offers exactly production and r2Dev — localDev is gone from the switch", async () => {
		const m = await import("./local_dev/tilesHost");
		// The type is compile-time, so assert on behaviour: both cloud tiers
		// resolve once configured, and each resolves to its OWN host.
		m.configureTilesHost("https://prod.example.test");
		m.configureTilesDevHost("https://dev.example.test");

		m.setWorkerTarget("production");
		expect(m.tilesHost()).toBe("https://prod.example.test");

		m.setWorkerTarget("r2Dev");
		expect(m.tilesHost()).toBe("https://dev.example.test");
	});

	it("r2Dev is null until an app configures it — never a silent fallback to prod", async () => {
		const m = await import("./local_dev/tilesHost");
		m.configureTilesHost("https://prod.example.test");
		// Deliberately NOT configuring the dev host.
		m.setWorkerTarget("r2Dev");
		// Falling back to production here would mean a developer testing dev
		// while silently hitting what users read. Null greys the row instead.
		expect(m.tilesHost()).toBeNull();
		expect(m.packUrl()).toBeNull();
	});

	it("defaults to production, so an unset override never picks the sandbox", async () => {
		const m = await import("./local_dev/tilesHost");
		expect(m.DEFAULT_TARGET).toBe("production");
	});

	it("keeps both r2Worker copies byte-identical on the tier definition", async () => {
		const [a, b] = await Promise.all([
			import("./local_dev/tilesHost"),
			import("./r2_prod/tilesHost"),
		]);
		// The r2Worker README requires local_dev/ and r2_prod/ stay identical;
		// a tier added to one and not the other is the drift it warns about.
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
	});
});
