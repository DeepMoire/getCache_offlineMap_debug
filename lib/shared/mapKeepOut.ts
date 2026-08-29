export type Rect = { x: number; y: number; w: number; h: number };

// Coordinates here are canvas-relative already — chrome elements share the fixed .mobile-map-fill box, so no conversion is needed.

// Reads --top-bar-h; falls back to 64px (4rem) when there's no DOM.
export function readTopBarH(): number {
    if (typeof document === "undefined") return 64;
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--top-bar-h");
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 64;
}

// Mirrors MapTopControls.svelte CSS. If those change, change these.
const CHROME_RIGHT = 14; // .eye-toggle / .crow-slot `right`
const CHROME_W = 74; // both boxes
const CHROME_H = 62; // both boxes
const EYE_TOP = 4; // .eye-toggle `top`, inside .below-top-bar
const CROW_TOP = 80; // .crow-slot `top`, inside .below-top-bar
const PAD = 8; // breathing room so the popover doesn't kiss the button

// Eye toggle + crow switch as ONE rect — the 14px gap is too small for a popover to fit through.
export function topRightChromeRect(canvasW: number, topBarH: number): Rect {
    const t = topBarH;
    const x = canvasW - CHROME_RIGHT - CHROME_W;
    const y = t + EYE_TOP;
    const bottom = t + CROW_TOP + CHROME_H;
    return { x: x - PAD, y: y - PAD, w: CHROME_W + CHROME_RIGHT + PAD, h: bottom - y + PAD * 2 };
}

// Left chrome (draw palette, tracking strip) is measured live, not hardcoded — their heights are content-driven and would drift.
const LEFT_CHROME_SELECTORS = [".draw-strip", ".tracking-strip"];

function measuredLeftChrome(canvasEl: Element | null): Rect[] {
    if (typeof document === "undefined" || !canvasEl) return [];
    const base = canvasEl.getBoundingClientRect();
    const out: Rect[] = [];
    for (const sel of LEFT_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue; // hidden / collapsed
        out.push({
            x: b.left - base.left - PAD,
            y: b.top - base.top - PAD,
            w: b.width + PAD * 2,
            h: b.height + PAD * 2,
        });
    }
    return out;
}

// Every keep-out region currently painted over the map canvas.
export function mapKeepOutRects(
    canvasW: number,
    topBarH = readTopBarH(),
    canvasEl: Element | null = null,
): Rect[] {
    return [topRightChromeRect(canvasW, topBarH), ...measuredLeftChrome(canvasEl)];
}

/** Do two rectangles overlap at all? Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Slides box horizontally until clear of every keep-out rect within [minX, maxX]; returns the new x, or null if none exists.
// Horizontal-only on purpose — the caller owns the vertical axis; shifting it here would fight that.
export function shiftClear(
    box: Rect,
    rects: Rect[],
    minX: number,
    maxX: number,
): number | null {
    const hit = rects.find((r) => rectsOverlap(box, r));
    if (!hit) return box.x;

    const left = hit.x - box.w; // box's right edge just left of the obstacle
    const right = hit.x + hit.w; // box's left edge just right of the obstacle
    for (const cand of [left, right]) {
        if (cand < minX || cand > maxX) continue;
        const moved = { ...box, x: cand };
        if (!rects.some((r) => rectsOverlap(moved, r))) return cand;
    }
    return null;
}
