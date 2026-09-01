/**
 * ⛔ the worker switch must be UNSHIPPABLE, not merely discouraged — import.meta.env.DEV is a compile-time constant, so the override branch is dead code Vite drops from a production build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TARGET,
	LOCAL_DEV_HOST,
	configureTilesHost,
	getWorkerTarget,
	packUrl,
	setWorkerTarget,
	firesUrl,
	tilesHost,
} from "./tilesHost";

/** TEST_HOST is a stand-in, not a production constant — the host is supplied by the app via configureTilesHost(). "No default is baked in" is covered separately in ../tilesHostConfig.test.ts. */
const TEST_HOST = "https://tiles.example.test";

beforeEach(() => {
	sessionStorage.clear();
	// module state — re-established per test; see tilesHost.ts for why it's module-level, not a parameter
	configureTilesHost(TEST_HOST);
});

describe("worker target", () => {
	it("defaults to production, with no stored override", () => {
		expect(DEFAULT_TARGET).toBe("worker-cloud-prod");
		expect(getWorkerTarget()).toBe("worker-cloud-prod");
		expect(tilesHost()).toBe(TEST_HOST);
	});

	it("switches every URL together — no split-brain", () => {
		// The failure this prevents: roads from one target, fires from another.
		setWorkerTarget("worker-local-dev");
		expect(tilesHost()).toBe(LOCAL_DEV_HOST);
		expect(packUrl()).toBe(`${LOCAL_DEV_HOST}/pack`);
		expect(firesUrl()).toBe(`${LOCAL_DEV_HOST}/fires`);

		setWorkerTarget("worker-cloud-prod");
		expect(packUrl()).toBe(`${TEST_HOST}/pack`);
		expect(firesUrl()).toBe(`${TEST_HOST}/fires`);
	});

	it("URLs are read per call, so a switch takes effect without a reload", () => {
		// a const can't see a later choice — this used to be module-load consts, and "the switch does nothing" is how you end up testing prod while believing you're on local
		setWorkerTarget("worker-cloud-prod");
		const before = packUrl();
		setWorkerTarget("worker-local-dev");
		expect(packUrl()).not.toBe(before);
	});

	it("ignores a corrupt or hostile stored value", () => {
		sessionStorage.setItem("rt_worker_target", "https://evil.example.com");
		expect(getWorkerTarget()).toBe(DEFAULT_TARGET);
		expect(tilesHost()).toBe(TEST_HOST);
	});

	it("the override is gated on import.meta.env.DEV in BOTH directions", () => {
		// a DEV-mode test can't observe Vite dropping the branch; it can only prove both reader and writer are gated — if either loses its guard, a shipped app can point at a dev Worker
		const src = readSource();
		const reader = src.slice(src.indexOf("export function getWorkerTarget"));
		expect(reader.slice(0, 200)).toContain("import.meta.env.DEV");
		const writer = src.slice(src.indexOf("export function setWorkerTarget"));
		expect(writer.slice(0, 200)).toContain("import.meta.env.DEV");
	});
});

function readSource(): string {
	return readFileSync(
		fileURLToPath(new URL("./tilesHost.ts", import.meta.url)),
		"utf8",
	);
}
