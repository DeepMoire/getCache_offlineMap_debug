/**
 * KEEP-OUT REGIONS — the map's floating chrome, published as rectangles.
 *
 * The map canvas is not empty space. Buttons float on top of it (the eye
 * toggle, the crow online/offline switch, the draw palette...). A popover that
 * only tests "am I inside the canvas?" happily lands underneath one of them —
 * on the viewport, but unreadable and un-tappable.
 *
 * This is the browser's own popover behaviour generalised. CSS anchor
 * positioning gives you `position-try-fallbacks` against the VIEWPORT; there is
 * no such thing for "and also dodge that button". So we publish the chrome
 * boxes here, once, and anything that floats over the map dodges them.
 *
 * WHY A MODULE AND NOT A CONSTANT IN THE POPOVER: the chrome positions live in
 * MapTopControls.svelte's CSS. Anyone who needs to dodge them was previously
 * re-deriving them by eye (see the `side="below"` hack on SharePicker inside
 * SnakeRuler). One publisher, many dodgers.
 *
 * Coordinates are MAP-CANVAS relative. `.below-top-bar`, `.draw-strip` and the
 * canvas are all children of the same `position: fixed; inset: 0` box
 * (`.mobile-map-fill`), so a chrome element's CSS offset IS its canvas
 * coordinate — no conversion needed.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Read `--top-bar-h` (written at runtime by MapTopControls). Fallback 64px = 4rem.
 * The only impure function here — everything below takes it as an argument so
 * the geometry stays testable without a DOM.
 */
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

/**
 * The top-right chrome column (eye toggle + crow switch) as ONE rectangle —
 * the gap between them is 14px, too small to thread a popover through, so we
 * treat the whole column as solid.
 */
export function topRightChromeRect(canvasW: number, topBarH: number): Rect {
    const t = topBarH;
    const x = canvasW - CHROME_RIGHT - CHROME_W;
    const y = t + EYE_TOP;
    const bottom = t + CROW_TOP + CHROME_H;
    return { x: x - PAD, y: y - PAD, w: CHROME_W + CHROME_RIGHT + PAD, h: bottom - y + PAD * 2 };
}

/**
 * Top-LEFT chrome — the draw palette and the tracking strip. Unlike the
 * top-right column these come and go (the tracking strip only exists while
 * tracking is live, the palette only in draw mode) and their heights are
 * content-driven, so hardcoding their CSS here would drift. Measure the real
 * elements instead; absent element = no keep-out, which is exactly right.
 */
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

/**
 * Every keep-out region currently painted over the map canvas.
 *
 * `canvasEl` is optional so callers that only have a width still get the
 * top-right column (the fixed, always-present one).
 */
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

/**
 * Slide `box` HORIZONTALLY until it clears every keep-out rect, staying within
 * [minX, maxX]. Returns the new x, or null if no clear x exists.
 *
 * Horizontal-only on purpose: the caller owns the vertical axis (it flips
 * above/below the snake), so shifting vertically here would fight that. This is
 * floating-ui's `shift` middleware, restricted to one axis and to obstacles
 * rather than the viewport boundary.
 *
 * Tries LEFT of the obstacle first, then RIGHT — matching the user's read of
 * how a popover should behave ("ideally to the left or to the bottom").
 */
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
