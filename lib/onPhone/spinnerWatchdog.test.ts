/** ⛔ Watchdog invariant: the watched process must never be able to skip or reset the watchdog. */
import { describe, expect, it } from "vitest";

const MAX_VISIBLE_MS = 30_000;

function makeSpinner() {
	let visible = false;
	let startedAt = 0;
	let latched = false; // watchdog has fired — one-way
	let now = 0;

	return {
		onDownloading(): void {
			if (latched) return; // cannot reopen
			if (!visible) {
				visible = true;
				// STICKY: clock measures the PASS — don't reset it per area, or the ceiling is never reached.
				if (startedAt === 0) startedAt = now;
			}
		},
		/** MUST NOT clear the latch when tiles land. */
		onTilesLanded(): void {
			visible = false; // hidden, but the PASS clock keeps running
		},
		/** The 1 s ticker — the watchdog lives here, so it cannot be skipped. */
		tick(ms: number): void {
			now += ms;
			if (visible && now - startedAt >= MAX_VISIBLE_MS) {
				latched = true;
				visible = false;
			}
		},
		get visible() {
			return visible;
		},
	};
}

describe("spinner watchdog — a hard stop the bake cannot skip", () => {
	it("⛔ stops within the ceiling even while progress keeps arriving", () => {
		const s = makeSpinner();
		for (let i = 0; i < 600; i++) {
			s.onDownloading();
			s.tick(1000);
		}
		expect(s.visible).toBe(false);
	});

	it("⛔ ATTEMPT 2's HOLE: completions must NOT re-arm it", () => {
		const s = makeSpinner();
		for (let i = 0; i < 600; i++) {
			s.onDownloading();
			s.tick(1000);
			if (i % 5 === 0) s.onTilesLanded();
		}
		expect(s.visible).toBe(false);
	});

	it("⛔ ATTEMPT 1's HOLE: already-visible when events arrive still stops", () => {
		const s = makeSpinner();
		s.onDownloading();
		for (let i = 0; i < 600; i++) {
			s.onDownloading(); // `if (!visible)` never taken again
			s.tick(1000);
		}
		expect(s.visible).toBe(false);
	});

	it("never exceeds the ceiling, measured", () => {
		const s = makeSpinner();
		let lastVisibleAt = 0;
		let t = 0;
		for (let i = 0; i < 600; i++) {
			s.onDownloading();
			s.tick(1000);
			t += 1000;
			if (s.visible) lastVisibleAt = t;
		}
		expect(lastVisibleAt).toBeLessThanOrEqual(MAX_VISIBLE_MS + 1000);
	});

	it("a SHORT download still shows the animation (it is not simply disabled)", () => {
		const s = makeSpinner();
		s.onDownloading();
		s.tick(1000);
		expect(s.visible).toBe(true);
	});
});
