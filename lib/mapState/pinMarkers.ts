// Pin markers — DOM mapboxgl.Marker per Point feature. Extracted from
// MapDrawControls.svelte.
//
// Why DOM markers (not a GL symbol layer): tapping a pin always fires the
// element's click handler (no hit-test / layer-order quirks), the markers live
// outside the GL canvas so setStyle / basemap swaps / hideLabels never wipe
// them, and at our scale (dozens–hundreds of pins) the perf cost is nothing.
//
// Factory (not a singleton) — each map instance owns its own marker set. Same
// shape as createUserLocator(() => map).
import * as Sentry from "@sentry/sveltekit";
import type { Feature } from "geojson";
import mapboxgl from "mapbox-gl";
import type { Map as MapboxMap } from "mapbox-gl";
import { getAreaLabelRects } from "$parent/siblings/getCache_OnlineMap/lib/areaLabels";
import { isFiniteCoord } from "$parent/siblings/getCache_OnlineMap/lib/safeMap";
// Pins render on BOTH maps: the online one is Mapbox, the offline one
// (/mobile/offlinev4) is MapLibre. A Mapbox Marker attached to a MapLibre map
// throws "e2._addMarker is not a function" and takes the whole map down.
import { markerCtor } from "$parent/siblings/getCache_OfflineMap/lib/shared/rendererOf";
import {
    iconPath,
    parseEmojiPin,
    parsePinKey,
    pinAssetPath,
} from "$lib/mobile/utils/icons";
import { mount } from "svelte";
import EmojiPin from "$lib/mobile/components/ui/EmojiPin.svelte";
import type { MapStore } from "$lib/mobile/stores/mapStore.svelte";
import { overlayVisibility } from "$lib/mobile/stores/overlayVisibility.svelte";
import { plotByGpsKey } from "$lib/mobile/stores/quality704Plots.svelte";

type PinMarker = { key: string; pinTypeKey: string; marker: mapboxgl.Marker };

// NATIVE Mapbox clustering — the stock pattern from the mapbox-gl docs, nothing
// custom: every pin lives in ONE GeoJSON source with `cluster: true`; the GL
// engine groups them and renders the bubbles itself (circle + count layers),
// re-clustering continuously and perfectly camera-locked as you pan/zoom.
// Individual (unclustered) pins still render as DOM markers (numbered plot
// plaques, custom pin art, tap-to-popover need real elements); WHICH pins are
// unclustered is read back from the same source via querySourceFeatures, so the
// two views can never disagree.
const CLUSTER_SOURCE = "rt-pin-clusters";
const CLUSTER_LAYER = "rt-pin-clusters-circle";
const CLUSTER_COUNT_LAYER = "rt-pin-clusters-count";
const CLUSTER_ICON = "rt-cluster-bubble";

// The cluster bubble sprite — a round dark disc in the plot-plaque colours
// (#1a1a1a body, #f0c040 gold ring) wrapped in a DASHED gold halo, so a
// cluster reads as "several plaques folded together" rather than a plain
// gold coin. Drawn on a canvas because GL circle layers can't dash a stroke.
// Sized a touch bigger than the ~17px plaques it replaces.
const CLUSTER_ICON_SIZE = 32; // CSS px (icon bounding box)
function drawClusterIcon(): ImageData | null {
    const scale = 2; // crisp on retina; addImage gets pixelRatio: 2
    const px = CLUSTER_ICON_SIZE * scale;
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);
    const c = CLUSTER_ICON_SIZE / 2;
    const gold = "#f0c040";
    // Soft gold GLOW filling the band between the body's ring and the dashed
    // halo — laid down first so the body disc paints over its centre.
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240, 192, 64, 0.3)";
    ctx.fill();
    // Dashed halo — the outermost ring, translucent gold.
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.setLineDash([2.75, 2.75]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "rgba(240, 192, 64, 0.8)";
    ctx.stroke();
    // Body — dark disc with a gold ring. Nominally the plaques' 1.25px border,
    // drawn a hair heavier (1.6) because the GL-scaled canvas softens it — at
    // parity numbers it read thinner/dimmer than the plaques' crisp CSS border.
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c, c, c - 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1a1a";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = gold;
    ctx.stroke();
    return ctx.getImageData(0, 0, px, px);
}

// ── Pin captions (tier 2) ────────────────────────────────────────────────
// PINS ONLY — a pin is a user-dropped icon marker (cache, gate, pump
// house…). PLOTS ARE NOT PINS: a Quality-704 plot is a numbered plaque, its
// number IS its identity, and it NEVER gets a name caption.
//
// Each visible pin can carry its NAME as a small neutral-white halo caption
// below the marker — deliberately quieter than the coloured tier-1 area
// names (areaLabels.ts) so the eye ranks area > pin instantly. Whether a
// caption actually shows is fully automatic (no per-pin toggles):
//   1. Zoom gate — below PIN_CAPTION_MINZOOM no captions at all.
//   2. Area names (and track name labels) reserve their space first.
//   3. Captions place in priority order — selected pin first, then the
//      rest. A caption that overlaps ANY already-placed rect (area name,
//      marker, prior caption) is DROPPED — never truncated, never nudged.
//      Crowded ground = few names; open ground = many.
// The selected pin's caption bypasses both the gate and collisions.
const PIN_CAPTION_MINZOOM = 13;

type Rect = { left: number; top: number; right: number; bottom: number };

function rectsOverlap(a: Rect, b: Rect): boolean {
    return (
        a.left < b.right &&
        b.left < a.right &&
        a.top < b.bottom &&
        b.top < a.bottom
    );
}

// Reported-offender memo so the audit logs each duplicate ONCE (sync() runs often).
const auditedDupes = new Set<string>();
// Scan the live plot pins for two sharing the same plot number on the same survey
// (the "two 78s on one map" bug). Drop-time guards block NEW dupes; this surfaces
// ones already on disk. Logs LOUD + Sentry, once per unique (survey, plotNo).
function auditDuplicatePlotPins(
    pins: (Feature & { geometry: GeoJSON.Point })[],
): void {
    const byKey = new Map<string, string[]>(); // "survey|plot:N" → [featureKeys]
    for (const p of pins) {
        const pinType = p.properties?.pinTypeKey as string | undefined;
        if (!pinType || !pinType.startsWith("plot:")) continue;
        const survey = (p.properties?.surveyKey as string | undefined) ?? "";
        const fkey = (p.properties?.mapFeatureKey as string | undefined) ?? "?";
        const id = `${survey}|${pinType}`;
        let group = byKey.get(id);
        if (!group) {
            group = [];
            byKey.set(id, group);
        }
        group.push(fkey);
    }
    for (const [id, keys] of byKey) {
        if (keys.length < 2 || auditedDupes.has(id)) continue;
        auditedDupes.add(id);
        const msg = `[markers] DUPLICATE PLOT PIN: ${keys.length} pins for "${id.split("|")[1]}" on survey "${id.split("|")[0] || "(none)"}" — features ${keys.join(", ")}. Two identical numbered pins on one map. Clean up one.`;
        console.error(msg);
        try {
            Sentry.captureException(new Error(msg), {
                tags: { area: "quality704", kind: "duplicate-pin-audit" },
            });
        } catch {} // codestyle-allow-swallow: Sentry may be uninitialised in tests/headless
    }
}

export interface PinMarkersDeps {
    getMap: () => MapboxMap | null;
    mapStore: MapStore;
    getOffline: () => boolean;
    /** mapFeatureKey of the selected feature (popover open), or null — drives
     *  the selected plot marker's gold "Plot N" pill. */
    getSelectedKey: () => string | null;
    popoverPos: { compute(feature: Feature): void };
    /** null clears the selection (tap the selected pin again to toggle off). */
    setSelectedIndex: (idx: number | null) => void;
    panPointToTop: (feat: Feature, opts?: { zoom?: number }) => void;
}

export interface PinMarkers {
    /** Reconcile markers against the store's current Point features. Run inside
     *  a `$effect` — its synchronous reads of mapStore drive reactivity. */
    sync(): void;
    /** Remove every marker. Run in the map-wiring effect cleanup. */
    clear(): void;
}

export function createPinMarkers(deps: PinMarkersDeps): PinMarkers {
    const { getMap, mapStore } = deps;
    // Tip on the spot, EVERY route — the pin art is a teardrop whose point IS
    // the coordinate. (The offline map once centre-anchored its pins, which put
    // the same GPS coord half a pin north of where the online map showed it.)
    const PIN_ANCHOR = "bottom" as const;
    let pinMarkers: PinMarker[] = [];

    // The pins most recently pushed into the clustered source — reconcileSingles
    // builds DOM markers from these once the source reports which are unclustered.
    let lastPins: (Feature & { geometry: GeoJSON.Point })[] = [];
    // Pins that NEVER cluster: feature pins (few and important) + the selected
    // pin (pulled out of its cluster so it always stands alone). Rebuilt every
    // sync alongside lastPins.
    let forcedSingleKeys = new Set<string>();
    let handlersInstalled = false;

    // ── COINCIDENT-PIN STACKS (spiderfy) ────────────────────────────────────
    // Above clusterMaxZoom the bubbles unfold into single markers — but plots
    // thrown on the SAME spot (repeat surveys, imports) land as perfectly
    // stacked plaques where only the top one is tappable: invisible
    // duplicates. So coincident plot markers collapse into ONE representative
    // plaque wearing a count badge; tapping it fans the members out on a
    // circle (screen-space Marker offsets — the coords never change), each
    // with a gold leader leg pointing back at the true spot. Tap a fanned
    // plaque → normal selection; tap the map → the fan folds back up.
    const STACK_DECIMALS = 6; // ~0.11 m — same-spot pins, never neighbours
    let expandedStack: string | null = null; // coordKey the user fanned open
    let stackByFeature = new Map<string, string>(); // featureKey → coordKey
    let openStacks = new Set<string>(); // coordKeys rendered fanned right now

    function setStackBadge(el: HTMLElement, n: number | null): void {
        const inner = el.querySelector(".map-pin-plot__inner");
        if (!inner) return;
        let badge = inner.querySelector<HTMLElement>(".map-pin-plot__stackn");
        if (n == null) {
            badge?.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "map-pin-plot__stackn";
            inner.appendChild(badge);
        }
        badge.textContent = String(n);
    }

    // The leader leg — a thin gold line from the fanned plaque's tip back to
    // the true coordinate. Anchored at the plaque's bottom-center (= the
    // offset anchor point); rotate so it points at the un-offset spot.
    function setStackLeg(el: HTMLElement, dx: number, dy: number | null): void {
        let leg = el.querySelector<HTMLElement>(".map-pin-stack-leg");
        if (dy == null) {
            leg?.remove();
            return;
        }
        if (!leg) {
            leg = document.createElement("span");
            leg.className = "map-pin-stack-leg";
            el.appendChild(leg);
        }
        leg.style.height = `${Math.round(Math.hypot(dx, dy))}px`;
        // A top-anchored div extends DOWN (0,1); CSS rotate is clockwise in
        // screen coords, so pointing it along (−dx,−dy) needs θ = atan2(dx,−dy).
        leg.style.transform = `rotate(${Math.atan2(dx, -dy)}rad)`;
    }

    function resetStackStyling(pm: PinMarker): void {
        const el = pm.marker.getElement();
        if (
            !el.classList.contains("map-pin-plot--stack-rep") &&
            !el.classList.contains("map-pin-plot--stack-hidden") &&
            !el.classList.contains("map-pin-plot--stack-out")
        ) {
            return;
        }
        pm.marker.setOffset([0, 0]);
        el.classList.remove(
            "map-pin-plot--stack-rep",
            "map-pin-plot--stack-hidden",
            "map-pin-plot--stack-out",
        );
        setStackBadge(el, null);
        setStackLeg(el, 0, null);
    }

    // Group the live plot markers by exact coordinate and lay each group out —
    // collapsed (one badge-wearing representative, the rest hidden) or fanned
    // (everyone offset on a circle with a leader leg). Runs every reconcile so
    // zoom/cluster churn can never strand a stale fan.
    function layoutStacks(selKey: string | null): void {
        const groups = new Map<string, PinMarker[]>();
        for (const pm of pinMarkers) {
            if (!pm.pinTypeKey.startsWith("plot:")) continue;
            const ll = pm.marker.getLngLat();
            const ck = `${ll.lng.toFixed(STACK_DECIMALS)},${ll.lat.toFixed(STACK_DECIMALS)}`;
            const arr = groups.get(ck);
            if (arr) arr.push(pm);
            else groups.set(ck, [pm]);
        }
        stackByFeature = new Map();
        openStacks = new Set();
        if (expandedStack && (groups.get(expandedStack)?.length ?? 0) < 2) {
            expandedStack = null; // the stack dissolved (zoom-out, delete, move)
        }
        for (const [ck, members] of groups) {
            if (members.length < 2) {
                const only = members[0];
                if (only) resetStackStyling(only);
                continue;
            }
            // Stable fan order — keyed sort so angles never shuffle between frames.
            members.sort((a, b) => (a.key < b.key ? -1 : 1));
            for (const pm of members) stackByFeature.set(pm.key, ck);
            // The selected pin forces its stack open — a selection must never
            // sit hidden under a representative.
            const expanded =
                expandedStack === ck || members.some((m) => m.key === selKey);
            if (expanded) openStacks.add(ck);
            const n = members.length;
            members.forEach((pm, i) => {
                const el = pm.marker.getElement();
                if (!expanded) {
                    pm.marker.setOffset([0, 0]);
                    const isRep = i === 0;
                    el.classList.toggle("map-pin-plot--stack-rep", isRep);
                    el.classList.toggle("map-pin-plot--stack-hidden", !isRep);
                    el.classList.remove("map-pin-plot--stack-out");
                    setStackBadge(el, isRep ? n : null);
                    setStackLeg(el, 0, null);
                } else {
                    const R = n <= 4 ? 36 : Math.min(70, 24 + n * 5);
                    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
                    const dx = Math.round(R * Math.cos(ang));
                    const dy = Math.round(R * Math.sin(ang));
                    pm.marker.setOffset([dx, dy]);
                    el.classList.remove(
                        "map-pin-plot--stack-rep",
                        "map-pin-plot--stack-hidden",
                    );
                    el.classList.add("map-pin-plot--stack-out");
                    setStackBadge(el, null);
                    setStackLeg(el, dx, dy);
                }
            });
        }
    }

    // Move the bubble layers to the very top of the style's layer stack (count
    // above circle), skipping when they're already there — the skip is what
    // makes this safe to call from styledata (moveLayer itself fires styledata;
    // without the guard that's an infinite loop).
    function hoistClusterLayers(map: MapboxMap): void {
        if (!map.getLayer(CLUSTER_LAYER) || !map.getLayer(CLUSTER_COUNT_LAYER)) return;
        const ids = map.getStyle()?.layers?.map((l) => l.id) ?? [];
        if (
            ids[ids.length - 2] === CLUSTER_LAYER &&
            ids[ids.length - 1] === CLUSTER_COUNT_LAYER
        ) {
            return; // already on top — do NOT re-move (styledata loop guard)
        }
        map.moveLayer(CLUSTER_LAYER);
        map.moveLayer(CLUSTER_COUNT_LAYER);
    }

    // Install the clustered source + the two stock layers (bubble circle +
    // count). Idempotent — runs every sync, because setStyle (basemap swap)
    // wipes all custom sources/layers and the next sync must re-create them.
    function ensureClusterLayers(map: MapboxMap): void {
        if (!map.getSource(CLUSTER_SOURCE)) {
            map.addSource(CLUSTER_SOURCE, {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] },
                cluster: true,
                clusterMaxZoom: 14,
                // Pins fold into a bubble when ~25px apart CENTER-TO-CENTER —
                // 20 let neighbouring plaques visibly overlap before merging;
                // the stock 50 merged pins that were still clearly separate on
                // screen, killing the per-pin status dots way too early.
                clusterRadius: 25,
            });
        }
        // setStyle (basemap swap) wipes custom images along with the layers —
        // the hasImage guard makes this as idempotent as the layer adds below.
        if (!map.hasImage(CLUSTER_ICON)) {
            const img = drawClusterIcon();
            if (img) map.addImage(CLUSTER_ICON, img, { pixelRatio: 2 });
        }
        if (!map.getLayer(CLUSTER_LAYER)) {
            map.addLayer({
                id: CLUSTER_LAYER,
                type: "symbol",
                source: CLUSTER_SOURCE,
                filter: ["has", "point_count"],
                layout: {
                    // The canvas-drawn bubble (dark disc + dashed gold halo).
                    // ONE fixed small size — a cluster is a marker, not a data
                    // readout: the count label already says how many, so the
                    // bubble must NOT grow with it (graduated sizes ballooned
                    // busy blocks into a wall of fat coins).
                    "icon-image": CLUSTER_ICON,
                    "icon-allow-overlap": true,
                },
            });
        }
        if (!map.getLayer(CLUSTER_COUNT_LAYER)) {
            map.addLayer({
                id: CLUSTER_COUNT_LAYER,
                type: "symbol",
                source: CLUSTER_SOURCE,
                filter: ["has", "point_count"],
                layout: {
                    "text-field": ["get", "point_count_abbreviated"],
                    // Font must exist in the CURRENT style's glyph endpoint. The
                    // offline base bundles ONLY "Noto Sans Regular" (the full
                    // 256-range set in static/mobileAssets/worldBase/glyphs) — a DIN Pro
                    // request 404s there and the count silently never renders
                    // (blank gold coins). Online keeps the Mapbox-hosted stack.
                    "text-font": deps.getOffline()
                        ? ["Noto Sans Regular"]
                        : ["DIN Pro Bold", "Arial Unicode MS Bold"],
                    "text-size": 12,
                    "text-allow-overlap": true,
                },
                // Gold-on-dark, matching the plot plaques' number treatment:
                // same gold, bold weight, and a dark halo standing in for the
                // plaques' 1px black text-shadow.
                paint: {
                    "text-color": "#f0c040",
                    "text-halo-color": "rgba(0, 0, 0, 0.9)",
                    "text-halo-width": 0.8,
                },
            });
        }
        hoistClusterLayers(map);
        if (!handlersInstalled) {
            handlersInstalled = true;
            // KEEP ON TOP, event-driven — other installers (the grid, draw
            // layers, overlays) add their layers whenever THEY like (grid
            // toggle, zoom threshold, tile load), not just at sync time, and a
            // layer added after our last hoist paints over the bubbles (a grid
            // dot sitting on top of a cluster). styledata fires on every layer
            // add/remove, so re-hoisting there keeps the bubbles on top no
            // matter who installs what, in any order. The already-on-top guard
            // in hoistClusterLayers stops the moveLayer→styledata feedback
            // loop. (Single pins are DOM markers — always above the GL canvas.)
            map.on("styledata", () => hoistClusterLayers(map));
            // Tap a bubble → ease to the zoom where it splits (stock behaviour).
            map.on("click", CLUSTER_LAYER, (e) => {
                const f = map.queryRenderedFeatures(e.point, {
                    layers: [CLUSTER_LAYER],
                })[0];
                const clusterId = f?.properties?.cluster_id as number | undefined;
                const src = map.getSource(CLUSTER_SOURCE) as
                    | mapboxgl.GeoJSONSource
                    | undefined;
                if (clusterId == null || !src) return;
                src.getClusterExpansionZoom(clusterId, (err, zoom) => {
                    if (err || zoom == null) return;
                    const center = (f.geometry as GeoJSON.Point).coordinates as [
                        number,
                        number,
                    ];
                    if (!isFiniteCoord(center as unknown)) return;
                    map.easeTo({ center, zoom });
                });
            });
            map.on("mouseenter", CLUSTER_LAYER, () => {
                map.getCanvas().style.cursor = "pointer";
            });
            map.on("mouseleave", CLUSTER_LAYER, () => {
                map.getCanvas().style.cursor = "";
            });
            // Tap the open map → fold any fanned stack back up. Marker taps
            // stopPropagation, so they never reach this.
            map.on("click", () => {
                if (expandedStack) {
                    expandedStack = null;
                    reconcileSingles();
                }
            });
            // Clustering is computed in worker tiles AFTER setData — re-derive
            // which pins are unclustered whenever the source settles (initial
            // load, every setData, and every re-tile as the camera moves).
            //
            // COALESCED TO ONE RUN PER FRAME. `sourcedata` fires PER TILE, so a
            // pan across a populated area fires it dozens of times in a few
            // hundred ms — and every hit ran `querySourceFeatures` (which
            // materialises the source's features) plus built a fresh Set, a
            // filtered array and a new Map. All of that to compute a value that
            // only needs to be right ONCE, at the end of the burst.
            //
            // rAF is the correct clock here: the output is what the user sees,
            // so recomputing more than once per painted frame cannot change
            // anything on screen. The extra runs were pure garbage.
            let reconcileRaf = 0;
            const scheduleReconcile = () => {
                if (reconcileRaf) return; // already queued for this frame
                reconcileRaf = requestAnimationFrame(() => {
                    reconcileRaf = 0;
                    reconcileSingles();
                });
            };
            map.on("sourcedata", (e) => {
                if (e.sourceId === CLUSTER_SOURCE && e.isSourceLoaded) {
                    scheduleReconcile();
                }
            });
        }
    }

    function buildPinElement(featureKey: string, pinTypeKey: string): HTMLElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "map-pin-marker";
        btn.dataset.featureKey = featureKey;
        btn.setAttribute("aria-label", "Pin");
        // Quality-plot marker: `plot:N` → a small black/gold numbered plaque (the
        // classic forester's plot marker), built here rather than from the icon
        // registry because the number is dynamic.
        if (pinTypeKey.startsWith("plot:")) {
            // The baked `plot:N` is just a placeholder for first paint — the sync()
            // loop overwrites `.map-pin-plot__num` with the DERIVED per-map number
            // (plot.displayNo) on the same frame, so what the user sees is the
            // dynamic rank, never this stale value.
            const n = pinTypeKey.slice(5);
            btn.classList.add("map-pin-plot");
            // Number + the StatusDots cluster (the cute corner bulbs). Built here as
            // an innerHTML string (one DOM node per marker, no per-pin Svelte mount),
            // but it emits the SAME class contract StatusDots.svelte owns, and that
            // component's :global CSS (imported by MapDrawControls) styles it. The
            // sync() loop toggles --under/--over/--fault on the BUTTON; CSS shows the
            // matching bulb. Symbol-only on the map (the plot row's PILLS carry −2/+2).
            // The number + dot cluster live inside `.map-pin-plot__inner` — a
            // position:relative wrapper that is the dots' anchor. The dots can NOT
            // anchor to the button root: that root is the Mapbox marker, which must
            // keep position:absolute or it drifts across the map on zoom.
            btn.innerHTML =
                `<span class="map-pin-plot__inner">` +
                `<span class="map-pin-plot__num">${n}</span>` +
                `<span class="q704-dots">` +
                `<span class="q704-dot q704-dot--under">−</span>` +
                `<span class="q704-dot q704-dot--over">+</span>` +
                `<span class="q704-dot q704-dot--fault"></span>` +
                `</span>` +
                `</span>`;
            return btn;
        }
        // Emoji pin (`emoji:<char>`) — mounts THE EmojiPin component, the
        // same one the PIN LIBRARY swatch and the detail header render. This
        // surface builds plain DOM (one node per marker, no per-pin Svelte
        // overhead elsewhere), but the pin itself is not re-implemented here:
        // there is exactly one definition of what an emoji pin looks like.
        const emojiChar = parseEmojiPin(pinTypeKey);
        if (emojiChar) {
            btn.classList.add("map-pin-emoji");
            mount(EmojiPin, {
                target: btn,
                props: { char: emojiChar, size: 30 },
            });
            return btn;
        }
        // Every other icon path comes from the registry in icons.ts — never built
        // here. `tiles` is the reserved system marker (a meta icon, not a
        // user-pickable pin); any unrecognised key falls back to `default`.
        const src =
            pinTypeKey === "tiles"
                ? iconPath("tiles")
                : pinAssetPath(parsePinKey(pinTypeKey) ?? "pin");
        btn.innerHTML = `<img src="${src}" alt="" draggable="false">`;
        return btn;
    }

    function attachMarkerClick(el: HTMLElement, featureKey: string) {
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            // COLLAPSED STACK representative → the first tap fans the stack
            // out (spiderfy); nothing selects yet. Once fanned, taps fall
            // through to normal per-plaque selection below.
            const stackKey = stackByFeature.get(featureKey);
            if (stackKey && !openStacks.has(stackKey)) {
                expandedStack = stackKey;
                reconcileSingles();
                return;
            }
            // Tap the selected pin again → clear the selection (same as
            // tapping empty map): popover closes, dim lifts, caption obeys
            // the normal priority rules again.
            if (deps.getSelectedKey() === featureKey) {
                deps.setSelectedIndex(null);
                return;
            }
            const idx = mapStore.features.findIndex(
                (f) => (f.properties?.mapFeatureKey as string) === featureKey,
            );
            if (idx < 0) return;
            deps.setSelectedIndex(idx);
            const feat = mapStore.features[idx];
            if (feat) {
                deps.popoverPos.compute(feat);
                // CONVENTION — NEVER "slam" the user into the ground on a pin tap.
                // A tap only ensures the DEFAULT context zoom (PIN_TAP_ZOOM, 10z):
                // farther out → eases IN to 10 so the pin lands up top with some
                // surroundings; already closer → zoom LEFT ALONE. It must never
                // force a deeper zoom than the user chose — being yanked to street
                // level is disorienting when you don't yet know where you are.
                // (Was max(cur,16) live / 12 offline, which slammed every tap to
                // z16+.) Same cap on the live + offline maps.
                const PIN_TAP_ZOOM = 10;
                const map = getMap();
                const cur = map ? map.getZoom() : NaN;
                const target = Number.isFinite(cur)
                    ? Math.max(cur, PIN_TAP_ZOOM)
                    : PIN_TAP_ZOOM;
                deps.panPointToTop(feat, { zoom: target });
            }
        });
    }

    function clear() {
        for (const pm of pinMarkers) pm.marker.remove();
        pinMarkers = [];
        expandedStack = null;
        stackByFeature = new Map();
        openStacks = new Set();
    }

    function sync() {
        const map = getMap();
        if (!map) return;
        if (!mapStore.ready) return;
        // NaN-CAMERA GUARD. A degenerate camera transform (zoom === NaN) makes
        // map.getBounds() THROW (Invalid LngLat (NaN,NaN)) → red-screen crash.
        // It can happen for one frame during a jump/ease (see mapInit's
        // renderGuard, which restores the camera next frame). Skip this sync
        // when the camera is non-finite; the next sync runs once it's restored.
        if (!Number.isFinite(map.getZoom())) return;
        const feats = mapStore.features;
        // Honour the per-type visibility toggles (Legend / Basemap popover). A
        // `plot:` marker is a Quality-704 plot → `plots`; the reserved `tiles`
        // system marker is ALWAYS shown; every other Point pin → `pins`. Hidden
        // types are filtered out here so their DOM markers are removed by the
        // reconcile below (reads overlayVisibility reactively → re-syncs on toggle).
        const pins = feats.filter(
            (f): f is Feature & { geometry: GeoJSON.Point } => {
                if (f.geometry?.type !== "Point") return false;
                const t = (f.properties?.pinTypeKey as string) ?? "pin";
                if (t === "tiles") return true; // system marker, never hidden
                if (t.startsWith("plot:")) return overlayVisibility.plots;
                return overlayVisibility.pins;
            },
        );

        // DUPLICATE-PIN AUDIT — scoped to ONE survey. The displayed number is now a
        // DERIVED per-map rank, so two DIFFERENT surveys sharing a baked `plot:N` is
        // EXPECTED (they merge into one 1..N) — NOT flagged. But two pins with the
        // same baked number inside the SAME survey is still a real bug (a survey
        // can't own its own plot 5 twice). The audit keys by survey|plot:N, so it
        // only fires on same-survey collisions.
        auditDuplicatePlotPins(pins);

        // NATIVE CLUSTERING — numbered plots ONLY. Feature pins (cache, gate,
        // pump house…) are few and important, so they never fold into a count
        // bubble; they render as always-on DOM markers. The selected pin is
        // pulled out of the cluster feed too, so it always stands alone.
        const selKey = deps.getSelectedKey();
        const clusterFeed: typeof pins = [];
        forcedSingleKeys = new Set();
        for (const p of pins) {
            const t = (p.properties?.pinTypeKey as string) ?? "pin";
            const k = p.properties?.mapFeatureKey as string | undefined;
            if (t.startsWith("plot:") && k !== selKey) clusterFeed.push(p);
            else if (k) forcedSingleKeys.add(k);
        }
        ensureClusterLayers(map);
        lastPins = pins;
        (map.getSource(CLUSTER_SOURCE) as mapboxgl.GeoJSONSource).setData({
            type: "FeatureCollection",
            features: clusterFeed,
        });
        reconcileSingles();
    }

    // Reconcile the DOM pin markers to exactly the pins the clustered source
    // reports as UNCLUSTERED right now. Runs after every sync() and every time
    // the source finishes re-tiling (sourcedata) — clustering happens in worker
    // tiles, so the answer isn't available synchronously after setData.
    function reconcileSingles() {
        const map = getMap();
        if (!map || !mapStore.ready) return;
        if (!Number.isFinite(map.getZoom())) return;
        if (!map.getSource(CLUSTER_SOURCE)) return;
        // Not yet re-clustered → keep the current markers; the sourcedata
        // listener re-runs this the moment the source settles.
        if (!map.isSourceLoaded(CLUSTER_SOURCE)) return;
        const pins = lastPins;
        // Unclustered = source features WITHOUT point_count. querySourceFeatures
        // only returns features in loaded viewport tiles, so off-screen pins
        // simply keep no marker (same effect as the old viewport culling).
        const singleKeys = new Set<string>();
        for (const f of map.querySourceFeatures(CLUSTER_SOURCE, {
            filter: ["!", ["has", "point_count"]],
        })) {
            const k = f.properties?.mapFeatureKey as string | undefined;
            if (k) singleKeys.add(k);
        }
        // Feature pins + the selected pin never cluster — they're not in the
        // clustered source at all, so add them back as always-wanted singles.
        for (const k of forcedSingleKeys) singleKeys.add(k);

        // Only the un-clustered SINGLES render as real pins.
        const wantKeys = singleKeys;

        // Drop markers whose pin no longer exists OR is now inside a cluster.
        pinMarkers = pinMarkers.filter((pm) => {
            if (wantKeys.has(pm.key)) return true;
            pm.marker.remove();
            return false;
        });

        const have = new Map(pinMarkers.map((pm) => [pm.key, pm]));

        for (const pin of pins) {
            // Skip pins that the cluster query folded into a bubble.
            const pk = pin.properties?.mapFeatureKey as string | undefined;
            if (!pk || !singleKeys.has(pk)) continue;
            const fkey = pin.properties?.mapFeatureKey as string | undefined;
            if (!fkey) continue;
            const pinTypeKey = (pin.properties?.pinTypeKey as string) ?? "pin";
            const coords = pin.geometry.coordinates as [number, number];
            // Mandatory NaN guard before every Mapbox coord write — see memory
            // `mapbox-camera-via-safeMap`. If we let NaN reach Marker.setLngLat
            // or .addTo, Mapbox's projection matrix gets nulled and EVERY
            // subsequent render throws (breaking unrelated features too).
            if (!isFiniteCoord(coords as unknown)) {
                console.warn(
                    `[markers] skipping pin ${fkey} — non-finite coords:`,
                    coords,
                );
                continue;
            }
            const existing = have.get(fkey);

            if (existing) {
                // Position can shift if user moves a feature; type can change
                // via the popover. Update both in place.
                existing.marker.setLngLat(coords);
                if (existing.pinTypeKey !== pinTypeKey) {
                    const newEl = buildPinElement(fkey, pinTypeKey);
                    attachMarkerClick(newEl, fkey);
                    // mapboxgl.Marker doesn't expose a setElement, so swap by
                    // replacing the marker entirely.
                    existing.marker.remove();
                    const m = new (markerCtor(map))({
                        element: newEl,
                        anchor: PIN_ANCHOR,
                    })
                        .setLngLat(coords)
                        .addTo(map);
                    existing.marker = m;
                    existing.pinTypeKey = pinTypeKey;
                }
                continue;
            }

            const el = buildPinElement(fkey, pinTypeKey);
            attachMarkerClick(el, fkey);
            const marker = new (markerCtor(map))({
                element: el,
                anchor: PIN_ANCHOR,
            })
                .setLngLat(coords)
                .addTo(map);
            pinMarkers.push({ key: fkey, pinTypeKey, marker });
        }

        // Selected plot marker → gold "Plot N" pill (you can see which pin the
        // open popover belongs to). Only the selected marker's label/class
        // changes; unselected plot markers are reset to their plain number, so
        // this never de-styles the others.
        const selKey = deps.getSelectedKey();
        for (const pm of pinMarkers) {
            if (!pm.pinTypeKey.startsWith("plot:")) continue;
            const el = pm.marker.getElement();
            const isSel = pm.key === selKey;
            el.classList.toggle("map-pin-plot--selected", isSel);
            // pm.key is the pin's mapFeatureKey = the plot row's gpsFeatureKey, so
            // plotByGpsKey resolves the live row — re-checked EVERY sync(), so an
            // edit (or a merge/delete that re-flows numbers) shows live.
            const plot = plotByGpsKey(pm.key);
            // THE DYNAMIC NUMBER. The pin label is the plot's per-MAP rank
            // (plot.displayNo), NOT the frozen `plot:N` baked into the feature at
            // drop time. So as surveys merge onto one map the labels re-flow into a
            // single 1..N, and deleting a plot shifts the rest up — all live here.
            // Fall back to the baked `plot:N` only if the row can't be resolved.
            const numEl = el.querySelector(".map-pin-plot__num");
            if (numEl) {
                const n = String(plot?.displayNo || pm.pinTypeKey.slice(5));
                numEl.textContent = isSel ? `Plot ${n}` : n;
            }
            // STATUS BADGES — corner badges flag a plot's status at a glance,
            // matching the popover's own maths (PlotMapPopover): a rose "−" when
            // planting came up SHORT of the spot count, a teal "+" when there are
            // EXCESS trees over M, a red dot for a quality FAULT. All INDEPENDENT — a
            // plot can show any combination.
            const hasFault = (plot?.faults.length ?? 0) > 0;
            const under = Math.max(0, (plot?.spots ?? 0) - (plot?.planted ?? 0));
            const over = plot?.excess ?? 0;
            el.classList.toggle("map-pin-plot--under", under > 0);
            el.classList.toggle("map-pin-plot--over", over > 0);
            el.classList.toggle("map-pin-plot--fault", hasFault);
        }

        // SELECTION OVERRIDE — any selected pin (plot or feature pin) lifts
        // above the dim veil (z via .map-pin-marker--selected; the veil
        // itself is owned by MapDrawControls). Toggled every reconcile so
        // deselecting (tap map / tap pin again) restores everything.
        for (const pm of pinMarkers) {
            pm.marker
                .getElement()
                .classList.toggle("map-pin-marker--selected", pm.key === selKey);
        }

        // Coincident plot plaques fold into count-badged stacks / fan out.
        layoutStacks(selKey);

        placeCaptions(map, selKey);
    }

    // TIER-2 CAPTION PLACEMENT — see the constants block up top for the rules.
    // Runs after every marker reconcile (sync, sourcedata settle, moveend), so
    // the winners re-compete whenever the camera or the data settles.
    function placeCaptions(map: MapboxMap, selKey: string | null): void {
        const zoom = map.getZoom();
        const zoomOk = Number.isFinite(zoom) && zoom >= PIN_CAPTION_MINZOOM;
        const nameByKey = new Map<string, string>();
        for (const p of lastPins) {
            const k = p.properties?.mapFeatureKey as string | undefined;
            if (k) nameByKey.set(k, String(p.properties?.name ?? "").trim());
        }

        // WRITE pass — ensure each marker's caption element exists with the
        // current name, hidden-but-laid-out so it can be measured. Pins with
        // no name (and the reserved `tiles` marker) never caption. PLOTS
        // never caption at all — the plaque number is a plot's identity.
        type Candidate = { pm: PinMarker; cap: HTMLElement; priority: number };
        const candidates: Candidate[] = [];
        for (const pm of pinMarkers) {
            const el = pm.marker.getElement();
            let cap = el.querySelector<HTMLElement>(".map-pin-caption");
            const name = nameByKey.get(pm.key) ?? "";
            if (
                name === "" ||
                pm.pinTypeKey === "tiles" ||
                pm.pinTypeKey.startsWith("plot:")
            ) {
                cap?.remove();
                continue;
            }
            if (!cap) {
                cap = document.createElement("span");
                cap.className = "map-pin-caption";
                el.appendChild(cap);
            }
            if (cap.textContent !== name) cap.textContent = name;
            const isSel = pm.key === selKey;
            // Zoom gate: markers only, no captions — except the selected pin,
            // whose caption shows regardless of zoom or collisions.
            if (!zoomOk && !isSel) {
                cap.style.display = "none";
                continue;
            }
            cap.style.display = "";
            cap.style.visibility = "hidden";
            candidates.push({ pm, cap, priority: isSel ? 0 : 1 });
        }
        if (candidates.length === 0) return;

        // READ pass — one reflow: caption rects, marker rects, and the tier-1
        // area-name rects (reserved first; a caption never crowds an area name).
        const capRects = candidates.map(
            (c) => c.cap.getBoundingClientRect() as Rect,
        );
        const markerRects = pinMarkers.map((pm) => ({
            key: pm.key,
            rect: pm.marker.getElement().getBoundingClientRect() as Rect,
        }));
        const placed: Rect[] = getAreaLabelRects(map);

        // PLACE pass — selected pin first, the rest in stable order. Overlap
        // anything already placed or any OTHER marker → drop (no truncation,
        // no nudging).
        const order = candidates
            .map((c, i) => ({ c, rect: capRects[i], i }))
            .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i);
        for (const { c, rect } of order) {
            const isSel = c.priority === 0;
            const blocked =
                !isSel &&
                (placed.some((r) => rectsOverlap(r, rect)) ||
                    markerRects.some(
                        (m) => m.key !== c.pm.key && rectsOverlap(m.rect, rect),
                    ));
            if (blocked) {
                c.cap.style.display = "none";
            } else {
                c.cap.style.visibility = "";
                placed.push(rect);
            }
        }
    }

    return { sync, clear };
}
