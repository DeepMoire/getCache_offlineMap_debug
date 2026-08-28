import { describe, expect, it } from "vitest";
import {
    type Rect,
    mapKeepOutRects,
    rectsOverlap,
    shiftClear,
    topRightChromeRect,
} from "./mapKeepOut";

const TOP_BAR = 100; // what MapTopControls measures into --top-bar-h

describe("topRightChromeRect", () => {
    it("covers the eye AND the crow as one solid column", () => {
        const r = topRightChromeRect(400, TOP_BAR);
        // top-bar 100 + eye top 4 - pad 8 = 96
        expect(r.y).toBe(96);
        // top-bar 100 + crow top 80 + crow height 62 + pad 8 = 250
        expect(r.y + r.h).toBe(250);
        // reaches the right edge (right:14 + width:74 + pad:8 spans past canvasW)
        expect(r.x + r.w).toBeGreaterThanOrEqual(400);
    });

    it("tracks the right edge as the canvas widens", () => {
        expect(topRightChromeRect(800, TOP_BAR).x - topRightChromeRect(400, TOP_BAR).x).toBe(400);
    });
});

describe("shiftClear", () => {
    const chrome = (): Rect => topRightChromeRect(400, TOP_BAR);

    it("leaves a box alone when it already clears the chrome", () => {
        const box: Rect = { x: 20, y: 96, w: 160, h: 100 };
        expect(shiftClear(box, [chrome()], 5, 235)).toBe(20);
    });

    it("slides LEFT of the chrome when the box overlaps it", () => {
        // The reported bug: 2x2 grid centred near the right edge, at chrome height.
        const box: Rect = { x: 235, y: 100, w: 160, h: 100 };
        const rects = [chrome()];
        expect(rectsOverlap(box, rects[0])).toBe(true);

        const x = shiftClear(box, rects, 5, 235);
        expect(x).not.toBeNull();
        expect(rectsOverlap({ ...box, x: x as number }, rects[0])).toBe(false);
        expect(x as number).toBeLessThan(box.x); // moved LEFT, not right
    });

    it("returns null when no clear x exists in range", () => {
        // Box as wide as the space left of the chrome + clamp range — nowhere to go.
        const rects = [chrome()];
        const box: Rect = { x: 200, y: 100, w: 380, h: 100 };
        expect(shiftClear(box, rects, 5, 20)).toBeNull();
    });

    it("ignores chrome the box is vertically clear of", () => {
        // Same x as the bug case, but far below the chrome column.
        const box: Rect = { x: 235, y: 400, w: 160, h: 100 };
        expect(shiftClear(box, [chrome()], 5, 235)).toBe(235);
    });
});

describe("mapKeepOutRects", () => {
    it("always includes the top-right column", () => {
        expect(mapKeepOutRects(452, 71)).toHaveLength(1);
    });

    it("adds nothing for left chrome when there is no canvas element", () => {
        // No DOM here — the left strips are measured, so they simply don't apply.
        expect(mapKeepOutRects(452, 71, null)).toHaveLength(1);
    });
});

// Numbers measured live in the browser on /mobile/map (canvas 452x936,
// --top-bar-h 71px) at the exact long-press that produced the reported bug.
// They pin the real geometry so a CSS tweak in MapTopControls can't silently
// slide the chrome out from under this math.
describe("the reported bug — long-press under the crow", () => {
    const CANVAS_W = 452;
    const TOP_BAR_MEASURED = 71;
    const GRID_W = 160; // POP_GRID_W
    const EDGE = 5; // POP_EDGE_PX

    it("matches the chrome boxes measured in the live DOM", () => {
        const r = topRightChromeRect(CANVAS_W, TOP_BAR_MEASURED);
        // eye box measured at x=364,y=75 ; crow bottom measured at 213
        expect(r.x).toBe(364 - 8); // minus PAD
        expect(r.y).toBe(75 - 8);
        expect(r.y + r.h).toBe(213 + 8);
    });

    it("pushes the popover stack fully left of the chrome", () => {
        const rects = [topRightChromeRect(CANVAS_W, TOP_BAR_MEASURED)];
        // Pre-fix painted position: right edge ran to 447, under the crow column.
        const painted: Rect = { x: 287, y: 210, w: GRID_W, h: 114 };
        expect(rectsOverlap(painted, rects[0])).toBe(true);

        const x = shiftClear(painted, rects, EDGE, CANVAS_W - EDGE - GRID_W);
        // Measured post-fix: popover x=196, right edge exactly 356 = keep-out left.
        expect(x).toBe(196);
        expect((x as number) + GRID_W).toBe(356);
    });
});
