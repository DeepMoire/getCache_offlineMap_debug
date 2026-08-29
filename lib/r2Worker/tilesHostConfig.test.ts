/**
 * ⚠️ Never bake in a default tiles host — npm versions are immutable, a wrong default ships forever (RAPPER.md step 3).
 * ⚠️ Test behavior, not text — grepping for the hostname is defeated by URLs containing `//`.
 * ⚠️ Fresh module per test (vi.resetModules() + dynamic import) — host is module-level state and leaks across tests otherwise.
 */
import { describe, expect, it, vi } from "vitest";

async function freshModule() {
	vi.resetModules();
	return await import("./local_dev/tilesHost");
}

describe("tiles host must be configured by the app", () => {
	it("answers NOTHING until configured — no default origin is baked in", async () => {
		const m = await freshModule();
		expect(m.isTilesHostConfigured()).toBe(false);
		expect(m.tilesHost()).toBeNull();
		expect(m.packUrl()).toBeNull();
		expect(m.firesUrl()).toBeNull();
	});

	it("builds both endpoints off the configured origin", async () => {
		const m = await freshModule();
		m.configureTilesHost("https://tiles.example.test");
		expect(m.isTilesHostConfigured()).toBe(true);
		expect(m.packUrl()).toBe("https://tiles.example.test/pack");
		expect(m.firesUrl()).toBe("https://tiles.example.test/fires");
	});

	it("trims trailing slashes so a configured origin cannot produce //pack", async () => {
		const m = await freshModule();
		m.configureTilesHost("https://tiles.example.test///");
		expect(m.packUrl()).toBe("https://tiles.example.test/pack");
	});

	it("treats blank configuration as unconfigured, not as an empty origin", async () => {
		const m = await freshModule();
		m.configureTilesHost("   ");
		// blank config ≠ empty origin — empty would make packUrl() "/pack", a same-origin 404 that reads as a broken map, not a missing setting.
		expect(m.isTilesHostConfigured()).toBe(false);
		expect(m.packUrl()).toBeNull();
	});

	it("still knows the local dev worker without any configuration", async () => {
		const m = await freshModule();
		// local tier stays hardcoded on purpose — costs nobody anything; tiles-local.getcache.org resolves to 127.0.0.1, loopback still accepted.
		expect(m.LOCAL_DEV_HOST).toMatch(
			/^http:\/\/(127\.0\.0\.1|localhost|tiles-local\.getcache\.org):8787$/,
		);
	});
});
