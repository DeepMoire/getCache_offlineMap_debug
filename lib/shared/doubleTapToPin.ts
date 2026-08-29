/**
 * doubleTapToPin.ts — shared "double-tap OR long-press → Snake Ruler" gesture.
 * ONE implementation for both the offline (`/mobile/offlinev4`) and online (`/mobile/map`) maps — popover chrome, bullseye, Drop button and gesture plumbing must never drift between them.
 * Popover is a DOM `mapboxgl.Popup` with no glyphs — required for offline air-gap safety; styling lives in global `mobile.css` (`.rtr-droppin-*`).
 */
import type { MapMouseEvent, MapTouchEvent, Point } from "mapbox-gl";

/** Structural type both Mapbox (online) and MapLibre (offline) satisfy — same event names/shapes. on/off are typed loosely on purpose; the two libraries' overloads don't unify at the call site. */
type TapMap = {
	doubleClickZoom: { disable(): void };
	// biome-ignore lint/suspicious/noExplicitAny: two renderers, two overload sets
	on(type: string, listener: (e: any) => void): unknown;
	// biome-ignore lint/suspicious/noExplicitAny: mirrors `on`
	off(type: string, listener: (e: any) => void): unknown;
};

// Long-press leaves the pointer down; its eventual click fires as a real tap (opens popovers, etc.) unless swallowed at DOM capture before Mapbox sees it. A window-capture listener (not module state) so Vite HMR duplication can't fork the flag.
function swallowNextClick(windowMs = 250): void {
	const kill = (e: MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		cleanup();
	};
	const cleanup = () => window.removeEventListener("click", kill, true);
	window.addEventListener("click", kill, true);
	// Expire fast if no click comes (e.g. suppressed by the browser) — otherwise a genuine later tap gets eaten.
	setTimeout(cleanup, windowMs);
}

export interface IdentifyResult {
	/** Human label for what's under the tap ("Forest", "Railway"…). */
	label: string;
	/** If present, the caller's `onSelect` is called with it (outline flash). */
	geometry?: GeoJSON.Geometry;
}

export interface DoubleTapToPinOpts {
	/** Best-effort: name what's under the tap. Return null when nothing can be named — popover then shows ONLY the GPS point (no misleading headline). */
	identify?: (point: Point) => IdentifyResult | null | undefined;
	/** Optional: draw (geometry) or clear (null) a selection outline. */
	onSelect?: (geometry: GeoJSON.Geometry | null) => void;
	/** Drop the real pin here (caller sets `dropPinAt = [lng, lat]`). */
	onDrop: (lng: number, lat: number) => void;
	/** Snake Ruler: plant the first ruler node at the tap so it's immediately grabbable (the drag itself is handled elsewhere, in MapDrawControls). */
	onMeasureSeed?: (lng: number, lat: number) => void;
	/** Hands the caller a teardown fn for the "Drop" card + bullseye — call it the moment the tap turns into a ruler drag, or the card goes stale. */
	registerDismiss?: (dismiss: () => void) => void;
}

/** Wire the gesture onto a map; returns a detach function (call it on teardown to remove the handler + any live popover/bullseye). */
export function attachDoubleTapToPin(
	map: TapMap,
	opts: DoubleTapToPinOpts,
): () => void {
	map.doubleClickZoom.disable(); // dblclick drops a pin; pinch / two-finger zooms

	// Clears the identify outline only — the Snake Ruler renders the node and its Save/Share popover itself.
	const teardown = () => opts.onSelect?.(null);
	opts.registerDismiss?.(teardown);

	const onDbl = (e: MapMouseEvent) => {
		teardown(); // clear any prior outline
		const hit = opts.identify?.(e.point) ?? null;
		if (hit?.geometry) opts.onSelect?.(hit.geometry);
		// ⛔ NOT gated by DEBUG, on purpose — without it, "pin didn't drop" and "pin dropped but download failed" look identical (empty console); a silent console after this line means the failure is downstream.
		console.info(
			`[pin] 📍 double-tap at ${e.lngLat.lng.toFixed(5)}, ${e.lngLat.lat.toFixed(5)} — seeding`,
			{ handler: opts.onMeasureSeed ? "attached" : "MISSING (nothing will happen)" },
		);
		// Seed the Snake Ruler's first node at the tap — renders the bullseye + Save/Share popover, or grows into a line/polygon as you drag.
		opts.onMeasureSeed?.(e.lngLat.lng, e.lngLat.lat);
	};

	// Long-press matches double-click as the ONLY two gestures that may seed the ruler — a plain click, drag/pan, or flick must NOT seed; the timer firing while the pointer is still down (never past slop) is itself the proof of "held + still".
	const LONG_PRESS_MS = 550;
	const MOUSE_SLOP_PX = 6; // mouse is precise — tiny radius
	const TOUCH_SLOP_PX = 14; // a finger wobbles — looser radius
	const DEBUG = false; // flip true for verbose [snake-gesture] gesture logging
	const log = (...a: unknown[]) => {
		if (DEBUG) console.log("[snake-gesture]", ...a);
	};

	let pressStart: { x: number; y: number } | null = null;
	let pressLngLat: { lng: number; lat: number } | null = null;
	let pressPoint: Point | null = null;
	let isTouch = false; // touch gesture → use the looser radius
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let downAt = 0; // ms timestamp of mousedown (for logging only)

	// Release swallow arms on the raw DOM release (window capture), NOT the map's mouseup — seeding mounts DOM under the still-held pointer, which fires the map's mouseout and wipes event bookkeeping first.
	let disarmReleaseSwallow: (() => void) | null = null;
	const armReleaseSwallow = () => {
		disarmReleaseSwallow?.();
		const evtName = isTouch ? "touchend" : "mouseup";
		const onRelease = () => {
			disarmReleaseSwallow = null;
			swallowNextClick();
			log("⬆️ release after long-press → swallowing its click");
		};
		window.addEventListener(evtName, onRelease, { capture: true, once: true });
		disarmReleaseSwallow = () => {
			window.removeEventListener(evtName, onRelease, true);
			disarmReleaseSwallow = null;
		};
	};

	const killTimer = () => {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
	};

	const fireLongPress = () => {
		pressTimer = null;
		if (!pressLngLat) return;
		armReleaseSwallow();
		log("✅ LONG-PRESS fires → seed ruler", {
			heldMs: Math.round(performance.now() - downAt),
		});
		teardown(); // clear any prior outline
		const hit = pressPoint ? (opts.identify?.(pressPoint) ?? null) : null;
		if (hit?.geometry) opts.onSelect?.(hit.geometry);
		opts.onMeasureSeed?.(pressLngLat.lng, pressLngLat.lat);
	};

	// Desktop Safari doesn't define TouchEvent — `evt instanceof TouchEvent` throws (not false), killing the gesture; duck-type via "touches" in evt instead of instanceof.
	const isTouchLike = (
		evt: MouseEvent | TouchEvent,
	): evt is TouchEvent => "touches" in evt;

	const getClientCoords = (evt: MouseEvent | TouchEvent) => {
		if (isTouchLike(evt) && evt.touches.length > 0) {
			return { x: evt.touches[0].clientX, y: evt.touches[0].clientY };
		}
		return { x: (evt as MouseEvent).clientX, y: (evt as MouseEvent).clientY };
	};

	const onDown = (e: MapMouseEvent | MapTouchEvent) => {
		// Ignore secondary / non-primary buttons (right-click etc.) on mouse.
		const oe = e.originalEvent;
		if (oe instanceof MouseEvent && oe.button !== 0) return;
		pressStart = getClientCoords(oe);
		pressLngLat = e.lngLat;
		pressPoint = e.point;
		isTouch = isTouchLike(oe); // never `instanceof TouchEvent` — see above
		downAt = performance.now();
		killTimer();
		pressTimer = setTimeout(fireLongPress, LONG_PRESS_MS);
		log("⬇️ down — timer armed", { isTouch, at: pressStart });
	};

	const cancelPress = (why: string) => {
		if (pressStart) log(`✖️ cancel (${why})`);
		killTimer();
		pressStart = null;
		pressLngLat = null;
		pressPoint = null;
	};

	const onMove = (e: MapMouseEvent | MapTouchEvent) => {
		if (!pressStart || !pressTimer) return; // nothing armed
		const coords = getClientCoords(e.originalEvent);
		const dist = Math.hypot(coords.x - pressStart.x, coords.y - pressStart.y);
		const slop = isTouch ? TOUCH_SLOP_PX : MOUSE_SLOP_PX;
		if (dist > slop) {
			log("↔️ move past slop → DRAG, not press", {
				dist: Math.round(dist),
				slop,
			});
			cancelPress("drag past slop");
		}
	};

	const onUp = () => {
		// Released before the timer fired → it was a click, not a long-press.
		if (pressTimer)
			log("⬆️ up before timer → CLICK (no seed)", {
				heldMs: Math.round(performance.now() - downAt),
			});
		cancelPress("pointer up");
	};

	// Named wrappers so on/off share the same refs (inline arrows wouldn't detach).
	const onMouseOut = () => cancelPress("mouseout");
	const onDragStart = () => cancelPress("map dragstart"); // map began panning
	const onContextMenu = () => cancelPress("contextmenu"); // right-click cancels
	const onTouchCancel = () => cancelPress("touchcancel");

	map.on("dblclick", onDbl);
	map.on("mousedown", onDown);
	map.on("mousemove", onMove);
	map.on("mouseup", onUp);
	map.on("mouseout", onMouseOut);
	map.on("dragstart", onDragStart); // belt-and-braces: any pan kills a press
	map.on("contextmenu", onContextMenu);
	// Touch events: same long-press on mobile
	map.on("touchstart", onDown);
	map.on("touchmove", onMove);
	map.on("touchend", onUp);
	map.on("touchcancel", onTouchCancel);

	return () => {
		map.off("dblclick", onDbl);
		map.off("mousedown", onDown);
		map.off("mousemove", onMove);
		map.off("mouseup", onUp);
		map.off("mouseout", onMouseOut);
		map.off("dragstart", onDragStart);
		map.off("contextmenu", onContextMenu);
		map.off("touchstart", onDown);
		map.off("touchmove", onMove);
		map.off("touchend", onUp);
		map.off("touchcancel", onTouchCancel);
		cancelPress("detach");
		disarmReleaseSwallow?.();
		teardown();
	};
}
