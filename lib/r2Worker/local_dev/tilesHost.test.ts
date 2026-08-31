// the worker switch must be UNSHIPPABLE — import.meta.env.DEV makes the override dead code in a production build, since a runtime toggle could ship silently pointed at a dev Worker.
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

/** TEST_HOST stands in for the removed production-host constant (see tilesHost.ts); a .test domain ensures a copied test can never hit a real request. */
const TEST_HOST = "https://tiles.example.test";

beforeEach(() => {
	sessionStorage.clear();
	// module state — re-established per test; see tilesHost.ts for why the host is module-level, not a parameter.
	configureTilesHost(TEST_HOST);
});

describe("worker target", () => {
	it("defaults to localDev in a dev build, with no stored override", () => {
		// the developer's own machine is the starting tier (Chris, 31 Aug 2026);
		// a SHIPPED build never reads DEFAULT_TARGET — the !DEV early return in
		// getWorkerTarget() locks phones to production, and the gating test
		// below is what protects that.
		expect(DEFAULT_TARGET).toBe("localDev");
		expect(getWorkerTarget()).toBe("localDev");
		expect(tilesHost()).toBe(LOCAL_DEV_HOST);
	});

	it("switches every URL together — no split-brain", () => {
		// The failure this prevents: roads from one target, fires from another.
		setWorkerTarget("localDev");
		expect(tilesHost()).toBe(LOCAL_DEV_HOST);
		expect(packUrl()).toBe(`${LOCAL_DEV_HOST}/pack`);
		expect(firesUrl()).toBe(`${LOCAL_DEV_HOST}/fires`);

		setWorkerTarget("production");
		expect(packUrl()).toBe(`${TEST_HOST}/pack`);
		expect(firesUrl()).toBe(`${TEST_HOST}/fires`);
	});

	it("URLs are read per call, so a switch takes effect without a reload", () => {
		// a const cannot see a later choice — the toggle would look inert, and you'd end up testing production while believing you're on local.
		setWorkerTarget("production");
		const before = packUrl();
		setWorkerTarget("localDev");
		expect(packUrl()).not.toBe(before);
	});

	it("ignores a corrupt or hostile stored value", () => {
		sessionStorage.setItem("rt_worker_target", "https://evil.example.com");
		expect(getWorkerTarget()).toBe(DEFAULT_TARGET);
		expect(tilesHost()).toBe(LOCAL_DEV_HOST);
	});

	it("the override is gated on import.meta.env.DEV in BOTH directions", () => {
		// if either the reader or writer loses its DEV guard, a production build becomes switchable and the shipped app can point at a dev Worker.
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
