import * as Sentry from "@sentry/sveltekit";
import type { Feature } from "geojson";
import mapboxgl from "mapbox-gl";
import type { Map as MapboxMap } from "mapbox-gl";
import { getAreaLabelRects } from "@ground-truth/getcache-onlinemap/lib/areaLabels";
import { isFiniteCoord } from "@ground-truth/getcache-onlinemap/lib/safeMap";
// Pins render on BOTH Mapbox (online) and MapLibre (offline /mobile/offlinev4) — a Mapbox Marker attached to a MapLibre map throws and takes the whole map down.
// plotByGpsKey arrives via the optional ports.q704 — absent on hosts without inspections, so callers must optional-chain it.
import { markerCtor } from "../shared/rendererOf";
import {
    iconPath,
    parseEmojiPin,
    parsePinKey,
    pinAssetPath,
} from "../shared/icons";
import { mount } from "svelte";
import type {
    MapHostPorts,
    MapHostStore as MapStore,
} from "../shared/mapHostPorts";
import { overlayVisibility } from "./overlayVisibility.svelte";

type PinMarker = { key: string; pinTypeKey: string; marker: mapboxgl.Marker };

// NATIVE Mapbox clustering (stock pattern): one GeoJSON source w/ cluster:true; unclustered pins render as DOM markers, and WHICH ones are unclustered is read back via querySourceFeatures so the two views can never disagree.
const CLUSTER_SOURCE = "rt-pin-clusters";
const CLUSTER_LAYER = "rt-pin-clusters-circle";
const CLUSTER_COUNT_LAYER = "rt-pin-clusters-count";
const CLUSTER_ICON = "rt-cluster-bubble";

// Canvas-drawn (not a GL circle layer) because GL circle layers can't dash a stroke.
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
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240, 192, 64, 0.3)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.setLineDash([2.75, 2.75]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "rgba(240, 192, 64, 0.8)";
    ctx.stroke();
    // Nominally the plaques' 1.25px border; bumped to 1.6 — the GL-scaled canvas softens it, so 1.25 read thinner/dimmer than the plaques' CSS border.
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

// Captions are PINS ONLY — a plot's plaque number is its identity and it NEVER gets a name caption.
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
// Scans live plot pins for two sharing the same plot number on the same survey (the "two 78s on one map" bug) — surfaces dupes already on disk; drop-time guards block new ones.
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
    /** `ui.EmojiPin` mounts emoji pins; `q704?.plotByGpsKey` resolves a plot's live row — q704 is optional, a host without inspections gets the baked `plot:N` label and nothing throws. */
    ports: Pick<MapHostPorts, "ui" | "q704">;
    getOffline: () => boolean;
    /** mapFeatureKey of the selected feature (popover open), or null — drives the selected plot marker's gold "Plot N" pill. */
    getSelectedKey: () => string | null;
    popoverPos: { compute(feature: Feature): void };
    /** null clears the selection (tap the selected pin again to toggle off). */
    setSelectedIndex: (idx: number | null) => void;
    panPointToTop: (feat: Feature, opts?: { zoom?: number }) => void;
}

export interface PinMarkers {
    /** Run inside an `$effect` — its synchronous reads of mapStore drive reactivity. */
    sync(): void;
    /** Run in the map-wiring effect cleanup. */
    clear(): void;
}

export function createPinMarkers(deps: PinMarkersDeps): PinMarkers {
    const { getMap, mapStore, ports } = deps;
    // Anchor 'bottom' EVERY route — the pin art is a teardrop whose point IS the coordinate. (Was center-anchored on offline once, which put the GPS coord half a pin north of where online showed it.)
    const PIN_ANCHOR = "bottom" as const;
    let pinMarkers: PinMarker[] = [];

    // Pins most recently pushed into the clustered source — reconcileSingles builds DOM markers from these once the source reports which are unclustered.
    let lastPins: (Feature & { geometry: GeoJSON.Point })[] = [];
    // Pins that NEVER cluster: feature pins + the selected pin. Rebuilt every sync alongside lastPins.
    let forcedSingleKeys = new Set<string>();
    let handlersInstalled = false;

    // Coincident same-spot plot markers (repeat surveys/imports) would stack invisibly (only the top tappable) — collapsed into one badge-wearing representative that fans out on tap (screen-space offsets; coords never change).
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
        // Top-anchored div extends DOWN (0,1); CSS rotate is clockwise in screen coords, so pointing at (−dx,−dy) needs θ = atan2(dx,−dy).
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

    // Groups plot markers by exact coordinate → collapsed (badge rep) or fanned (offset circle + leg); runs every reconcile so zoom/cluster churn never leaves a stale fan.
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
            // The selected pin forces its stack open — a selection must never sit hidden under a representative.
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

    // Skip-if-already-on-top guard is required — moveLayer fires styledata itself, so without it this becomes an infinite loop when called from styledata.
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

    // Idempotent — setStyle (basemap swap) wipes all custom sources/layers, so this must re-run and re-create them every sync.
    function ensureClusterLayers(map: MapboxMap): void {
        if (!map.getSource(CLUSTER_SOURCE)) {
            map.addSource(CLUSTER_SOURCE, {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] },
                cluster: true,
                clusterMaxZoom: 14,
                // clusterRadius 25 (~25px): the stock 50 merged clearly-separate pins too early (killed status dots); 20 let plaques visibly overlap before merging.
                clusterRadius: 25,
            });
        }
        // setStyle wipes custom images too — hasImage guard keeps this idempotent like the layer adds below.
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
                    // Bubble is ONE fixed size, must NOT grow with count — graduated sizes previously ballooned busy blocks into a wall of fat coins.
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
                    // Font must exist in the CURRENT style's glyph endpoint — offline only bundles "Noto Sans Regular"; requesting DIN Pro there 404s and the count silently never renders (blank gold coins).
                    "text-font": deps.getOffline()
                        ? ["Noto Sans Regular"]
                        : ["DIN Pro Bold", "Arial Unicode MS Bold"],
                    "text-size": 12,
                    "text-allow-overlap": true,
                },
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
            // Re-hoist on every styledata (not just once) — other installers (grid, draw layers, overlays) add layers whenever THEY like, and a layer added after our last hoist paints over the bubbles.
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
            // Tap the open map → fold any fanned stack back up; marker taps stopPropagation so they never reach this handler.
            map.on("click", () => {
                if (expandedStack) {
                    expandedStack = null;
                    reconcileSingles();
                }
            });
            // Coalesced to ONE run per animation frame — sourcedata fires PER TILE (dozens of times during a pan), and querySourceFeatures is expensive; the unclustered set only needs to be right once, at the end of the burst.
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
        // Quality-plot marker (`plot:N`) is built here, not from the icon registry — the number is dynamic.
        if (pinTypeKey.startsWith("plot:")) {
            // The baked `plot:N` is only a first-paint placeholder — sync() overwrites `.map-pin-plot__num` with the derived per-map rank (plot.displayNo) same frame; never treat this as the real number.
            const n = pinTypeKey.slice(5);
            btn.classList.add("map-pin-plot");
            // Built as an innerHTML string, but MUST emit the same class contract StatusDots.svelte owns (its :global CSS, imported by MapDrawControls, styles this) — sync() toggles --under/--over/--fault on the button to match.
            // Dots anchor to `.map-pin-plot__inner`, NOT the button root — the root is the Mapbox marker and must keep position:absolute or it drifts across the map on zoom.
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
        // Mounts THE EmojiPin component (same one PIN LIBRARY + detail header use) — never re-implement the emoji pin look here.
        const emojiChar = parseEmojiPin(pinTypeKey);
        if (emojiChar) {
            btn.classList.add("map-pin-emoji");
            mount(ports.ui.EmojiPin, {
                target: btn,
                props: { char: emojiChar, size: 30 },
            });
            return btn;
        }
        // Every other icon path comes from the registry in icons.ts, never built here; `tiles` is the reserved system marker, unrecognised keys fall back to `default`.
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
            // Tapping a collapsed stack representative fans it out (spiderfy) first — nothing selects yet; once fanned, taps fall through to normal selection.
            const stackKey = stackByFeature.get(featureKey);
            if (stackKey && !openStacks.has(stackKey)) {
                expandedStack = stackKey;
                reconcileSingles();
                return;
            }
            // Tap the selected pin again → clear the selection (same as tapping empty map).
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
                // CONVENTION: NEVER force a deeper zoom than the user chose on pin tap — only ease IN to PIN_TAP_ZOOM (10z) if farther out, leave alone if already closer. (Was max(cur,16) live/12 offline, which slammed every tap to street level.)
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
        // NaN-CAMERA GUARD — a degenerate camera (zoom===NaN) makes map.getBounds() THROW → red-screen crash; skip sync until it's restored (see mapInit's renderGuard).
        if (!Number.isFinite(map.getZoom())) return;
        const feats = mapStore.features;
        // Honours per-type visibility toggles: `plot:` → `plots`, `tiles` → ALWAYS shown, everything else → `pins`; filtered here so the reconcile below removes their DOM markers.
        const pins = feats.filter(
            (f): f is Feature & { geometry: GeoJSON.Point } => {
                if (f.geometry?.type !== "Point") return false;
                const t = (f.properties?.pinTypeKey as string) ?? "pin";
                if (t === "tiles") return true; // system marker, never hidden
                if (t.startsWith("plot:")) return overlayVisibility.plots;
                return overlayVisibility.pins;
            },
        );

        // Duplicate audit is scoped to ONE survey — different surveys sharing a baked `plot:N` is EXPECTED (merges into 1..N, not flagged); same survey sharing one is a real bug.
        auditDuplicatePlotPins(pins);

        // Only numbered plots go through native clustering — feature pins never bubble (always-on DOM markers), and the selected pin is pulled out too so it always stands alone.
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

    // Reconciles DOM markers to exactly what the clustered source reports as unclustered; runs after sync() and every re-tile — clustering happens in worker tiles, so the answer isn't available synchronously after setData.
    function reconcileSingles() {
        const map = getMap();
        if (!map || !mapStore.ready) return;
        if (!Number.isFinite(map.getZoom())) return;
        if (!map.getSource(CLUSTER_SOURCE)) return;
        // Not yet re-clustered → keep the current markers; the sourcedata listener re-runs this the moment the source settles.
        if (!map.isSourceLoaded(CLUSTER_SOURCE)) return;
        const pins = lastPins;
        // Unclustered = features without point_count; querySourceFeatures only sees loaded viewport tiles, so off-screen pins simply keep no marker.
        const singleKeys = new Set<string>();
        for (const f of map.querySourceFeatures(CLUSTER_SOURCE, {
            filter: ["!", ["has", "point_count"]],
        })) {
            const k = f.properties?.mapFeatureKey as string | undefined;
            if (k) singleKeys.add(k);
        }
        // Feature pins + the selected pin never cluster — they're not in the clustered source at all, so add them back as always-wanted singles.
        for (const k of forcedSingleKeys) singleKeys.add(k);

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
            // Mandatory NaN guard before any Mapbox coord write (see memory `mapbox-camera-via-safeMap`) — letting NaN reach setLngLat/.addTo nulls Mapbox's projection matrix and EVERY subsequent render throws, breaking unrelated features too.
            if (!isFiniteCoord(coords as unknown)) {
                console.warn(
                    `[markers] skipping pin ${fkey} — non-finite coords:`,
                    coords,
                );
                continue;
            }
            const existing = have.get(fkey);

            if (existing) {
                // Position can shift if user moves a feature; type can change via the popover. Update both in place.
                existing.marker.setLngLat(coords);
                if (existing.pinTypeKey !== pinTypeKey) {
                    const newEl = buildPinElement(fkey, pinTypeKey);
                    attachMarkerClick(newEl, fkey);
                    // mapboxgl.Marker doesn't expose a setElement, so swap by replacing the marker entirely.
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

        // Selected plot marker → gold "Plot N" pill; only the selected marker's label/class changes, so this never de-styles the others.
        const selKey = deps.getSelectedKey();
        for (const pm of pinMarkers) {
            if (!pm.pinTypeKey.startsWith("plot:")) continue;
            const el = pm.marker.getElement();
            const isSel = pm.key === selKey;
            el.classList.toggle("map-pin-plot--selected", isSel);
            // pm.key = plot row's gpsFeatureKey → plotByGpsKey resolves the live row, re-checked every sync() so edits/re-flows show live; ports.q704 absent on hosts without inspections → null → baked label.
            const plot = (ports.q704?.plotByGpsKey(pm.key) ?? null) as {
                displayNo?: number | string | null;
            } | null;
            // Label is the plot's per-MAP rank (plot.displayNo), NOT the frozen `plot:N` baked at drop time — re-flows as surveys merge/delete; falls back to baked `plot:N` only if unresolved.
            const numEl = el.querySelector(".map-pin-plot__num");
            if (numEl) {
                const n = String(plot?.displayNo || pm.pinTypeKey.slice(5));
                numEl.textContent = isSel ? `Plot ${n}` : n;
            }
            // Status badges match PlotMapPopover's maths: rose '−' = under spot count, teal '+' = excess trees, red dot = quality fault — all independent, any combination.
            const hasFault = (plot?.faults.length ?? 0) > 0;
            const under = Math.max(0, (plot?.spots ?? 0) - (plot?.planted ?? 0));
            const over = plot?.excess ?? 0;
            el.classList.toggle("map-pin-plot--under", under > 0);
            el.classList.toggle("map-pin-plot--over", over > 0);
            el.classList.toggle("map-pin-plot--fault", hasFault);
        }

        // SELECTION OVERRIDE — any selected pin lifts above the dim veil (owned by MapDrawControls). Toggled every reconcile so deselecting restores everything.
        for (const pm of pinMarkers) {
            pm.marker
                .getElement()
                .classList.toggle("map-pin-marker--selected", pm.key === selKey);
        }

        layoutStacks(selKey);

        placeCaptions(map, selKey);
    }

    // Runs after every marker reconcile (sync, sourcedata settle, moveend) — caption winners re-compete whenever camera or data settles.
    function placeCaptions(map: MapboxMap, selKey: string | null): void {
        const zoom = map.getZoom();
        const zoomOk = Number.isFinite(zoom) && zoom >= PIN_CAPTION_MINZOOM;
        const nameByKey = new Map<string, string>();
        for (const p of lastPins) {
            const k = p.properties?.mapFeatureKey as string | undefined;
            if (k) nameByKey.set(k, String(p.properties?.name ?? "").trim());
        }

        // WRITE pass: builds each caption hidden-but-laid-out for measurement; unnamed pins, `tiles`, and PLOTS (identity is the plaque number) never get one.
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
            // Zoom gate: no captions below it — except the selected pin, which shows regardless of zoom or collisions.
            if (!zoomOk && !isSel) {
                cap.style.display = "none";
                continue;
            }
            cap.style.display = "";
            cap.style.visibility = "hidden";
            candidates.push({ pm, cap, priority: isSel ? 0 : 1 });
        }
        if (candidates.length === 0) return;

        // READ pass — one reflow: caption rects, marker rects, and the tier-1 area-name rects (reserved first; a caption never crowds an area name).
        const capRects = candidates.map(
            (c) => c.cap.getBoundingClientRect() as Rect,
        );
        const markerRects = pinMarkers.map((pm) => ({
            key: pm.key,
            rect: pm.marker.getElement().getBoundingClientRect() as Rect,
        }));
        const placed: Rect[] = getAreaLabelRects(map);

        // PLACE pass — selected pin first, the rest in stable order. Overlap anything already placed or any OTHER marker → drop (no truncation, no nudging).
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
