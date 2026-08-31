import { beforeEach, describe, expect, it } from "vitest";

import { light, noteCircuit, notePaint, resetCircuits } from "./workMeter.svelte";

// Green means PIXELS. A download landing on disk must never light a row green on its own —
// only a paint count taken AFTER the bytes arrived can (29 Aug 2026: pack lights went green minutes before the blobs drew).
describe("light(): green only after a paint that follows the arrival", () => {
	beforeEach(() => resetCircuits());

	it("is grey before anything is asked", () => {
		expect(light("pack", ["vector"]).state).toBe("idle");
	});

	it("stays yellow after the bytes land, until the map paints them", () => {
		noteCircuit("pack", "ok", "1 tiles");
		expect(light("pack", ["vector"]).state).toBe("ok");
		notePaint("vector", "pack", 0);
		expect(light("pack", ["vector"]).state).toBe("ok");
	});

	it("turns green on the first non-zero paint after arrival, and records the lag", () => {
		noteCircuit("pack", "ok", "1 tiles");
		notePaint("vector", "pack", 12);
		const l = light("pack", ["vector"]);
		expect(l.state).toBe("drawn");
		expect(l.paint?.count).toBe(12);
		expect(l.paintLagMs).toBeGreaterThanOrEqual(0);
	});

	it("a paint taken BEFORE the arrival does not count for it", async () => {
		// stale pixels from before this ask must not vouch for bytes that came later
		notePaint("vector", "pack", 12);
		await new Promise((r) => setTimeout(r, 2));
		noteCircuit("pack", "ok", "new");
		expect(light("pack", ["vector"]).state).toBe("ok");
	});

	it("after a reset, a new ask starts yellow with no remembered arrival", () => {
		// mid-session a delivered circuit is LATCHED (see workMeter.test.ts) — only the
		// next user ask (resetCircuits = pin drop) or an err arms a fresh measurement
		noteCircuit("pack", "ok", "old");
		notePaint("vector", "pack", 12);
		resetCircuits();
		noteCircuit("pack", "transit");
		expect(light("pack", ["vector"]).state).toBe("transit");
		expect(light("pack", ["vector"]).circuit?.arrivedAt).toBeNull();
	});

	it("a worker row goes green when ANY of its layers paints", () => {
		noteCircuit("worker:production", "ok", "1 tiles");
		notePaint("camps", "pack", 0);
		notePaint("vector", "pack", 3);
		expect(light("worker:production", ["vector", "labels", "camps", "hospitals"]).state).toBe("drawn");
	});
});
