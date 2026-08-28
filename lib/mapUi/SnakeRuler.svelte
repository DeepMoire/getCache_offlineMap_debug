<!--
  SnakeRuler.svelte — the Snake Ruler measure tool, fully self-contained.

  A SEPARATE feature from the draw palette (LINE/POLY/PIN). It owns ALL its own
  state (its own vertices, never the draw tool's `drawnVertices`/`drawIntent`),
  renders its own dark "technical ruler" GL layers + grab hands + readout, and on
  Save/Share hands the finished geometry back to the host via `onPersist` — which
  runs the normal feature create + select (+ share) flow.

  Entry: the host's double-tap / long-press gesture seeds the first node via
  `measureEvent`. From there CLICK-TO-PLACE is the standard mode: each tap
  appends a node, tapping the LAST node commits, tapping the FIRST (3+ nodes)
  closes it into a polygon. Dragging an end hand (or the gold node) still grows
  the snake; snapping the far end onto the other closes it into a polygon
  (hysteresis so a release-wobble can't un-close it). It NEVER touches draw
  state, so it can't open the draw palette.
-->
<script lang="ts">
import { iconPath } from "$lib/mobile/utils/icons";
// Cursor art comes from `$parent/retreeved/sharedAssets` — retreeved/ is the SINGLE
// SOURCE OF TRUTH for shared art. It used to be the static URL
// `/mobileAssets/...`, which only resolves on this server, so a child or
// any other tier reusing the same hand had to keep its own second copy.
// Importing binds the bytes to the build instead of to one host's URL.
import handShovelCursor from "$parent/retreeved/sharedAssets/hand_shovel_cursor.webp";
import handShovelCursorRight from "$parent/retreeved/sharedAssets/hand_shovel_cursor_right.webp";
import handShovelCursor100 from "$parent/retreeved/sharedAssets/hand_shovel_cursor_100.webp";
import type { Feature } from "geojson";
import mapboxgl from "mapbox-gl";
import type { Map as MapboxMap } from "mapbox-gl";
import { area, length as turfLength } from "@turf/turf";
// The ruler runs on BOTH maps (online = Mapbox, offline = MapLibre). A Marker
// from the wrong library throws "_addMarker is not a function" on addTo.
import { markerCtor } from "$parent/siblings/getCache_OfflineMap/lib/shared/rendererOf";
import type { Lnglat } from "$parent/siblings/getCache_OnlineMap/lib/mapDraw";
import Icon from "$lib/core/icon/Icon.svelte";
import { formatHectares, formatMeasureDist } from "$parent/siblings/getCache_OfflineMap/lib/panels/measureFormat";
import SharePicker, {
    type ShareFormat,
} from "$lib/mobile/components/ui/SharePicker.svelte";
import { copyToClipboard } from "$lib/mobile/utils/copyToClipboard";
import { type Rect, mapKeepOutRects, shiftClear } from "$parent/siblings/getCache_OfflineMap/lib/shared/mapKeepOut";
import type { MapShareFormat } from "$lib/mobile/utils/kmzExport";

let {
    map,
    measureEvent = $bindable(null),
    armKind = $bindable(null),
    onMeasureDrag,
    onPersist,
    onSavePoint,
    onPlot,
    onActivate,
    userCoord,
    onSnapSelf,
    gridSnap,
    setGridGlow,
}: {
    map: MapboxMap | null;
    // Seed from the host's double-tap gesture: plant the first ruler node.
    measureEvent?: { lng: number; lat: number; n: number } | null;
    // Palette entry: arm the SAME ruler in a tap-to-build mode.
    //   pin     → a tap DROPS the pin right there (host opens its editor — the
    //             PIN tool never detours through the ruler's measure popover)
    //   line    → tap drops ONE bullseye, then the hands extend it
    //   polygon → each tap drops a corner of an always-closed snake polygon (no hands)
    // null = not armed (double-tap + hands is the other way in). Palette mode shows
    // Save only (no inline Share — you Save first, then send the saved feature).
    armKind?: "line" | "polygon" | "pin" | null;
    // Fired the instant an end is grabbed — the host tears down the stale
    // double-tap "Drop a pin" card (it's a ruler now, not a pin).
    onMeasureDrag?: (() => void) | undefined;
    // Save/Share: hand the finished geometry to the host to persist + select
    // (+ share when `share` is true), then the ruler clears itself. `format`
    // is the SharePicker choice (.getcache / .kmz) riding with share=true.
    onPersist: (
        kind: "line" | "polygon",
        verts: Lnglat[],
        share: boolean,
        format?: MapShareFormat,
    ) => void;
    // Single-point Save: drop a real pin at this spot (host opens the pin editor).
    onSavePoint?: ((lng: number, lat: number) => void) | undefined;
    // Single-point "Plot": throw a Quality 704 plot at this spot — adds a
    // geo-referenced plot to the active inspection. The killer feature: drop
    // plots straight from the map, not just from the survey screen. `atSelf` =
    // the seed snapped onto the user's own blue dot → proof they were physically
    // there (the host stamps the plot's atUserLocation provenance flag).
    // `plusCode` is the snapped grid dot's id (null if the plot dropped free,
    // not on a grid dot). The host stamps it on the plot when present.
    onPlot?:
        | ((
              lng: number,
              lat: number,
              atSelf: boolean,
              plusCode: string | null,
          ) => void)
        | undefined;
    // Fired when the ruler activates, so the host can deselect any feature.
    onActivate?: (() => void) | undefined;
    // The live user-location ("blue dot") coord, or null if no GPS fix yet.
    // A double-tap seed within SELF_SNAP_PX of it snaps ONTO it (snap-to-self).
    userCoord?: (() => Lnglat | null) | undefined;
    // Fired the instant a seed snaps to self — the host pulses the blue dot so
    // the user feels the "got you, placing exactly where you are" connection.
    onSnapSelf?: (() => void) | undefined;
    // SNAP-TO-GRID. `gridSnap(lng,lat)` returns the nearest audit-grid dot
    // within the magnet radius (or null → drop free), and `setGridGlow(dot)`
    // pulses the gold heads-up ring on that dot. Both null/absent when the grid
    // is off or snapping is disabled — then the plot seed behaves exactly as
    // before. The returned dot carries the Plus Code stamped onto the plot.
    gridSnap?:
        | ((
              lng: number,
              lat: number,
          ) => { lng: number; lat: number; plusCode: string } | null)
        | undefined;
    setGridGlow?:
        | ((
              dot: { lng: number; lat: number; plusCode: string } | null,
          ) => void)
        | undefined;
} = $props();

// ── State (independent — not shared with the draw tool) ──────────────────
let active = $state(false); // measure mode on
let verts: Lnglat[] = $state([]); // committed ruler nodes
let cursor: Lnglat | null = $state(null); // live tip while dragging an end
let isPolygon = $state(false); // far end snapped onto the other → closed
let dragFromHead = false; // which end the current drag pulls (true = vertex 0)
let dragAnchor: Lnglat | null = null; // the grabbed end's position at drag start
// Polygon RESHAPE: once closed, you can't un-close it, but you CAN drag any
// vertex to move it. moveIndex = the vertex being dragged (cursor = its live
// position); null when not reshaping a polygon.
let moveIndex: number | null = $state(null);
let mapMoveSeq = $state(0); // bumped on every camera move → re-project the chrome
// Palette tap-to-build mode (null = double-tap + hands). `paletteMode` mirrors
// "armed !== null" for the template — palette entries hide the inline Share.
let armed: "line" | "polygon" | "pin" | null = $state(null);
let paletteMode = $derived(armed !== null);

let canFinish = $derived(isPolygon ? verts.length >= 3 : verts.length >= 2);
// A lone placed point with the single-point popover (Save = pin). Only for the
// double-tap/long-press ruler — the PIN tool drops immediately (no lone-point
// state) and a 1-vertex LINE/POLYGON is still mid-build.
let singlePoint = $derived(
    active && !isPolygon && !cursor && verts.length === 1 && !armed,
);
let copied = $state(false); // "Copied!" feedback after a single-point Share
let copyFailed = $state(false); // "Couldn't copy" — the write was blocked
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
// SNAP-TO-SELF: true when the double-tap seed landed on the user's own blue dot
// (within SELF_SNAP_PX) and we snapped the node exactly onto it. The lone-point
// popover then reads "At your location" and the Plot it throws is stamped as
// proof-of-presence. Only meaningful while it's a single point — cleared the
// moment it grows into a ruler/polygon or is discarded.
let seedAtSelf = $state(false);
// SNAP-TO-GRID: the audit-grid dot the lone plot seed is currently magnetised
// to (or null = will drop free). Recomputed reactively as the seed / camera
// moves; drives the gold glow ring and the Plus Code stamped on the plot.
let gridSnapDot = $state<{ lng: number; lat: number; plusCode: string } | null>(
    null,
);

// ── Layers ───────────────────────────────────────────────────────────────
const MEASURE_LINE_SRC = "measure-line";
const MEASURE_NODES_SRC = "measure-nodes";
const MEASURE_FILL_SRC = "measure-fill";
const MEASURE_TICKS_SRC = "measure-ticks";
const MEASURE_ENDDOTS_SRC = "measure-end-dots"; // rust centre dots on the two ends
const MEASURE_SNAP_PX = 18; // tip within this many px of the far end → snap to polygon
const SELF_SNAP_PX = 22; // double-tap seed within this many px of the blue dot → snap onto self (≈44px touch target — the iOS HIG / Material minimum)
const FINISH_TAP_PX = 22; // click-to-place: tap within this of a node = that node (≈44px touch target, same as SELF_SNAP_PX)
const MEASURE_UNSNAP_PX = 34; // once snapped, must drag past THIS to un-polygon (hysteresis)
const LEG_LABEL_FRAC = 0.78; // leg label sits this far toward the leg's END
const LEG_LABEL_OFF = 18; // px the leg label is nudged off the band (perpendicular)
const LABEL_HALF_H = 10; // approx half a leg-label's height — clearance for the chrome
const TOTAL_TAIL_BIAS = 0.35; // big total nudged this fraction from centre → tail (≈ half the leg-label shift)

function setData(id: string, fc: GeoJSON.FeatureCollection) {
    const src = map?.getSource(id);
    if (src && "setData" in src) {
        (src as unknown as { setData: (d: GeoJSON.FeatureCollection) => void }).setData(fc);
    }
}

function ensureLayers() {
    if (!map || map.getSource(MEASURE_LINE_SRC)) return;
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    map.addSource(MEASURE_FILL_SRC, { type: "geojson", data: empty });
    map.addSource(MEASURE_LINE_SRC, { type: "geojson", data: empty });
    map.addSource(MEASURE_TICKS_SRC, { type: "geojson", data: empty });
    map.addSource(MEASURE_NODES_SRC, { type: "geojson", data: empty });
    map.addSource(MEASURE_ENDDOTS_SRC, { type: "geojson", data: empty });
    // LIVE polygon body — visibly yellow (the ruler's own gold family, same as
    // the bullseye nodes + gold leg ticks), so an in-progress measurement reads
    // "live, not yet saved". Saving flips it to the orange POLYGON_FILL. A flat
    // fill can't do a radial gradient, so we stack two layers: a broad ~14% wash
    // over the whole body + a denser core. Together they read ~22% and feel
    // "denser toward the centre" (the look the user picked in the mockup).
    map.addLayer({
        id: "measure-fill", type: "fill", source: MEASURE_FILL_SRC,
        paint: { "fill-color": "#ffd54a", "fill-opacity": 0.22 },
    });
    // TRANSLUCENT slate "ruler tape" the snake rides on (the harness look). NO centre
    // line and NO offset bevel — the snake bends in every direction, so a
    // directional top/bottom shadow flips and looks wrong; a single flat
    // translucent band reads cleanly at any angle. Ticks ride on top.
    map.addLayer({
        id: "measure-line-casing", type: "line", source: MEASURE_LINE_SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#41454d", "line-width": 12, "line-opacity": 0.55 },
    });
    // Tiered hairline ticks: GOLD per-leg centre (boldest) > white 1/4 + 3/4 marks
    // (medium) > fine white graduations (thinnest). Colour + width data-driven off
    // the `kind` property.
    map.addLayer({
        id: "measure-ticks", type: "line", source: MEASURE_TICKS_SRC,
        paint: {
            "line-color": ["match", ["get", "kind"], "half", "#ffd700", "#ffffff"],
            "line-width": ["match", ["get", "kind"], "half", 1.6, "quarter", 1.1, 0.75],
        },
    });
    map.addLayer({
        id: "measure-nodes", type: "circle", source: MEASURE_NODES_SRC,
        paint: {
            "circle-radius": 4.5, "circle-color": "#000000", "circle-opacity": 0,
            "circle-stroke-color": "#f5d565", "circle-stroke-width": 2,
        },
    });
    // Invisible fat halo so a node is easy to grab with a finger.
    map.addLayer({
        id: "measure-nodes-halo", type: "circle", source: MEASURE_NODES_SRC,
        paint: { "circle-radius": 16, "circle-color": "#ffffff", "circle-opacity": 0.01 },
    });
    // Small rust centre dot on JUST the two ends, so the grabbable ends read
    // differently from the fixed middle nodes. 4px diameter = radius 2.
    map.addLayer({
        id: "measure-end-dots", type: "circle", source: MEASURE_ENDDOTS_SRC,
        paint: { "circle-radius": 2, "circle-color": "#c97a4a" },
    });
}

// Perpendicular tick marks — the ruler/tape look. Each LEG of the snake is its
// OWN ruler: a GOLD tick at the leg's centre, with white graduation ticks
// stepping symmetrically OUTWARD from that centre. Building per-leg (rather than
// one continuous walk across the whole path) keeps every leg mirror-symmetric
// about its gold centre and stops adjacent legs' ticks fighting across a bend.
// All ticks are centred on the band and kept screen-constant (rebuilt on move).
function buildTicksFC(ring: Lnglat[]): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    if (!map || ring.length < 2) return { type: "FeatureCollection", features };
    const SPACING_PX = 13; // target gap between ticks (sets how many divisions a leg gets)
    const MINOR_PX = 2.5; // fine graduation half-length (tiny)
    const QUARTER_PX = 4; // 1/4 + 3/4 mark half-length (medium)
    const GOLD_PX = 6; // leg-centre half-length = band half-width (flush, no poke)
    const END_MARGIN = 10; // keep ticks clear of the end nodes / vertices

    // A perpendicular tick CENTRED on the band at screen (cx,cy) along unit (ux,uy).
    const tick = (cx: number, cy: number, ux: number, uy: number, half: number, kind: string) => {
        const px = -uy, py = ux;
        const p1 = map!.unproject([cx - px * half, cy - py * half]);
        const p2 = map!.unproject([cx + px * half, cy + py * half]);
        features.push({
            type: "Feature", properties: { kind },
            geometry: { type: "LineString", coordinates: [[p1.lng, p1.lat], [p2.lng, p2.lat]] },
        });
    };

    for (let i = 0; i < ring.length - 1; i++) {
        const a = map.project({ lng: ring[i][0], lat: ring[i][1] });
        const b = map.project({ lng: ring[i + 1][0], lat: ring[i + 1][1] });
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        const ux = dx / len, uy = dy / len;
        const place = (d: number, half: number, kind: string) =>
            tick(a.x + ux * d, a.y + uy * d, ux, uy, half, kind);

        // Divide the leg into N EQUAL parts — N a multiple of 4, so 1/4, 1/2, 3/4
        // are ALWAYS exact division points. Every tick (gold centre, quarter marks,
        // fine graduations) is therefore locked to the leg's proportions: they're
        // perfectly symmetric and NEVER drift against each other. Density just
        // grows with leg length (≈ SPACING_PX apart), like adding finer ruler lines.
        let n = Math.round(len / SPACING_PX);
        n = Math.max(4, Math.round(n / 4) * 4);
        for (let k = 1; k < n; k++) {
            const d = (k / n) * len;
            if (d < END_MARGIN || d > len - END_MARGIN) continue;
            if (k === n / 2) place(d, GOLD_PX, "half");
            else if (k === n / 4 || k === (3 * n) / 4) place(d, QUARTER_PX, "quarter");
            else place(d, MINOR_PX, "minor");
        }
    }
    return { type: "FeatureCollection", features };
}

// Vertices with the moving polygon vertex (if any) substituted at its live spot.
function liveVerts(): Lnglat[] {
    if (isPolygon && moveIndex !== null && cursor) {
        const v = [...verts];
        v[moveIndex] = cursor;
        return v;
    }
    return verts;
}
// committed vertices + the live tip; the tip grows off whichever END was grabbed.
// For a closed polygon there's no growing tip — the geometry is liveVerts().
function points(): Lnglat[] {
    if (isPolygon) return liveVerts();
    if (!cursor) return [...verts];
    return dragFromHead ? [cursor, ...verts] : [...verts, cursor];
}

function render() {
    if (!map) return;
    ensureLayers();
    const pts = points();
    const ring: Lnglat[] =
        isPolygon && pts.length >= 3 ? [...pts, pts[0]] : pts;
    setData(MEASURE_LINE_SRC, {
        type: "FeatureCollection",
        features: ring.length >= 2
            ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } }]
            : [],
    });
    setData(MEASURE_TICKS_SRC, buildTicksFC(ring));
    // Line mode: nodes = committed vertices (the live tip isn't a node). Polygon:
    // every vertex is a draggable node, shown live (the moving one follows cursor).
    setData(MEASURE_NODES_SRC, {
        type: "FeatureCollection",
        features: (isPolygon ? pts : verts).map((c) => ({
            type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c },
        })),
    });
    // Fill the body as soon as there are 3+ nodes — even while OPEN (not yet
    // snapped closed). We auto-close the RING for the fill geometry only (no line
    // drawn across the open side, per the design): the translucent body implies
    // the closure and lets the ≈ area read live. Once snapped (`isPolygon`) the
    // visible closing edge is the line layer; the fill is identical either way.
    setData(MEASURE_FILL_SRC, {
        type: "FeatureCollection",
        features: pts.length >= 3
            ? [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } }]
            : [],
    });
    // Rust centre dot: on a polygon EVERY vertex is draggable → dot them all (the
    // visual cue). On a line, just the two free ENDS.
    const endPts: Lnglat[] = isPolygon
        ? pts
        : pts.length >= 2
          ? [pts[0], pts[pts.length - 1]]
          : pts.length === 1
            ? [pts[0]]
            : [];
    setData(MEASURE_ENDDOTS_SRC, {
        type: "FeatureCollection",
        features: endPts.map((c) => ({
            type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c },
        })),
    });
    renderLegs();
    updateEndCursors();
}

function clearAll() {
    cursor = null;
    isPolygon = false;
    moveIndex = null;
    copied = false;
    copyFailed = false;
    document.body.classList.remove("rt-snake-grabbing"); // safety: never leave the drag cursor stuck
    if (copiedTimer) clearTimeout(copiedTimer);
    setData(MEASURE_LINE_SRC, { type: "FeatureCollection", features: [] });
    setData(MEASURE_TICKS_SRC, { type: "FeatureCollection", features: [] });
    setData(MEASURE_NODES_SRC, { type: "FeatureCollection", features: [] });
    setData(MEASURE_FILL_SRC, { type: "FeatureCollection", features: [] });
    setData(MEASURE_ENDDOTS_SRC, { type: "FeatureCollection", features: [] });
    clearLegs();
    headCursor?.remove();
    headCursor = null;
    tailCursor?.remove();
    tailCursor = null;
}

// ── End cursors — a small hand reaching up to GRAB each free end ──────────
// HEAD (vertex 0, dropped FIRST, on the LEFT) = LEFT hand.
// TAIL (last vertex, on the RIGHT as you drag left→right) = RIGHT hand.
const HEAD_CURSOR = {
    src: handShovelCursor,
    w: 47, // ← LEFT hand size (set so rendered height ≈ TAIL's ~64px)
    offset: [16, -2] as [number, number], // ← LEFT hand fingertip nudge [x,y]
};
const TAIL_CURSOR = {
    src: handShovelCursorRight,
    w: 28, // ← RIGHT hand size
    offset: [4, -2] as [number, number], // ← RIGHT hand fingertip nudge [x,y]
};
let headCursor: mapboxgl.Marker | null = null;
let tailCursor: mapboxgl.Marker | null = null;
function makeEndCursorEl(src: string, w: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "rt-measure-grab";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.draggable = false;
    img.style.width = `${w}px`;
    el.appendChild(img);
    return el;
}
// The whole hand is a drag handle. move/up listeners live on WINDOW (not the
// sprite) so the gesture survives the sprite being removed mid-drag — which
// happens the instant it snaps to a polygon, letting you drag in/out without
// lifting.
function wireHandDrag(el: HTMLElement, which: "head" | "tail") {
    let moved = false;
    // GRAB OFFSET (screen px): the gap between the node and the pointer at grab
    // time. Applied on every move so the node DOESN'T jump to the cursor — you grab
    // the hand where it is and it pulls the bullseye along, keeping that gap.
    let grabDX = 0;
    let grabDY = 0;
    // Keep the layout's fake DOM cursor parked at the live pointer DURING the drag.
    // It's hidden while the native override shows, but `preventDefault` blocks the
    // `mousemove` that normally moves it — so without this it stays frozen where the
    // drag started and, when the override lifts on release, the cursor visibly snaps
    // back there. Pointer events still fire, so sync it from them (mouse only). 11,5
    // = FAKE_CURSOR_HOTSPOT.
    let fakeCursor: HTMLElement | null = null;
    const syncFakeCursor = (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        fakeCursor ??= document.querySelector<HTMLElement>(".fake-cursor");
        if (fakeCursor) {
            fakeCursor.style.transform = `translate3d(${e.clientX - 11}px, ${e.clientY - 5}px, 0)`;
        }
    };
    const toLngLat = (e: PointerEvent): Lnglat => {
        const r = map!.getCanvas().getBoundingClientRect();
        const p = map!.unproject([e.clientX - r.left + grabDX, e.clientY - r.top + grabDY]);
        return [p.lng, p.lat];
    };
    // rAF-throttle the re-render: a pointermove only stores the latest point; one
    // hover()/render() runs per animation frame. This keeps the per-event handler
    // cheap so the app's (JS-driven) hand cursor never janks / "gets left behind"
    // under the heavy ruler re-render — no native-cursor override needed.
    let raf = 0;
    let pendingLL: Lnglat | null = null;
    const flush = () => {
        raf = 0;
        if (!pendingLL || !map) return;
        const [lng, lat] = pendingLL;
        hover(lng, lat);
    };
    const onMove = (e: PointerEvent) => {
        if (!map) return;
        moved = true;
        syncFakeCursor(e);
        pendingLL = toLngLat(e);
        if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = (e: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        pendingLL = null;
        syncFakeCursor(e); // park the fake cursor at the release point BEFORE it un-hides
        document.body.classList.remove("rt-snake-grabbing"); // hand back the cursor
        if (map) map.dragPan.enable();
        if (moved && map) {
            const [lng, lat] = toLngLat(e);
            commitAt(lng, lat);
        } else {
            cursor = null;
            isPolygon = false;
            render();
        }
        moved = false;
    };
    el.addEventListener("pointerdown", (e: PointerEvent) => {
        if (!active || !map) return;
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        dragFromHead = which === "head";
        dragAnchor = which === "head" ? verts[0] : verts[verts.length - 1];
        // Record the grab offset (node position minus pointer position, screen px)
        // so the bullseye doesn't snap to the cursor — it trails the hand by the gap.
        {
            const r0 = map.getCanvas().getBoundingClientRect();
            const ns = map.project({ lng: dragAnchor[0], lat: dragAnchor[1] });
            grabDX = ns.x - (e.clientX - r0.left);
            grabDY = ns.y - (e.clientY - r0.top);
        }
        onMeasureDrag?.();
        map.dragPan.disable();
        // Force the app's OWN hand as a NATIVE cursor for the whole drag (dt-web).
        // preventDefault on this pointerdown suppresses the compat `mousemove` the
        // fake DOM cursor follows, so it freezes ("left behind") and — with the
        // global `cursor:none` — the pointer looks invisible. A native `url()`
        // cursor is composited (never lags) and IS the user's hand; hide the fake
        // one so there's a single hand. Cleared on release.
        // The cursor image now comes from the shared-assets IMPORT, so the CSS
        // cannot name a static path any more — it reads --rt-grab-cursor, and
        // the var has to live on <body> because that is where the class goes.
        // The var carries the whole url() token: `url(var(--x))` is invalid CSS.
        document.body.style.setProperty(
            "--rt-grab-cursor",
            `url(${handShovelCursor100})`,
        );
        document.body.classList.add("rt-snake-grabbing");
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    });
}
function updateEndCursors() {
    if (!map) return;
    const pts = points();
    // Hands on the double-tap ruler + the LINE tool; never on PIN (a lone point)
    // or POLYGON (handled via !isPolygon — its corners are tapped, not dragged).
    const show = active && !isPolygon && pts.length >= 1 && armed !== "pin";
    if (!show) {
        headCursor?.remove();
        headCursor = null;
        tailCursor?.remove();
        tailCursor = null;
        return;
    }
    const head = pts[0];
    const tail = pts[pts.length - 1];
    if (!headCursor) {
        const el = makeEndCursorEl(HEAD_CURSOR.src, HEAD_CURSOR.w);
        headCursor = new (markerCtor(map))({ element: el, anchor: "top", offset: HEAD_CURSOR.offset })
            .setLngLat(head).addTo(map);
        wireHandDrag(el, "head");
    } else {
        headCursor.setLngLat(head);
    }
    if (pts.length >= 2) {
        if (!tailCursor) {
            const el = makeEndCursorEl(TAIL_CURSOR.src, TAIL_CURSOR.w);
            tailCursor = new (markerCtor(map))({ element: el, anchor: "top", offset: TAIL_CURSOR.offset })
                .setLngLat(tail).addTo(map);
            wireHandDrag(el, "tail");
        } else {
            tailCursor.setLngLat(tail);
        }
    } else {
        tailCursor?.remove();
        tailCursor = null;
    }
}

// ── Readouts ──────────────────────────────────────────────────────────────
// formatHectares / formatMeasureDist now live in ../measureFormat (shared with the
// line/polygon draw tool so totals + subtotals round identically across both).
let legMarkers: mapboxgl.Marker[] = [];
function clearLegs() {
    for (const m of legMarkers) m.remove();
    legMarkers = [];
}
// A subtle "leg of the journey" readout. `offset` is a screen-px nudge off the
// band (screen-constant — no zoom scaling), so the line + gold centre stay clear.
function addLeg(lngLat: Lnglat, text: string, offset: [number, number]) {
    if (!map) return;
    const el = document.createElement("div");
    el.className = "rt-line-label rt-line-label-leg";
    el.textContent = text;
    legMarkers.push(
        new (markerCtor(map))({ element: el, anchor: "center", offset }).setLngLat(lngLat).addTo(map),
    );
}
// The final position of every leg label: a geo point toward the leg's END plus a
// perpendicular SCREEN offset (upper side, so it sits above the band). Shared by
// renderLegs (places the markers) and popAnchor (floats the chrome ABOVE them).
function legLabelAnchors(): Array<{ geo: Lnglat; off: [number, number] }> {
    if (!map) return [];
    const pts = points();
    const ring = isPolygon && pts.length >= 3 ? [...pts, pts[0]] : pts;
    if (ring.length < (isPolygon ? 4 : 3)) return [];
    const out: Array<{ geo: Lnglat; off: [number, number] }> = [];
    for (let i = 0; i < ring.length - 1; i++) {
        const geo: Lnglat = [
            ring[i][0] + (ring[i + 1][0] - ring[i][0]) * LEG_LABEL_FRAC,
            ring[i][1] + (ring[i + 1][1] - ring[i][1]) * LEG_LABEL_FRAC,
        ];
        const a = map.project({ lng: ring[i][0], lat: ring[i][1] });
        const b = map.project({ lng: ring[i + 1][0], lat: ring[i + 1][1] });
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        let px = -dy / len, py = dx / len; // perpendicular unit
        if (py > 0) { px = -px; py = -py; } // choose the upper side
        out.push({ geo, off: [px * LEG_LABEL_OFF, py * LEG_LABEL_OFF] });
    }
    return out;
}
function renderLegs() {
    clearLegs();
    if (!map) return;
    const pts = points();
    // Polygon: label EVERY side (the closed ring, incl. the closing edge). Line:
    // label each leg, but only when there's more than one (a single leg's
    // distance IS the total → noise).
    const ring = isPolygon && pts.length >= 3 ? [...pts, pts[0]] : pts;
    if (ring.length < (isPolygon ? 4 : 3)) return;
    const anchors = legLabelAnchors();
    for (let i = 0; i < ring.length - 1; i++) {
        const segKm = turfLength({
            type: "Feature", properties: {},
            geometry: { type: "LineString", coordinates: [ring[i], ring[i + 1]] },
        });
        if (anchors[i]) addLeg(anchors[i].geo, formatMeasureDist(segKm), anchors[i].off);
    }
}

// ── Interaction ─────────────────────────────────────────────────────────
// Snaps the tip onto the FAR end → polygon preview, with hysteresis: snaps IN
// within MEASURE_SNAP_PX but only un-snaps past MEASURE_UNSNAP_PX, so a wobble
// on release can't accidentally un-polygon it.
function hover(lng: number, lat: number) {
    if (!active) return;
    if (map && verts.length >= 3) {
        const anchorIdx = dragFromHead ? verts.length - 1 : 0;
        const anchor = verts[anchorIdx];
        const f = map.project({ lng: anchor[0], lat: anchor[1] });
        const p = map.project({ lng, lat });
        const d2 = (f.x - p.x) ** 2 + (f.y - p.y) ** 2;
        const threshold = isPolygon ? MEASURE_UNSNAP_PX : MEASURE_SNAP_PX;
        if (d2 < threshold ** 2) {
            isPolygon = true;
            cursor = anchor; // lock the tip onto the far end
            render();
            return;
        }
    }
    isPolygon = false;
    cursor = [lng, lat];
    render();
}
// Release → drop a node on the same end the drag pulled from (or keep the
// polygon-closed state for Save).
function commitAt(lng: number, lat: number) {
    if (!active) return;
    if (isPolygon) {
        cursor = null;
        render();
        return;
    }
    // Snap-back: if you release CLOSE to the end you grabbed, you decided not to
    // drag — so snap it back to itself and add NO node (no tiny trailing stub).
    // You don't have to land on the exact start pixel; within MEASURE_SNAP_PX cancels.
    if (dragAnchor && map) {
        const a = map.project({ lng: dragAnchor[0], lat: dragAnchor[1] });
        const p = map.project({ lng, lat });
        if ((a.x - p.x) ** 2 + (a.y - p.y) ** 2 < MEASURE_SNAP_PX ** 2) {
            cursor = null;
            render();
            return;
        }
    }
    verts = dragFromHead ? [[lng, lat], ...verts] : [...verts, [lng, lat]];
    seedAtSelf = false; // it's a ruler/line now, not a plot-on-self
    cursor = null;
    render();
}

// If the double-tap seed landed within SELF_SNAP_PX of the user's blue dot,
// snap the node EXACTLY onto the dot and report it as self. Pixel-space test
// (project both, compare on screen) so the tolerance is constant regardless of
// zoom — a finger-width forgiveness, not a geographic distance.
function snapSeedToSelf(seed: Lnglat): { seed: Lnglat; atSelf: boolean } {
    const uc = userCoord?.();
    if (!uc || !map) return { seed, atSelf: false };
    const a = map.project({ lng: seed[0], lat: seed[1] });
    const b = map.project({ lng: uc[0], lat: uc[1] });
    if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= SELF_SNAP_PX ** 2) {
        return { seed: [uc[0], uc[1]], atSelf: true };
    }
    return { seed, atSelf: false };
}

function start(seed?: Lnglat) {
    active = true;
    armed = null; // double-tap entry → hands mode, not a palette tool
    cursor = null;
    isPolygon = false;
    let atSelf = false;
    if (seed) {
        const snapped = snapSeedToSelf(seed);
        seed = snapped.seed; // exact blue-dot coord when it snapped
        atSelf = snapped.atSelf;
    }
    seedAtSelf = atSelf;
    verts = seed ? [seed] : [];
    onActivate?.();
    ensureLayers();
    render();
    if (atSelf) onSnapSelf?.(); // pulse the blue dot — "got you, placing on you"
}
// Palette entry: arm the ruler in a tap-to-build mode (pin / line / polygon).
// No seed yet — the first map tap places the first node (see the click handler).
function startArmed(kind: "line" | "polygon" | "pin") {
    active = true;
    armed = kind;
    cursor = null;
    moveIndex = null;
    isPolygon = false; // polygon flips true once it has ≥3 corners
    seedAtSelf = false; // palette tools don't snap-to-self (no double-tap seed)
    verts = [];
    onActivate?.();
    ensureLayers();
    render();
}
function discard() {
    active = false;
    armed = null;
    seedAtSelf = false;
    gridSnapDot = null;
    setGridGlow?.(null); // kill the snap glow when leaving plot mode
    clearAll();
    verts = [];
}
// performance.now() of the last commit — the seed guard below swallows a
// double-tap seed that arrives right after (a fast final click-to-commit reads
// as a dblclick, and the host would seed a brand-new ruler over the fresh
// feature's popover).
let lastCommitAt = 0;
function persist(share: boolean, format?: MapShareFormat) {
    if (!canFinish) return;
    lastCommitAt = performance.now();
    const kind: "line" | "polygon" = isPolygon ? "polygon" : "line";
    // Deep-copy to PLAIN arrays: `verts` holds Svelte `$state` proxy coords, and
    // a shallow [...verts] would still hand the proxies across — which later
    // breaks structuredClone in the store ("[object Array] could not be cloned").
    const out: Lnglat[] = verts.map((c) => [c[0], c[1]]);
    onPersist(kind, out, share, format);
    discard();
}

// Share is a format PICK, not a one-shot: the same .getcache / .kmz menu as
// the feature popover's share button. Selecting a format saves AND shares in
// one tap — the run stays synchronous so navigator.share keeps the click's
// user activation.
const shareFormats: ShareFormat[] = [
    { ext: "getcache", run: () => persist(true, "getcache") },
    { ext: "kmz", run: () => persist(true, "kmz") },
];
// Palette UNDO: drop the last-placed corner (stays armed + empty at zero, so you
// can keep tapping). Exposed to the host via bind:this.
export function undoLast() {
    if (!active || verts.length === 0) return;
    verts = verts.slice(0, -1);
    if (verts.length < 3) isPolygon = false; // reopened below a polygon
    cursor = null;
    moveIndex = null;
    render();
}
// Whether the ruler currently owns the map (any entry mode). The host gates
// its map-click feature hit-test on this so a mid-measure tap places a node
// instead of popping a feature editor. Exposed via bind:this.
export function isMeasuring(): boolean {
    return active;
}

// ── Consume the double-tap seed from the host ────────────────────────────
$effect(() => {
    const ev = measureEvent;
    if (!ev) return;
    measureEvent = null; // consume
    if (armed) return; // a palette tool is active → ignore double-tap seeding
    // A fast final click-to-commit can read as a dblclick → the host fires a
    // seed right after the commit landed. Swallow it: the user just FINISHED a
    // measurement; don't tear down their fresh feature popover with a new seed.
    if (performance.now() - lastCommitAt < 600) return;
    start([ev.lng, ev.lat]);
});

// ── Palette arm: choose a tool → arm the ruler; clear it → discard. ───────
$effect(() => {
    const k = armKind;
    if (k && armed !== k) startArmed(k);
    else if (!k && armed) discard();
});

// ── Tap-to-build: each map click places geometry. ──────────────────────────
//   pin     → the tap DROPS the pin right there (host opens its editor)
//   line    → first tap drops ONE bullseye; after that the hands extend it
//   polygon → every tap adds a corner of the always-closed snake polygon
//   (hands) → CLICK-TO-PLACE, the standard mode after a double-tap/long-press
//             seed: each tap appends a node; tap the LAST node to commit; tap
//             the FIRST (3+ nodes) to close into a polygon. Dragging the
//             hands/nodes still works alongside.
$effect(() => {
    const m = map;
    if (!m) return;
    const onClick = (e: mapboxgl.MapMouseEvent) => {
        if (!active) return;
        const pt: Lnglat = [e.lngLat.lng, e.lngLat.lat];
        // Screen-px proximity to an existing node (constant regardless of zoom).
        const nearIdx = verts.findIndex((v) => {
            const q = m.project({ lng: v[0], lat: v[1] });
            return (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2 < FINISH_TAP_PX ** 2;
        });
        if (armed === "pin") {
            // Drop the pin RIGHT HERE — the PIN tool never detours through the
            // ruler's measure popover. Deferred a microtask so the host's own
            // map-click handler (running in this same dispatch) can't see —
            // and instantly clear — the fresh pin's selection.
            const [lng, lat] = pt;
            queueMicrotask(() => {
                onSavePoint?.(lng, lat);
                discard();
            });
        } else if (armed === "line") {
            if (verts.length === 0) {
                verts = [pt];
                render();
            } // further extension is via the hands
        } else if (armed === "polygon") {
            // ignore a tap that lands on an existing corner (that's a grab)
            if (nearIdx !== -1) return;
            verts = [...verts, pt];
            isPolygon = verts.length >= 3; // closed once it's a real polygon
            render();
        } else {
            // HANDS MODE (double-tap / long-press entry) — CLICK-TO-PLACE. The
            // seed's own release-click is swallowed by doubleTapToPin, so the
            // first click that lands here is a deliberate second tap.
            if (isPolygon) return; // closed: corners are drag-to-reshape only
            if (nearIdx === verts.length - 1 && canFinish) {
                // Tap the LAST node again → commit (same as Save). Deferred a
                // microtask, like the pin drop above: this component's click
                // handler registers BEFORE the host's (child effects run
                // first), so a synchronous select here would be read by the
                // host's same-dispatch click handler as "popover open, outside
                // tap" — and instantly deselected.
                queueMicrotask(() => persist(false));
                return;
            }
            if (nearIdx === 0 && verts.length >= 3) {
                isPolygon = true; // tap the FIRST node → snap closed; Save commits
                cursor = null;
                render();
                return;
            }
            if (nearIdx !== -1) return; // a middle node (or the lone seed) = a grab
            verts = [...verts, pt];
            seedAtSelf = false; // it's a ruler now, not a plot-on-self
            cursor = null;
            render();
        }
    };
    m.on("click", onClick);
    return () => m.off("click", onClick);
});

// Once it's a real snake (2+ nodes) the double-tap "Drop a pin" card is stale.
$effect(() => {
    if (active && verts.length >= 2) onMeasureDrag?.();
});

// ── GL node grab (the gold ring / fat halo; the hands cover the rest) ─────
$effect(() => {
    const m = map;
    if (!m) return;
    let dragging = false;
    let moved = false;
    const down = (e: mapboxgl.MapLayerMouseEvent | mapboxgl.MapLayerTouchEvent) => {
        if (!active || verts.length === 0) return;
        let nearest = -1;
        let nearestD = Number.POSITIVE_INFINITY;
        for (let i = 0; i < verts.length; i++) {
            const q = m.project({ lng: verts[i][0], lat: verts[i][1] });
            const d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2;
            if (d < nearestD) { nearestD = d; nearest = i; }
        }
        if (isPolygon) {
            // RESHAPE: any vertex is draggable; the polygon stays closed.
            moveIndex = nearest;
        } else {
            // LINE: only the two ENDS extend; middle nodes are fixed (map pans).
            const isHead = nearest === 0;
            const isTail = nearest === verts.length - 1;
            if (!isHead && !isTail) return;
            dragFromHead = isHead && !isTail;
            dragAnchor = verts[nearest];
            moveIndex = null;
            onMeasureDrag?.();
        }
        e.preventDefault();
        dragging = true;
        moved = false;
        m.dragPan.disable();
    };
    const move = (e: { lngLat: { lng: number; lat: number } }) => {
        if (!dragging) return;
        moved = true;
        if (moveIndex !== null) {
            cursor = [e.lngLat.lng, e.lngLat.lat]; // reshape preview
            render();
        } else {
            hover(e.lngLat.lng, e.lngLat.lat);
        }
    };
    const up = (e: { lngLat: { lng: number; lat: number } }) => {
        if (!dragging) return;
        dragging = false;
        m.dragPan.enable();
        if (moveIndex !== null) {
            // Commit the moved polygon vertex (stays a polygon).
            if (moved) {
                const v = [...verts];
                v[moveIndex] = [e.lngLat.lng, e.lngLat.lat];
                verts = v;
            }
            moveIndex = null;
            cursor = null;
            render();
        } else if (moved) {
            commitAt(e.lngLat.lng, e.lngLat.lat);
        } else {
            cursor = null;
            render();
        }
        moved = false;
    };
    m.on("mousedown", "measure-nodes-halo", down);
    m.on("touchstart", "measure-nodes-halo", down);
    m.on("mousedown", "measure-nodes", down);
    m.on("touchstart", "measure-nodes", down);
    m.on("mousemove", move);
    m.on("touchmove", move);
    m.on("mouseup", up);
    m.on("touchend", up);
    return () => {
        m.off("mousedown", "measure-nodes-halo", down);
        m.off("touchstart", "measure-nodes-halo", down);
        m.off("mousedown", "measure-nodes", down);
        m.off("touchstart", "measure-nodes", down);
        m.off("mousemove", move);
        m.off("touchmove", move);
        m.off("mouseup", up);
        m.off("touchend", up);
    };
});

// Chrome placement constants — how the readout + popover dodge the geometry AND
// the viewport edges (same idea as the snake's end jumping out of the way).
const CHROME_STACK_PX = 150; // room the popover stack needs beyond the anchor (offset + height)
const HAND_DROP_PX = 44; // hands hang below the end nodes — clear them when placing BELOW
const VP_MARGIN = 14; // keep the chrome at least this far from any viewport edge
const OFFSCREEN_HIDE = 40; // object fully off ANY edge by more than this → hide the chrome
const POP_HALF_W = 85; // ~half the Save/Share popover width (for the horizontal clamp)
const POP_GRID_W = 160; // FIXED single-point 2×2 grid width — must match .measure-grid CSS; sized to the GPS readout pill below it
const POP_EDGE_PX = 5; // the popover may run this close to the side edges (tighter than VP_MARGIN)
const TOTAL_HALF_W = 72; // ~half the total pill width
// The painted box vs the anchor point: CSS translates BOTH chrome elements off
// `y` (see .measure-pop / .measure-total transforms), so a collision test on the
// raw anchor tests the wrong rectangle. These are the measured painted sizes.
// The coord pill sits ABOVE the popover when placed above (both hang off the
// same anchor at different offsets), so the stack spans from the pill's top to
// the popover's bottom — treat it as ONE box or the pill dodges alone.
const POP_OFFSET_PX = 52; // .measure-pop translate from the anchor
const TOTAL_OFFSET_PX = 16; // .measure-total translate from the anchor
const POP_H = 78; // measured painted height of the 2×2 grid popover

// ── Chrome anchor + placement. Default: ABOVE the bounding box of nodes AND leg
// labels (clear of every node, hand and label). If "above" would clip off the TOP
// of the viewport, FLIP the stack BELOW the snake; clamp x off the side edges. If
// neither above nor below fits (snake fills the screen) → `cornered`, and an effect
// pans the map to open room. `totalX` is nudged toward the tail so the big total
// doesn't read as the centre marker. ─────
let popAnchor = $derived.by(() => {
    if (!map || !active) return null;
    void mapMoveSeq;
    const pts = points();
    if (pts.length < 1) return null;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY; // topmost = smallest screen y
    let maxY = Number.NEGATIVE_INFINITY; // bottommost = largest screen y
    for (const c of pts) {
        const p = map.project({ lng: c[0], lat: c[1] });
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    // Float clear of the leg labels too (their top + bottom edges).
    for (const { geo, off } of legLabelAnchors()) {
        const p = map.project({ lng: geo[0], lat: geo[1] });
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.y + off[1] - LABEL_HALF_H < minY) minY = p.y + off[1] - LABEL_HALF_H;
        if (p.y + off[1] + LABEL_HALF_H > maxY) maxY = p.y + off[1] + LABEL_HALF_H;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    const cx = (minX + maxX) / 2;
    const tp = map.project({ lng: pts[pts.length - 1][0], lat: pts[pts.length - 1][1] });
    const tailX = Number.isFinite(tp.x) ? tp.x : cx;

    const W = map.getCanvas().clientWidth;
    const H = map.getCanvas().clientHeight;
    // Object fully off-screen (past ANY edge by > OFFSCREEN_HIDE) → hide the chrome,
    // so a stray pill never floats on the map with its object panned out of view.
    // (Without this the horizontal clamp would keep the pills pinned to the side.)
    if (
        maxX < -OFFSCREEN_HIDE ||
        minX > W + OFFSCREEN_HIDE ||
        maxY < -OFFSCREEN_HIDE ||
        minY > H + OFFSCREEN_HIDE
    ) {
        return null;
    }
    // Prefer ABOVE; flip BELOW only if above clips the top AND below has room.
    const fitsAbove = minY - CHROME_STACK_PX >= VP_MARGIN;
    const belowY = maxY + HAND_DROP_PX;
    const fitsBelow = belowY + CHROME_STACK_PX <= H - VP_MARGIN;
    const below = !fitsAbove && fitsBelow;
    const cornered = !fitsAbove && !fitsBelow;
    const y = below ? belowY : minY;
    const clampX = (x: number, half: number, edge: number) =>
        Math.min(Math.max(x, edge + half), W - edge - half);
    // Single point: the 2×2 grid is FIXED-width (POP_GRID_W) and may run right up
    // to POP_EDGE_PX from the side; the coord pill stays centred UNDER it so the
    // pair slides to the edge together, symmetrical. Multi-point keeps the
    // tail-biased total with its own clamp.
    const popHalf = singlePoint ? POP_GRID_W / 2 : POP_HALF_W;
    let popX = clampX(cx, popHalf, POP_EDGE_PX);

    // ── Dodge the map's floating chrome (eye toggle + crow switch, top-right).
    // Staying inside the canvas is not enough: those buttons are PAINTED ON the
    // canvas at z-index 40, above this popover, so "fits on screen" still lands
    // it underneath them. The chrome column is just another edge to flip off.
    //
    // SIDEWAYS BEATS UPWARD. Moving up AND left at once reads as a diagonal
    // leap and lands the buttons far from the finger that summoned them. So try
    // to solve it on the horizontal axis alone, at the height the popover would
    // naturally sit — straight left, still beside the touch point. Only if no
    // clear x exists on that row do we fall back to lifting it.
    //
    // ONE box spanning the pill AND the popover: they share `y` and must stay
    // visually joined, so they dodge together or not at all.
    const popW = popHalf * 2;
    const rects = mapKeepOutRects(W, undefined, map.getCanvas());
    const minPopX = POP_EDGE_PX;
    const maxPopX = W - POP_EDGE_PX - popW;
    const stackBox = (atY: number, isBelow: boolean): Rect => ({
        x: popX - popHalf,
        y: isBelow ? atY + TOTAL_OFFSET_PX : atY - POP_OFFSET_PX - POP_H,
        w: popW,
        h: POP_OFFSET_PX + POP_H - TOTAL_OFFSET_PX,
    });
    const shifted = shiftClear(stackBox(y, below), rects, minPopX, maxPopX);
    // null = nowhere clear beside the chrome on this row (narrow screen). Keep
    // the clamped x rather than teleporting the popover away from its snake;
    // the vertical placement already chosen above stays as the fallback.
    if (shifted !== null) popX = shifted + popHalf;

    // Did the dodge actually move us? A sideways dodge of a 160px popover past
    // a chrome column this wide is always a big jump (~124px on a 452px canvas
    // — there is no smaller move that clears it). Pairing that with the usual
    // upward lift reads as a diagonal leap away from the finger. Once we are
    // clear SIDEWAYS the lift has nothing left to avoid, so drop it and sit
    // level with the touch point: straight left, not up-and-left.
    const dodgedSideways =
        shifted !== null && Math.abs(shifted + popHalf - clampX(cx, popHalf, POP_EDGE_PX)) > 1;
    // Level with the snake's vertical centre, +52px to undo .measure-pop's
    // upward translate — so the popover's own centre lands on the touch point.
    const levelY = dodgedSideways ? (minY + maxY) / 2 + POP_OFFSET_PX + POP_H / 2 : y;

    return {
        popX,
        totalX: singlePoint
            ? popX
            : clampX(cx + (tailX - cx) * TOTAL_TAIL_BIAS, TOTAL_HALF_W, VP_MARGIN),
        y: levelY,
        below,
        cornered,
        minY,
    };
});

// Cornered (snake taller than the viewport) → pan the map DOWN so the chrome fits
// above. One easeTo per cornered state; isEasing() guards against re-triggering
// mid-animation, and once panned `fitsAbove` flips true so it stops. ("Move the
// page to find more space.")
$effect(() => {
    if (!map || !active) return;
    const a = popAnchor;
    if (!a?.cornered) return;
    const shortfall = VP_MARGIN + CHROME_STACK_PX - a.minY;
    if (shortfall > 4 && !map.isEasing()) {
        map.panBy([0, shortfall], { duration: 220 });
    }
});

let totalText = $derived.by(() => {
    if (!active) return null;
    const pts = points();
    // AREA — shown the moment there are 3+ nodes, whether the snake is snapped
    // closed (`isPolygon`) or still OPEN. We auto-close the ring (last→first) so
    // an open snake reports the same area its translucent fill covers. Open reads
    // "≈ X ha" (an estimate while drawing); snapped-closed reads a plain "X ha".
    // points() substitutes the dragged corner, so it recalculates as you reshape.
    if (pts.length >= 3) {
        const ring: Lnglat[] = [...pts, pts[0]];
        const poly: Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
        const ha = formatHectares((area(poly) || 0) / 10000);
        return isPolygon ? ha : `≈ ${ha}`;
    }
    if (pts.length < 1) return null;
    // A lone point shows its GPS coords (not a distance), rounded to 3 dp for a
    // calm readout — Copy still grabs the full 5 dp precision (see sharePoint).
    if (pts.length === 1) return `${pts[0][1].toFixed(3)}°, ${pts[0][0].toFixed(3)}°`;
    const km = turfLength({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    return formatMeasureDist(km);
});

// Single-point Share: copy the GPS to the clipboard, flash "Copied!" in place of
// the Share button — no pin save needed to share one point. The flash only fires
// when the write actually landed; a blocked clipboard flashes "Couldn't copy".
async function sharePoint() {
    const p = verts[0];
    if (!p) return;
    const text = `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
    const ok = await copyToClipboard(text);
    copied = ok;
    copyFailed = !ok;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
        copied = false;
        copyFailed = false;
    }, 1600);
}
function savePoint() {
    const p = verts[0];
    if (!p) return;
    onSavePoint?.(p[0], p[1]);
    discard();
}
// "Plot" — throw a Quality 704 plot at this point (geo-referenced to it).
// Passes `seedAtSelf` so the host stamps proof-of-presence when the node snapped
// onto the user's own blue dot (the only place that provenance can be earned).
function dropPlot() {
    const p = verts[0];
    if (!p) return;
    // SNAP-TO-GRID wins over the raw seed position (but snap-to-self wins over
    // both — a plot ON YOU keeps proof-of-presence and ignores the grid). When
    // a grid dot is glowing, the plot lands exactly on it + carries its Plus
    // Code; otherwise it drops free at the seed with no code.
    const snap = seedAtSelf ? null : gridSnapDot;
    const lng = snap ? snap.lng : p[0];
    const lat = snap ? snap.lat : p[1];
    setGridGlow?.(null); // clear the glow as we commit
    onPlot?.(lng, lat, seedAtSelf, snap?.plusCode ?? null);
    discard();
}

// Recolour the node ring to the blue-dot blue while a seed is snapped to self,
// so the snapped node visibly belongs to "you" (vs the normal gold ring). Reverts
// to gold otherwise. Guarded on the layer existing (ensureLayers runs in start).
$effect(() => {
    if (!map || !map.getLayer("measure-nodes")) return;
    map.setPaintProperty(
        "measure-nodes",
        "circle-stroke-color",
        seedAtSelf ? "#1da1f2" : "#f5d565",
    );
});

// SNAP-TO-GRID heads-up. While a lone plot seed sits within the magnet radius
// of an audit-grid dot, glow that dot gold so the user SEES where the plot will
// land before committing. Snap-to-self overrides (a plot on you ignores the
// grid). Recomputes as the seed moves (verts) or the camera moves (mapMoveSeq,
// which can change which dots are even in the live grid). Clears the glow the
// moment we leave single-point mode.
$effect(() => {
    // Track deps explicitly so the effect re-runs on seed / camera change.
    const seed = singlePoint ? verts[0] : null;
    void mapMoveSeq;
    if (!gridSnap || !setGridGlow) return;
    if (!seed || seedAtSelf) {
        gridSnapDot = null;
        setGridGlow(null);
        return;
    }
    const dot = gridSnap(seed[0], seed[1]);
    gridSnapDot = dot;
    setGridGlow(dot);
});

// On every camera move: (1) bump mapMoveSeq so popAnchor re-projects, and (2)
// REBUILD the ticks. The ticks are baked into lng/lat from a screen-pixel step +
// length, so without rebuilding they'd scale GEOGRAPHICALLY on zoom (spreading /
// poking out of the casing) while the line + highlighter band stay screen-px
// constant. Rebuilding keeps the ticks screen-constant, matching the line.
$effect(() => {
    const m = map;
    if (!m) return;
    const onMove = () => {
        // ACTIVE CHECK FIRST. This fires on every frame of every pan, for the
        // whole life of the map, whether or not the ruler is in use — and
        // `mapMoveSeq` is a $state rune, so bumping it re-ran the two effects
        // that read it (popAnchor at :955, the grid-snap derived at :1160) on
        // every frame of an IDLE map. Both of those readers begin with
        // `if (!active) return null`, so every one of those re-runs was
        // guaranteed to do nothing. Bumping after the guard keeps the ruler
        // identical when it IS active and costs one boolean check when it
        // is not.
        if (!active) return;
        mapMoveSeq += 1;
        const pts = points();
        const ring: Lnglat[] =
            isPolygon && verts.length >= 3 ? [...verts, verts[0]] : pts;
        setData(MEASURE_TICKS_SRC, buildTicksFC(ring));
    };
    m.on("move", onMove);
    return () => m.off("move", onMove);
});
</script>

<!-- Running total / area — pinned just above the bounding box, clear of every
     node, hand and leg label. Glides while dragging. -->
{#if active && totalText && popAnchor}
    <div
        class="rt-line-label rt-line-label-total measure-total"
        class:measure-gliding={!!cursor}
        class:measure-below={popAnchor.below}
        style="left:{popAnchor.totalX}px; top:{popAnchor.y}px;"
    >{totalText}</div>
{/if}

<!-- Actions — stacked above the readout, also above the bounding box. A lone
     point gets the same popover: Save drops a pin, Share copies the GPS. -->
{#if active && popAnchor && (canFinish || singlePoint)}
    <div class="measure-pop" class:measure-grid={singlePoint} class:measure-at-self={singlePoint && seedAtSelf} class:measure-gliding={!!cursor} class:measure-below={popAnchor.below} style="left:{popAnchor.popX}px; top:{popAnchor.y}px;">
        {#if singlePoint}
            <!-- 2×2 grid: copy · ✕  /  save · plot. "Plot" throws a Quality 704
                 plot at this point — drop plots straight from the map. -->
            {#if seedAtSelf}
                <!-- Snapped onto the blue dot — a plot dropped from here is PROOF
                     the inspector was physically standing at the plot. Spans the
                     full grid width, above the four buttons. -->
                <div class="measure-self-badge">
                    <span class="measure-self-dot"></span>At your location
                </div>
            {/if}
            <button class="measure-btn measure-share" onclick={sharePoint} title="Copy GPS to clipboard">
                {#if copied}
                    ✓ Copied!
                {:else if copyFailed}
                    Couldn't copy
                {:else}
                    <Icon name="copy" size={13} style="flex-shrink:0" />
                    Copy
                {/if}
            </button>
            <button class="measure-btn measure-x" onclick={discard} title="Discard" aria-label="Discard measurement">&#x2715;</button>
            <button class="measure-btn measure-save" onclick={savePoint} title="Save pin">
                <img class="measure-pin-ic" src="/mobileAssets/pin_library_small/pin_default_sm.webp" alt="" />
                Save
            </button>
            <button class="measure-btn measure-plot" class:at-self={seedAtSelf} onclick={dropPlot} title={seedAtSelf ? "Drop a plot AT your location (proof you were here)" : "Drop a Quality 704 plot here"}>
                <img class="measure-plot-ic" src={iconPath("qualityWhite")} alt="" />
                Plot
            </button>
        {:else}
            <div class="measure-col">
                {#if !paletteMode}
                    <!-- side="below": the ruler popover hugs the top of the map,
                         so an upward menu overlaps the app header and reads as
                         "coming out of the top menu", not out of this button. -->
                    <SharePicker formats={shareFormats} side="below">
                        {#snippet trigger({ toggle })}
                            <button class="measure-btn measure-share" onclick={toggle} title="Save &amp; share">
                                <Icon name="upload" size={13} style="flex-shrink:0" />
                                Share
                            </button>
                        {/snippet}
                    </SharePicker>
                {/if}
                <button class="measure-btn measure-save" onclick={() => persist(false)} title="Save">
                    {#if isPolygon}
                        <Icon name="pentagon" size={13} style="flex-shrink:0" />
                    {:else}
                        <Icon name="share-nodes" size={13} style="flex-shrink:0" />
                    {/if}
                    Save
                </button>
            </div>
            <button class="measure-btn measure-x" onclick={discard} title="Discard" aria-label="Discard measurement">&#x2715;</button>
        {/if}
    </div>
{/if}

<style>
    /* Running-total readout — pinned just above the snake's bounding-box top.
       transition on left/top so it GLIDES as the snake reshapes. */
    /* z-index 16/17: BELOW the modules drawer (z 22) and its scrim (z 18) —
       same convention as the title/zoom chips in MapDrawControls. */
    .measure-total {
        position: absolute;
        transform: translate(-50%, calc(-100% - 16px));
        z-index: 16;
        pointer-events: none;
    }
    /* Flipped BELOW the snake (no room above) — hang downward from the anchor. */
    .measure-total.measure-below { transform: translate(-50%, 16px); }
    /* Glide only WHILE dragging (cursor live); during a map pan we want it to
       stick to the snake with no lag. */
    .measure-total.measure-gliding,
    .measure-pop.measure-gliding {
        transition: left 0.14s ease-out, top 0.14s ease-out;
    }

    /* Action popover — stacked above the readout, above the bounding-box top, so
       it never covers a node / hand / label. */
    .measure-pop {
        position: absolute;
        /* Intrinsic width — an abspos box near the right edge otherwise
           shrink-to-fits into the leftover space and squishes the buttons. */
        width: max-content;
        transform: translate(-50%, calc(-100% - 52px));
        z-index: 17;
        display: flex;
        align-items: stretch;
        gap: 0.25rem;
        padding: 0.25rem;
        background: rgba(20, 20, 20, 0.45); /* translucent — see the map through it */
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        border: 1px solid color-mix(in srgb, var(--color-accent), transparent 60%);
        border-radius: 10px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    }
    /* Flipped BELOW the snake (no room above) — hang downward from the anchor. */
    .measure-pop.measure-below { transform: translate(-50%, 52px); }

    /* Share/Save stacked, ✕ beside them. Outline buttons matching the Inbox
       toolbar style — gold Save (commit), terracotta Share + ✕ (context). */
    .measure-col {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .measure-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--rt-space-1, 0.25rem);
        padding: var(--rt-space-2, 0.35rem) var(--rt-space-3, 0.55rem);
        background: transparent;
        border: 1px solid currentColor;
        border-radius: var(--rt-radius-sm, 0.4rem);
        font-family: var(--rt-font-display);
        font-size: 0.74rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
        /* DARK WRITING SHADOW: the glass is translucent, so over a pale
           satellite frame the coloured labels (Copy especially) washed out.
           A tight dark drop + a soft dark halo keeps every label readable on
           ANY background without touching the label colours themselves. */
        text-shadow:
            0 1px 1px rgba(0, 0, 0, 0.95),
            0 0 3px rgba(0, 0, 0, 0.85),
            0 0 8px rgba(0, 0, 0, 0.5);
    }
    /* Same treatment for the icons (SVG + webp) riding beside the labels. */
    .measure-btn :global(svg),
    .measure-pin-ic,
    .measure-plot-ic {
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.9))
            drop-shadow(0 0 3px rgba(0, 0, 0, 0.6));
    }
    /* Both webp icons sized by HEIGHT (the pin art is much taller than wide,
       so a width cap let it inflate its button) — height caps keep every
       button in the 2×2 grid the same rectangle. */
    .measure-pin-ic { height: 24px; width: auto; flex-shrink: 0; display: block; }

    /* Single-point menu: a 2×2 grid — copy · ✕ (top) / save · plot (bottom).
       FIXED width — must match POP_GRID_W in the clamp code, so the horizontal
       clamp knows exactly where the edges land. Sized to read as one column
       with the GPS readout pill beneath it (~160px), not a wide slab. */
    .measure-pop.measure-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        width: 160px;
        gap: 0.25rem;
        align-items: stretch;
    }
    /* Tighter buttons inside the narrow grid — the column is ~74px, so shed
       the horizontal padding and let justify-content center the content.
       FIXED height + no vertical padding: four equal rectangles — the icons
       centre in the leftover space instead of padding stacking on top. */
    .measure-pop.measure-grid .measure-btn {
        padding: 0 0.2rem;
        height: 32px;
    }
    /* "Plot" — the small quality icon. The killer-feature button: drop a
       Quality 704 plot right where you tapped on the map. */
    .measure-plot-ic { height: 24px; width: auto; flex-shrink: 0; display: block; }

    /* Snap-to-self: a plot dropped from here is proof-of-presence. The badge
       spans the full grid width above the four buttons; the Plot button picks up
       a blue ring so the "you" action stands out from the gold/orange/white set.
       Blue (#1da1f2) matches the user-location dot it snapped onto. */
    .measure-self-badge {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.3rem;
        padding: 0.15rem 0.3rem 0.05rem;
        font-family: var(--rt-font-display);
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: #1da1f2;
        /* same dark writing shadow as the buttons — blue on glass washes out too */
        text-shadow:
            0 1px 1px rgba(0, 0, 0, 0.95),
            0 0 3px rgba(0, 0, 0, 0.85);
    }
    .measure-self-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #1da1f2;
        border: 1.5px solid var(--rt-fg);
        box-shadow: 0 0 0 2px rgba(29, 161, 242, 0.3);
        flex-shrink: 0;
    }
    .measure-plot.at-self {
        color: #1da1f2;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, #1da1f2 55%, transparent);
    }
    .measure-plot.at-self:active { background: color-mix(in srgb, #1da1f2 16%, transparent); }
    /* The SharePicker wrapper is inline-flex by default, which would shrink
       the Share button to its content — stretch it so Share fills the column
       exactly like its Save sibling. */
    .measure-col :global(.rt-sharepick) { display: flex; }
    .measure-col :global(.rt-sharepick .measure-btn) { flex: 1; }
    /* Copy = orange, Save = gold, Plot = white (trees), ✕ = GHOST grey —
       the ✕ is a dismiss (nothing saved is lost), and per the colour law a
       red X is a mixed signal: red belongs to the trash glyph only. */
    .measure-share { color: var(--color-accent-terracotta); }
    .measure-share:active { background: color-mix(in srgb, var(--color-accent-terracotta) 16%, transparent); }
    .measure-save { color: var(--color-accent); }
    .measure-save:active { background: color-mix(in srgb, var(--color-accent) 16%, transparent); }
    .measure-plot { color: #f2f2f2; }
    .measure-plot:active { background: color-mix(in srgb, #ffffff 14%, transparent); }
    .measure-x {
        align-self: stretch;
        font-size: 1rem;
        padding: 0 0.6rem;
        color: #b7bba6; /* ghost glyph grey — currentColor border follows */
    }
    .measure-x:active {
        background: rgba(255, 255, 255, 0.1);
        color: #edefe2;
    }

    /* The DOMINANT total/area readout now shares the draw tool's pill style
       (.rt-line-label-total in mobile.css) so the ruler and the line-draw tool read
       identically — only positioning (.measure-total) + number formatting stay local. */
    /* Hand cursor grabbing each free end — the WHOLE sprite is the drag handle. */
    :global(.rt-measure-grab) {
        pointer-events: auto;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
    }
    :global(.rt-measure-grab:active) { cursor: grabbing; }
    /* During a hand drag (dt-web): the app's OWN hand as a native cursor — composited
       so it never lags / "gets left behind" the way the JS fake cursor does once
       preventDefault kills mousemove. Hotspot 11,5 matches the fake cursor; hide the
       fake one so there's a single hand. `grabbing` is just a fallback. */
    :global(body.rt-snake-grabbing),
    :global(body.rt-snake-grabbing *) {
        cursor: var(--rt-grab-cursor) 11 5, grabbing !important;
    }
    :global(body.rt-snake-grabbing .fake-cursor) { visibility: hidden !important; }
    :global(.rt-measure-grab img) {
        display: block;
        height: auto;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.55));
    }
    /* While dragging, make the hand translucent + gold so it's visible and easy to grab again. */
    :global(body.rt-snake-grabbing .rt-measure-grab img) {
        opacity: 0.65;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.55)) drop-shadow(0 0 8px rgba(255, 215, 0, 0.5));
    }

    /* Per-leg readout now shares the draw tool's .rt-line-label-leg style
       (mobile.css) — see ../lineLabels.ts. Only the position (toward the leg's end,
       nudged off the band) is computed locally. */
</style>
