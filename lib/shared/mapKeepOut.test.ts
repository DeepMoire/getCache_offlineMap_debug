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
        expect(r.y).toBe(96);
        expect(r.y + r.h).toBe(250);
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
        const box: Rect = { x: 235, y: 100, w: 160, h: 100 };
        const rects = [chrome()];
        expect(rectsOverlap(box, rects[0])).toBe(true);

        const x = shiftClear(box, rects, 5, 235);
        expect(x).not.toBeNull();
        expect(rectsOverlap({ ...box, x: x as number }, rects[0])).toBe(false);
        expect(x as number).toBeLessThan(box.x);
    });

    it("returns null when no clear x exists in range", () => {
        const rects = [chrome()];
        const box: Rect = { x: 200, y: 100, w: 380, h: 100 };
        expect(shiftClear(box, rects, 5, 20)).toBeNull();
    });

    it("ignores chrome the box is vertically clear of", () => {
        const box: Rect = { x: 235, y: 400, w: 160, h: 100 };
        expect(shiftClear(box, [chrome()], 5, 235)).toBe(235);
    });
});

describe("mapKeepOutRects", () => {
    it("always includes the top-right column", () => {
        expect(mapKeepOutRects(452, 71)).toHaveLength(1);
    });

    it("adds nothing for left chrome when there is no canvas element", () => {
        expect(mapKeepOutRects(452, 71, null)).toHaveLength(1);
    });
});

describe("the reported bug — long-press under the crow", () => {
    const CANVAS_W = 452;
    const TOP_BAR_MEASURED = 71;
    const GRID_W = 160; // POP_GRID_W
    const EDGE = 5; // POP_EDGE_PX

    it("matches the chrome boxes measured in the live DOM", () => {
        const r = topRightChromeRect(CANVAS_W, TOP_BAR_MEASURED);
        expect(r.x).toBe(364 - 8); // minus PAD
        expect(r.y).toBe(75 - 8);
        expect(r.y + r.h).toBe(213 + 8);
    });

    it("pushes the popover stack fully left of the chrome", () => {
        const rects = [topRightChromeRect(CANVAS_W, TOP_BAR_MEASURED)];
        const painted: Rect = { x: 287, y: 210, w: GRID_W, h: 114 };
        expect(rectsOverlap(painted, rects[0])).toBe(true);

        const x = shiftClear(painted, rects, EDGE, CANVAS_W - EDGE - GRID_W);
        expect(x).toBe(196);
        expect((x as number) + GRID_W).toBe(356);
    });
});
