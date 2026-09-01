/** ⛔ The latch must stay separate from resetOfflineDbHandles — that reset is also used by sandbox toggling, where reopening is required; merging them would break sandbox switching to fix the wipe. */
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
	latchOfflineReadsForWipe,
	registerWipeLatch,
	resetOfflineDbHandles,
	registerOfflineDbReset,
} from "../../shared/sandboxDbNames";

describe("the wipe latch", () => {
	it("⛔ latching runs every registered reader's stop fn", () => {
		const stopped = vi.fn();
		registerWipeLatch({ latch: stopped, unlatch: () => {} });
		latchOfflineReadsForWipe();
		expect(stopped).toHaveBeenCalled();
	});

	it("⛔ the LATCH and the HANDLE RESET are separate registries", () => {
		// ⛔ Sandbox toggling calls the reset and requires reads to reopen — if the latch fired there too, switching into the sandbox would leave the map permanently unable to read.
		const latch = vi.fn();
		const reset = vi.fn();
		registerWipeLatch({ latch, unlatch: () => {} });
		registerOfflineDbReset(reset);

		latch.mockClear();
		reset.mockClear();
		resetOfflineDbHandles();
		expect(reset).toHaveBeenCalled();
		expect(latch, "a sandbox toggle must NOT latch reads off").not.toHaveBeenCalled();
	});

	it("a throwing latch does not stop the others", () => {
		// Best-effort: one module failing must not leave the rest holding the DB open.
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();
		registerWipeLatch({ latch: bad, unlatch: () => {} });
		registerWipeLatch({ latch: good, unlatch: () => {} });
		good.mockClear();
		expect(() => latchOfflineReadsForWipe()).not.toThrow();
		expect(good).toHaveBeenCalled();
	});

	it("⛔ THE READ PATH IS UNCONDITIONAL — a latch must never gate reads", async () => {
		// ⛔ Never make idbGetTile conditional on the latch — if it ever survives (a failed wipe, a reload that doesn't happen), every read becomes a silent miss indistinguishable from "never downloaded". Fix a stuck delete in wipe.ts instead.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const src = readFileSync(
			fileURLToPath(
				new URL(
					"../../worker/worker-local-dev/roads/packDownload.ts",
					import.meta.url,
				),
			),
			"utf8",
		);
		const body = src.slice(src.indexOf("export async function idbGetTile"));
		expect(body).not.toMatch(/if\s*\(\s*wipeLatched\s*\)/);
	});

});
