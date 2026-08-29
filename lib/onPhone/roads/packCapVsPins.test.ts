// ⚠️ A latched download breaker is terminal (only a full reload clears it) — the cap must fit the real per-pin unit of work, not the old shared-tile assumption.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cellsFor } from "../../contract/grid";

/** The cap, read from the source so the test cannot drift from the constant. */
function sessionPackCap(): number {
	const src = readFileSync(
		fileURLToPath(
			new URL("../store/downloadGuard.ts", import.meta.url),
		),
		"utf8",
	);
	const m = /const SESSION_PACK_CAP = (\d+);/.exec(src);
	if (!m) throw new Error("SESSION_PACK_CAP not found — did it get renamed?");
	return Number(m[1]);
}

const PINS = 300;

describe("the pack cap fits per-pin road keys", () => {
	it("⛔ 300 pins must not latch the breaker", () => {
		let worstCellsPerPin = 0;
		for (let i = 0; i < 40; i++) {
			const lng = -180 + (360 * i) / 40 + 0.4999;
			const lat = -60 + (120 * i) / 40;
			worstCellsPerPin = Math.max(worstCellsPerPin, cellsFor(lng, lat).length);
		}
		expect(worstCellsPerPin).toBeGreaterThan(0);

		const needed = PINS * 2;
		expect(
			sessionPackCap(),
			`${PINS} pins re-baking need ~${needed} packs; cap is ${sessionPackCap()}. ` +
				"A latched breaker is TERMINAL — it freezes the bake and draws half a map.",
		).toBeGreaterThanOrEqual(needed);
	});

	it("the cap still catches a genuine runaway (it is not simply infinite)", () => {
		expect(sessionPackCap()).toBeLessThanOrEqual(50_000);
	});
});
