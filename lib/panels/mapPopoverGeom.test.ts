import { describe, expect, it } from "vitest";
import {
	ESTIMATED_HEIGHT,
	leaderLine,
	type PlaceInput,
	placePopover,
} from "./mapPopoverGeom";

// Chrome reserves, mirroring MapPopoverShell's exports.
const TOP = 150;
const BOTTOM = 95;

// A phone-shaped map container.
const W = 390;
const H = 800;

function place(over: Partial<PlaceInput> = {}) {
	return placePopover({
		bbox: { minX: 180, maxX: 210, minY: 260, maxY: 300 },
		containerWidth: W,
		containerHeight: H,
		isPoint: true,
		wide: false,
		topReserve: TOP,
		bottomReserve: BOTTOM,
		...over,
	});
}

/** A pin's bbox: bottom-anchored icon, inflated up by PIN_H and out by HALF_W. */
function pinAt(y: number) {
	return { minX: 180, maxX: 210, minY: y - 40, maxY: y };
}

describe("placePopover — the card never leaves the viewport", () => {
	it("keeps a pin card fully inside the usable band when the pin is near the bottom", () => {
		const p = place({ bbox: pinAt(700) });
		expect(p.top + Math.min(ESTIMATED_HEIGHT, p.maxH)).toBeLessThanOrEqual(
			H - BOTTOM,
		);
		expect(p.top).toBeGreaterThanOrEqual(TOP);
	});

	it("flips a pin card ABOVE the pin when there is no room below", () => {
		const p = place({ bbox: pinAt(700) });
		expect(p.side).toBe("above");
		expect(p.top + ESTIMATED_HEIGHT).toBeLessThanOrEqual(pinAt(700).minY);
	});

	it("keeps a pin card BELOW when the pin is up top (the panned-to-top case)", () => {
		// PIN_TARGET_Y is 240 — the normal post-tap landing spot.
		const p = place({ bbox: pinAt(240) });
		expect(p.side).toBe("below");
		expect(p.top).toBeGreaterThan(240);
	});

	it("treats points and polygons the same way at the same anchor", () => {
		const bbox = pinAt(700);
		const pin = place({ bbox, isPoint: true });
		const poly = place({ bbox, isPoint: false });
		expect(pin.side).toBe(poly.side);
	});

	it("respects a measured height taller than the estimate", () => {
		const p = place({ bbox: pinAt(500), measuredHeight: 600 });
		expect(p.top).toBe(TOP);
		expect(p.maxH).toBe(H - BOTTOM - TOP);
	});

	it("flips a SHORT card above where a tall one could not fit", () => {
		const bbox = pinAt(620);
		const tall = place({ bbox, measuredHeight: 500 });
		const short = place({ bbox, measuredHeight: 120 });
		expect(short.side).toBe("above");
		expect(short.top + 120).toBeLessThanOrEqual(bbox.minY);
		expect(tall.top).toBeGreaterThanOrEqual(TOP);
	});

	it("never places the card above the top reserve", () => {
		for (let y = TOP; y < H; y += 25) {
			const p = place({ bbox: pinAt(y) });
			expect(p.top).toBeGreaterThanOrEqual(TOP);
		}
	});

	it("never lets a measured-height card overflow the bottom reserve when it can fit", () => {
		const CARD = 240;
		for (let y = TOP; y < H; y += 25) {
			const p = place({ bbox: pinAt(y), measuredHeight: CARD });
			const bottom = p.top + CARD;
			const fits = bottom <= H - BOTTOM;
			expect(fits || p.top === TOP).toBe(true);
		}
	});
});

describe("placePopover — horizontal placement", () => {
	it("centres on the anchor and clamps to the container edges", () => {
		const left = place({ bbox: { minX: 0, maxX: 10, minY: 300, maxY: 340 } });
		expect(left.left).toBeGreaterThanOrEqual(8);
		const right = place({
			bbox: { minX: W - 10, maxX: W, minY: 300, maxY: 340 },
		});
		expect(right.left + right.width).toBeLessThanOrEqual(W - 8);
	});

	// ANTI-LOOP INVARIANT: width must depend only on the container and the crow tile, never on measured height — otherwise measuring creates a real ResizeObserver feedback loop.
	it("never lets width depend on the measured height", () => {
		const crow = { left: 320, top: 600, bottom: 700 };
		for (const bbox of [pinAt(200), pinAt(300), pinAt(400)]) {
			const widths = new Set<number>();
			const lefts = new Set<number>();
			for (const measuredHeight of [80, 150, 220, 400, 650, 900]) {
				const p = place({ bbox, crow, measuredHeight });
				widths.add(p.width);
				lefts.add(p.left);
			}
			expect(widths.size).toBe(1);
			expect(lefts.size).toBe(1);
		}
	});

	it("holds clear of the crow tile when their bands overlap", () => {
		const crow = { left: 320, top: 150, bottom: 300 };
		const p = place({ bbox: pinAt(200), crow });
		expect(p.left + p.width).toBeLessThanOrEqual(crow.left - 10);
	});

	it("ignores the crow tile when it sits outside the usable band entirely", () => {
		// Overlap is judged against the usable band (TOP..H-BOTTOM), never the card's own height — see the anti-loop test above.
		const crow = { left: 320, top: H - 40, bottom: H };
		const p = place({ bbox: pinAt(400), crow, measuredHeight: 200 });
		expect(p.left + p.width).toBeGreaterThan(crow.left - 10);
	});
});

describe("leaderLine — the dotted trail follows the card", () => {
	it("runs DOWN from the pin to the card's top when the card is below", () => {
		const bbox = pinAt(240);
		const p = place({ bbox });
		const l = leaderLine(bbox, p);
		expect(l).not.toBeNull();
		expect(l?.y0).toBeLessThan(l?.y1 ?? 0);
		expect(l?.y1).toBe(p.top);
	});

	it("runs UP from the pin to the card's bottom when the card is above", () => {
		const bbox = pinAt(700);
		const p = place({ bbox, measuredHeight: 200 });
		expect(p.side).toBe("above");
		const l = leaderLine(bbox, p, { measuredHeight: 200 });
		expect(l).not.toBeNull();
		expect(l?.y0).toBeGreaterThan(l?.y1 ?? 0);
		expect(l?.y1).toBe(p.top + 200);
	});

	it("lands inside the card's horizontal span, clear of the corners", () => {
		const bbox = pinAt(700);
		const p = place({ bbox, measuredHeight: 200 });
		const l = leaderLine(bbox, p, { measuredHeight: 200 });
		expect(l?.x1).toBeGreaterThanOrEqual(p.left);
		expect(l?.x1).toBeLessThanOrEqual(p.left + p.width);
	});

	it("returns null when the card is too close to draw a trail", () => {
		const bbox = { minX: 180, maxX: 210, minY: 260, maxY: 300 };
		const p = {
			left: 100,
			top: 303,
			width: 260,
			maxH: 300,
			side: "below" as const,
		};
		expect(leaderLine(bbox, p)).toBeNull();
	});
});
