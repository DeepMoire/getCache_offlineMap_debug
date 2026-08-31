// The dl stopwatch contract: count from the ask until the user can SEE it, then freeze.
// Each lie below shipped once (31 Aug 2026) — every row reading exactly "dl 1.0s", and
// a settled number snapping back when a background re-bake restarted the clock.
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	return () => vi.useRealTimers();
});

describe("circuit stopwatch", () => {
	it("a settle deferred by the yellow hold records the REAL arrival time, not hold expiry", async () => {
		const m = await import("./workMeter.svelte");
		m.noteCircuit("k", "transit");
		vi.advanceTimersByTime(400);
		m.noteCircuit("k", "ok", "bytes");
		vi.advanceTimersByTime(700); // the 1s hold expires; the deferred write runs now
		const c = m.circuitOf("k")!;
		expect(c.state).toBe("ok");
		// the hold delays the COLOUR change, never the clock — stamping at expiry made
		// every request faster than the hold read exactly 1.0s
		expect(c.arrivedAt! - c.askedAt!).toBe(400);
	});

	it("a re-ask after delivery does not restart the stopwatch — refreshes are invisible", async () => {
		const m = await import("./workMeter.svelte");
		m.noteCircuit("k", "transit");
		vi.advanceTimersByTime(9000);
		m.noteCircuit("k", "ok");
		const first = m.circuitOf("k")!;
		expect(first.arrivedAt! - first.askedAt!).toBe(9000);
		// background reconcile re-bakes the same data — the user's answer must not change
		m.noteCircuit("k", "transit");
		vi.advanceTimersByTime(200);
		m.noteCircuit("k", "ok");
		vi.runAllTimers();
		const c = m.circuitOf("k")!;
		expect(c.askedAt).toBe(first.askedAt);
		expect(c.arrivedAt).toBe(first.arrivedAt);
		expect(c.state).toBe("ok");
	});

	it("an err still lands on a delivered circuit — and un-delivers it, so a retry can measure", async () => {
		const m = await import("./workMeter.svelte");
		m.noteCircuit("k", "transit");
		vi.advanceTimersByTime(2000);
		m.noteCircuit("k", "ok");
		m.noteCircuit("k", "err", "went away");
		expect(m.circuitOf("k")!.state).toBe("err");
		// the break voids the old delivery — the retry is a fresh download, not a refresh
		vi.advanceTimersByTime(50);
		m.noteCircuit("k", "transit");
		expect(m.circuitOf("k")!.state).toBe("transit");
		expect(m.circuitOf("k")!.askedAt).toBe(Date.now());
	});

	it("a reset arms a fresh measurement", async () => {
		const m = await import("./workMeter.svelte");
		m.noteCircuit("k", "transit");
		vi.advanceTimersByTime(2000);
		m.noteCircuit("k", "ok");
		m.resetCircuits();
		expect(m.circuitOf("k")).toBeUndefined();
		vi.advanceTimersByTime(50);
		m.noteCircuit("k", "transit");
		expect(m.circuitOf("k")!.askedAt).toBe(Date.now());
	});

	it("settles to '0 in view' when an idle AFTER arrival counts zero — never before", async () => {
		const m = await import("./workMeter.svelte");
		m.notePaint("layer", "feed", 0); // a count from BEFORE the ask proves nothing
		m.noteCircuit("feed", "transit");
		vi.advanceTimersByTime(2000);
		m.noteCircuit("feed", "ok");
		expect(m.light("feed", ["layer"]).settledEmpty).toBe(false);
		// the post-arrival idle counted zero: the area holds none — freeze, don't count forever
		vi.advanceTimersByTime(100);
		m.notePaint("layer", "feed", 0);
		const l = m.light("feed", ["layer"]);
		expect(l.state).toBe("ok");
		expect(l.settledEmpty).toBe(true);
	});

	it("light() reports seenMs = ask → first sighting on screen", async () => {
		const m = await import("./workMeter.svelte");
		m.noteCircuit("feed", "transit");
		vi.advanceTimersByTime(8000);
		m.noteCircuit("feed", "ok");
		vi.advanceTimersByTime(900);
		m.notePaint("layer", "feed", 3);
		const l = m.light("feed", ["layer"]);
		expect(l.state).toBe("drawn");
		expect(l.seenMs).toBe(8900);
		expect(l.transitMs).toBe(8000);
		expect(l.paintLagMs).toBe(900);
	});
});
