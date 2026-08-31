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

	it("defaults to localDev in a dev build — a shipped phone is locked to production by the !DEV early return, not by this constant", async () => {
		const m = await import("./local_dev/tilesHost");
		expect(m.DEFAULT_TARGET).toBe("localDev");
	});

	it("a probe fallback never persists — only a human click writes the override", async () => {
		const store = new Map<string, string>();
		vi.stubGlobal("sessionStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
		});
		const m = await import("./local_dev/tilesHost");
		m.setWorkerTarget("production", { fallback: true });
		expect(m.getWorkerTarget()).toBe("production");
		// nothing written — the next boot starts back at DEFAULT_TARGET, not the machine's guess
		expect(store.size).toBe(0);
		m.setWorkerTarget("r2Dev");
		expect(store.get("rt_worker_target")).toBe("r2Dev");
		expect(m.getWorkerTarget()).toBe("r2Dev");
		vi.unstubAllGlobals();
	});

	it("keeps every r2Worker copy identical on the tier surface", async () => {
		const [a, b, c] = await Promise.all([
			import("./local_dev/tilesHost"),
			import("./r2_dev/tilesHost"),
			import("./r2_prod/tilesHost"),
		]);
		// ⛔ all three copies must export the same tier surface — a tier added to only one is the drift this catches.
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
		expect(Object.keys(a).sort()).toEqual(Object.keys(c).sort());
	});
});
