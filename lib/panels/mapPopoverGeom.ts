// Map-popover placement math — pure, so it can be tested without a map.
// THE LAW: side is CHOSEN BY MEASUREMENT, never assumed — an always-below card can walk off the bottom of the viewport once the pin pans away from its post-tap landing spot.

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
	/** The card's measured height once the DOM has reported one; undefined before first measure, falls back to ESTIMATED_HEIGHT. */
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
/** Height assumed before the card has been measured. */
export const ESTIMATED_HEIGHT = 220;
/** Never squeeze the card below this, however tight the viewport. */
const MIN_HEIGHT = 160;
const MIN_WIDTH = 160;

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

	// MEASURE, DON'T ASSUME — below is default; flip up only when below can't hold the card AND above has more room.
	const fitsBelow = roomBelow >= height;
	const side: "above" | "below" =
		fitsBelow || roomBelow >= roomAbove ? "below" : "above";

	let top =
		side === "below"
			? bbox.maxY + gap
			: // Above: the card's BOTTOM sits `gap` over the anchor's top edge.
				bbox.minY - gap - height;

	// Clamp into the usable band — top clamp wins (never hide the card's header under the chrome); an overly tall card scrolls via maxH instead.
	if (side === "below") top = Math.min(top, usableBottom - height);
	top = Math.max(usableTop, top);

	const maxH = Math.max(MIN_HEIGHT, usableBottom - top);

	const centerX = (bbox.minX + bbox.maxX) / 2;
	let left = centerX - width / 2;
	left = Math.max(PAD, Math.min(left, containerWidth - width - PAD));

	// WIDTH MUST NOT DEPEND ON HEIGHT — that closed a real ResizeObserver feedback loop (measured height → width shrinks → content re-wraps → height changes → measured again). Width depends only on the container and the crow tile, both content-independent.
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
