/**
 * ⚠️ Neither host is baked in — both injected at boot (configureTilesHost / configureTilesDevHost), since this child ships standalone and a hardcoded origin would bill whoever owns it.
 * r2_prod — tiles-prod.getcache.org, every shipped phone, real users.
 * r2_dev — tiles-dev.getcache.org, a deployed sandbox, contractors deploy here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
});

describe("worker tiers", () => {
	it("offers exactly production and r2Dev — localDev is gone from the switch", async () => {
		const m = await import("./local_dev/tilesHost");
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
		m.setWorkerTarget("r2Dev");
		// falling back to prod would let a dev-tester silently hit real user data — null greys the row instead.
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
		// r2Worker README requires local_dev/ and r2_prod/ stay identical — a tier added to only one is the drift this catches.
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
	});
});
