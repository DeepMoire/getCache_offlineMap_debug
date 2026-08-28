/**
 * THE TILES HOST IS NOT BAKED IN — and this test is what keeps it that way.
 *
 * ⛔ WHAT IT IS GUARDING. Until 27 Aug 2026 this module opened with
 * `export const PRODUCTION_HOST = "<the maintainer's R2 origin>"`. This child
 * publishes as its own AGPL package, so that default meant a stranger's install
 * streamed tiles off the maintainer's bucket, on their bill, mixed in with real
 * traffic. npm versions are immutable, so a wrong default cannot be recalled by
 * a later release — it is one of the few mistakes here that cannot be fixed
 * forward. See RAPPER.md step 3.
 *
 * ⛔ WHY THIS TESTS BEHAVIOUR AND NOT TEXT. The obvious guard is "grep lib/ for
 * the hostname", and it is a trap this repo has already sprung: RULE 7's first
 * version stripped comments by cutting each line at `//`, which is also what
 * `https://` contains, so every URL became `https:` and the rule could never
 * fire. Green, checking nothing. A text scan here would additionally have to
 * tell an executable default from the prose above that legitimately documents
 * where `deployProduction.sh` publishes.
 *
 * Asking the module what it answers avoids all of it. A reintroduced default
 * cannot hide from `expect(tilesHost()).toBeNull()`.
 *
 * ⛔ FRESH MODULE PER TEST. The configured host is module state by design (see
 * the header of tilesHost.ts — packUrl() is called deep in the download path
 * and cannot take a parameter). So `configureTilesHost` in one test would leak
 * into the next, and the unconfigured case — the one that matters — would pass
 * or fail depending on file order. `vi.resetModules()` + dynamic import gives
 * each test its own copy.
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
		// An empty string would make packUrl() "/pack" — a same-origin request
		// that 404s and reads as a broken map rather than a missing setting.
		expect(m.isTilesHostConfigured()).toBe(false);
		expect(m.packUrl()).toBeNull();
	});

	it("still knows the local dev worker without any configuration", async () => {
		const m = await freshModule();
		// The local tier stays hardcoded on purpose: it costs nobody anything.
		// tiles-local.getcache.org is an A record pointing at 127.0.0.1 (live
		// 27 Aug 2026), so naming it bills no one and reads as a tier rather
		// than as a stray IP among two dotted hostnames. Loopback still
		// accepted — it is what this resolves to.
		expect(m.LOCAL_DEV_HOST).toMatch(
			/^http:\/\/(127\.0\.0\.1|localhost|tiles-local\.getcache\.org):8787$/,
		);
	});
});
