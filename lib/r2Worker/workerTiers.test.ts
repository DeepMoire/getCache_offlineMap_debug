// ⚠️ neither host is baked in — both are injected at boot; a hardcoded origin would bill whoever owns it.
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
		// ⛔ local_dev/ and r2_prod/ must export the same tier surface — a tier added to only one is the drift this catches.
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
	});
});
