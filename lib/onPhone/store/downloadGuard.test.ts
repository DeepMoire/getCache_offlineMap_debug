import { beforeEach, describe, expect, it, vi } from "vitest";

const captureMessage = vi.fn();
vi.mock("@sentry/sveltekit", () => ({ captureMessage }));

// freshGuard re-imports so module-level breaker state resets — the breaker is intentionally one-shot per module instance.
async function freshGuard() {
	vi.resetModules();
	captureMessage.mockClear();
	return await import("./downloadGuard");
}

describe("downloadGuard circuit breaker", () => {
	beforeEach(() => {
		captureMessage.mockClear();
	});

	it("lets a normal satellite bake grid through", async () => {
		const g = await freshGuard();
		expect(() => g.guardBakeGrid(60, { center: [0, 0] })).not.toThrow();
		expect(g.isDownloadGuardTripped()).toBe(false);
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it("TRIPS on an absurd single-bake grid (huge area) and alerts Sentry once", async () => {
		const g = await freshGuard();
		expect(() => g.guardBakeGrid(5000, { center: [0, 0] })).toThrow(
			g.DownloadBudgetError,
		);
		expect(g.isDownloadGuardTripped()).toBe(true);
		expect(captureMessage).toHaveBeenCalledTimes(1);
		// Any further guarded call throws immediately (breaker stays open).
		expect(() => g.guardBakeGrid(1, {})).toThrow(g.DownloadBudgetError);
		expect(() => g.noteSatelliteTiles(1)).toThrow(g.DownloadBudgetError);
		// ...and does NOT re-alert Sentry (one-shot).
		expect(captureMessage).toHaveBeenCalledTimes(1);
	});

	it("TRIPS when the session tile total blows the ceiling (multi-bake runaway)", async () => {
		const g = await freshGuard();
		// 5000 cap: 4900 fine, the next 200 crosses it.
		for (let i = 0; i < 4900; i++) g.noteSatelliteTiles(1);
		expect(g.isDownloadGuardTripped()).toBe(false);
		let threw = false;
		try {
			for (let i = 0; i < 200; i++) g.noteSatelliteTiles(1);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(g.isDownloadGuardTripped()).toBe(true);
		expect(captureMessage).toHaveBeenCalledTimes(1);
	});

	it("TRIPS on too many pack downloads in a session", async () => {
		const g = await freshGuard();
		// ⛔ READ THE CAP FROM THE SOURCE, NEVER HARD-CODE IT — a hard-coded assertion silently stopped testing anything when the constant changed twice under it.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			fileURLToPath(new URL("./downloadGuard.ts", import.meta.url)),
			"utf8",
		);
		const cap = Number(/const SESSION_PACK_CAP = (\d+);/.exec(src)?.[1]);
		expect(Number.isFinite(cap)).toBe(true);

		let count = 0;
		let threw = false;
		try {
			for (let i = 0; i < cap + 10; i++) {
				g.guardPackDownload({ lng: 0, lat: 0 });
				count++;
			}
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(count).toBeLessThanOrEqual(cap);
		expect(g.isDownloadGuardTripped()).toBe(true);
		expect(captureMessage).toHaveBeenCalledTimes(1);
	});
});

// ⚠️ Once tripped the breaker is TERMINAL, never retryable — callers must stop, not retry (a caught-and-retried throw once flooded the console with retained errors).
describe("downloadGuard — a tripped breaker is TERMINAL, never retryable", () => {
	it("stays tripped forever once tripped (retrying can never succeed)", async () => {
		const g = await freshGuard();
		expect(() => g.guardBakeGrid(5000, { center: [0, 0] })).toThrow();
		expect(g.isDownloadGuardTripped()).toBe(true);
		for (let pass = 0; pass < 50; pass++) {
			expect(() => g.guardBakeGrid(1, { center: [0, 0] })).toThrow(
				g.DownloadBudgetError,
			);
			expect(() => g.guardPackDownload({ center: [0, 0] })).toThrow(
				g.DownloadBudgetError,
			);
			expect(() => g.noteSatelliteTiles(1)).toThrow(g.DownloadBudgetError);
		}
		expect(g.isDownloadGuardTripped()).toBe(true);
	});

	it("alerts Sentry ONCE no matter how many retries hammer it", async () => {
		const g = await freshGuard();
		expect(() => g.guardBakeGrid(5000, { center: [0, 0] })).toThrow();
		const afterTrip = captureMessage.mock.calls.length;
		for (let pass = 0; pass < 50; pass++) {
			try {
				g.guardBakeGrid(1, { center: [0, 0] });
			} catch {
				// expected — the breaker is latched
			}
		}
		// Retries must not multiply the alert; the flood was console-side.
		expect(captureMessage.mock.calls.length).toBe(afterTrip);
	});

	it("isDownloadGuardTripped() is the signal callers must branch on", async () => {
		const g = await freshGuard();
		expect(g.isDownloadGuardTripped()).toBe(false); // healthy → keep baking
		try {
			g.guardBakeGrid(5000, { center: [0, 0] });
		} catch {
			// expected
		}
		expect(g.isDownloadGuardTripped()).toBe(true); // latched → STOP baking
	});
});
