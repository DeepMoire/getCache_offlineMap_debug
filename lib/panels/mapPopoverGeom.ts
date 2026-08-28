// Map-popover placement math — pure, so it can be tested without a map.
//
// Extracted from MapPopoverShell's $derived. The shell owns the DOM, the
// gestures and the crow measurement; this owns WHERE the card goes.
//
// THE LAW: the side is CHOSEN BY MEASUREMENT, never assumed. Points used to
// hardcode "always below" on the premise that a tapped pin is first flown to
// PIN_TARGET_Y (240) near the top of the screen. That premise is only true at
// the instant of the tap — the bbox is recomputed on every map `move`, so as
// soon as the user pans, the pin can sit anywhere, and an always-below card
// walked straight off the bottom of the viewport. Polygons never had the bug
// because they always measured both sides. Now everything measures.

export type Bbox = { minX: number; minY: number; maxX: number; maxY: number };

export type PlaceInput = {
	bbox: Bbox;
	containerWidth: number;
	containerHeight: number;
	/** Point features get the pin gap + the dotted leader trail. */
	isPoint: boolean;
	/** Full-deck variant — runs near container width instead of the 260px cap. */
	wide: boolean;
	/** Chrome reserves: app top bar / draw strip, and tab bar / shovel. */
	topReserve: number;
	bottomReserve: number;
	/** The card's measured height, when the DOM has reported one. Before first
	 *  measure, callers pass undefined and we fall back to ESTIMATED_HEIGHT. */
	measuredHeight?: number;
	/** The crow / basemap tile's no-go rect, in container coordinates. */
	crow?: { left: number; top: number; bottom: number } | null;
};

export type Placement = {
	left: number;
	top: number;
	width: number;
	maxH: number;
	/** Which side of the anchor the card landed on. Drives the leader trail. */
	side: "above" | "below";
};

/** Gap between the anchor bbox and the card. */
const OFFSET = 15;
/** Extra breathing room for a pin, so the card clears the icon's point. */
const PIN_GAP = 18;
/** Edge padding against the container's left/right walls. */
const PAD = 8;
/** Keep clear of the crow tile by this much. */
const CROW_CLEARANCE = 10;
/** Height assumed before the card has been measured. Matches the old
 *  polygon-branch constant, which was tuned against the compact card. */
export const ESTIMATED_HEIGHT = 220;
/** Never squeeze the card below this, however tight the viewport. */
const MIN_HEIGHT = 160;
const MIN_WIDTH = 160;

/**
 * Place the popover card against its anchor.
 *
 * Side choice is symmetric for points and polygons: take the side with more
 * room, unless the preferred side can hold the whole card. A point adds
 * PIN_GAP to its anchor offset on both sides so the card never crowds the pin.
 */
export function placePopover(input: PlaceInput): Placement {
	const {
		bbox,
		containerWidth,
		containerHeight,
		isPoint,
		wide,
		topReserve,
		bottomReserve,
		measuredHeight,
		crow,
	} = input;

	const cap = wide ? containerWidth - 64 : 260;
	let width = Math.max(MIN_WIDTH, Math.min(cap, containerWidth - PAD * 2));

	const usableTop = topReserve;
	const usableBottom = containerHeight - bottomReserve;

	// A pin's card sits further off its anchor than a polygon's.
	const gap = OFFSET + (isPoint ? PIN_GAP : 0);
	const height =
		measuredHeight && measuredHeight > 0 ? measuredHeight : ESTIMATED_HEIGHT;

	const roomBelow = usableBottom - (bbox.maxY + gap);
	const roomAbove = bbox.minY - gap - usableTop;

	// MEASURE, DON'T ASSUME. Below is the default — a card under the anchor
	// reads better and keeps the anchor in view above it. Flip up only when
	// below genuinely can't hold the card AND above has more room. That's the
	// off-the-viewport case the user hit: pin near the bottom, card below it
	// walking off-screen, when there was plenty of room above the pin.
	const fitsBelow = roomBelow >= height;
	const side: "above" | "below" =
		fitsBelow || roomBelow >= roomAbove ? "below" : "above";

	let top =
		side === "below"
			? bbox.maxY + gap
			: // Above: the card's BOTTOM sits `gap` over the anchor's top edge.
				bbox.minY - gap - height;

	// Clamp into the usable band. Above-placement can still overshoot the top
	// reserve when the card is taller than the room; below-placement is pulled
	// back up so its bottom clears the tab bar. Top clamp wins (never hide the
	// card's header under the chrome) — a too-tall card then scrolls via maxH.
	if (side === "below") top = Math.min(top, usableBottom - height);
	top = Math.max(usableTop, top);

	const maxH = Math.max(MIN_HEIGHT, usableBottom - top);

	const centerX = (bbox.minX + bbox.maxX) / 2;
	let left = centerX - width / 2;
	left = Math.max(PAD, Math.min(left, containerWidth - width - PAD));

	// CROW NO-GO: if the card's vertical span overlaps the crow tile's band,
	// keep its right edge LEFT of the tile. Prefer shifting the card left; if
	// it can't shift far enough, shrink it so the tile stays reachable.
	//
	// WIDTH MUST NOT DEPEND ON HEIGHT. The overlap test deliberately uses the
	// card's FULL available band (usableTop..usableBottom), not its measured
	// height. Using the height here closed a feedback loop through layout:
	// measured height → vertOverlap → width shrinks → content re-wraps →
	// height changes → measured again ("ResizeObserver loop completed with
	// undelivered notifications"). Width now depends only on the container and
	// the tile — both independent of content — so measuring can never change it.
	if (crow) {
		const vertOverlap = usableTop < crow.bottom && usableBottom > crow.top;
		if (vertOverlap) {
			const maxRight = crow.left - CROW_CLEARANCE;
			if (left + width > maxRight) {
				const shifted = maxRight - width;
				if (shifted >= PAD) {
					left = shifted; // slid left, full width kept
				} else {
					left = PAD; // pinned left, shrink to clear the tile
					width = Math.max(MIN_WIDTH, maxRight - PAD);
				}
			}
		}
	}

	return { left, top, width, maxH, side };
}

export type Leader = { x0: number; y0: number; x1: number; y1: number };

/**
 * The dotted trail tying a pin to its card. Runs from the pin edge to the
 * NEAR edge of the card — the card's top when it sits below, its bottom when
 * it sits above. Returns null when the gap is too short to read as a trail.
 */
export function leaderLine(
	bbox: Bbox,
	place: Placement,
	opts: { measuredHeight?: number } = {},
): Leader | null {
	const MIN_RUN = 10;
	/** Land inside the card's edge, clear of the rounded corners. */
	const INSET = 16;
	const x0 = (bbox.minX + bbox.maxX) / 2;
	const x1 = Math.max(
		place.left + INSET,
		Math.min(x0, place.left + place.width - INSET),
	);

	if (place.side === "below") {
		const y0 = bbox.maxY + 3;
		const y1 = place.top;
		if (y1 - y0 < MIN_RUN) return null;
		return { x0, y0, x1, y1 };
	}

	// Above: start just over the pin's tip and run UP to the card's bottom.
	const height =
		opts.measuredHeight && opts.measuredHeight > 0 ? opts.measuredHeight : null;
	const cardBottom = height
		? place.top + Math.min(height, place.maxH)
		: place.top + place.maxH;
	const y0 = bbox.minY - 3;
	const y1 = cardBottom;
	if (y0 - y1 < MIN_RUN) return null;
	return { x0, y0, x1, y1 };
}
