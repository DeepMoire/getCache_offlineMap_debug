<script lang="ts">

/**
 * OfflineMapPage — THE offline map. One component, every tier mounts it.
 *
 * Served at /offline by this child and by ReTreever. Lived at routes/demo/
 * from 23–28 Aug 2026: it was lifted out of ReTreever as the DEBUG map,
 * named "demo" as the standalone preview, and /offline was bolted on as a
 * wrapper "for now". The engine IS the page, so it lives in lib/ under its
 * real name and routes/ holds only the URL that mounts it.
 *
 * It runs on nothing.
 *
 * THIS PAGE IS THE POINT OF THE MIGRATION. It proves the engine has no hidden
 * ties to ReTreever: no TinyBase, no Supabase, no auth, no mapStore. Its entire
 * "database" is the PINS array below — three literals.
 *
 * A contractor clones rapper, runs `npm run dev`, opens this page, breaks
 * something, and hits `export json` for an AI-debuggable report. None of that
 * needs the private repo.
 *
 * WHAT'S DELIBERATELY MISSING. No `fires` port and no `gps` port, so no hotspots
 * are fetched and there is no live anchor. The engine treats both as valid
 * configurations rather than degraded ones, and their absence here is the
 * demonstration.
 *
 * PINNED TO FIXED LOCATIONS, ON PURPOSE. The tile Worker edge-caches /pack by
 * build, so these few areas stay hot and repeat visits cost ~nothing. A
 * click-anywhere demo would mint uncached packs against a 127 GB archive on
 * every visit — a bill, not a feature. Free-roam belongs behind the local /
 * staging Worker toggles a developer runs themselves (the CONFIG panel).
 */
import type * as maplibreType from "maplibre-gl";
import { onMount } from "svelte";
// THE HAND IS IMPORTED, NOT REQUESTED. `src="/mobileAssets/hand_phoneV3.webp"`
// is a path the BROWSER resolves against whatever server answered — so it only
// finds the file under a host whose static folder happens to hold it, and 404s
// under every other one. An import is resolved by the bundler at BUILD time and
// the bytes are copied into whatever app builds this child.
//
// It comes from `$parent/retreeved/sharedAssets`, not from a copy inside this child. The hand is
// Get Cache's marketing art, and art that names the owner belongs to the parent
// that owns it — a published child carrying its owner's identity is the thing
// CONTRIBUTING.md rules out. The alias is a seam each parent fills for itself,
// so this file names no parent and still resolves under both.
import handPhoneUrl from "$parent/retreeved/sharedAssets/hand_phoneV3.webp";
// The app's OWN grab hand, replacing MapLibre's stock white glove on the map
// canvas. Same seam and same reason as the phone hand above: it is the parent's
// art, so it lives in `retreeved/sharedAssets` (ReTreever owns that folder and
// syncRetreeved.sh carries it to rapper) and the child imports it through the
// alias. ReTreever's SnakeRuler uses the very same file via its own static URL
// `/mobileAssets/...`, which a child cannot use — that path only exists on the
// ReTreever server and 404s in a standalone checkout. Importing it makes the
// bytes part of THIS build, so the cursor is correct in every tier.
// _100 = the 100px-wide cut. A CSS cursor image is IGNORED ENTIRELY above
// ~128px in every browser — no warning, no fallback drawn, you just get the
// stock arrow. The full-size hand_shovel_cursor.webp (24 KB) is over that
// line, which is why the shovel silently vanished. Keep the _100 cut here.
import grabCursorUrl from "$parent/retreeved/sharedAssets/hand_shovel_cursor_100.webp";
import { initializeOfflineMap } from "./onPhone/render/offlineMapInit";
import { buildOfflineBaseStyle } from "./onPhone/render/offlineBaseStyle";
import { v4TransformRequest } from "./r2Worker/local_dev/roads/packDownload";
import {
	installRawWallProtocol,
	rawSourceSpec,
	RAW_SOURCE,
	// BOTH of these are used at onMapReady below and BOTH were missing.
	// The setter was added when `setRawWallBlindHandler is not defined` threw
	// on every load; the handler it is HANDED was left out, so the next load
	// threw `refreshRawTiles is not defined` from inside the callback instead.
	// Half a fix moved the error one frame later — same broken self-heal.
	refreshRawTiles,
	setRawWallBlindHandler,
} from "./onPhone/roads/rawWallProtocol";
import { wallLayers } from "./onPhone/render/wallStyle";
import { createSatelliteMount } from "./onPhone/satellite/mountSatellite";
import { cameraFromUrl } from "./shared/cameraFromUrl";
import { attachDoubleTapToPin } from "./shared/doubleTapToPin";
import { startOfflineBakeService } from "./onPhone/bake/bakeService.svelte";
import { resetCircuits } from "./shared/workMeter.svelte";
import type { HostPorts } from "./shared/hostPorts";
/* THE TIER PILL — ON THE PAGE, because this file IS the page.
   It lived in SharedNav.svelte, which is the NAV. Rendering it there meant it
   only existed where a nav existed, and the two tiers do not render the same
   nav — so the one real tier switch was present on one server and missing on
   the other. Twice it was "moved off the nav" by relocating it within that
   same file, which changed nothing: the file is the nav. It is now mounted
   here, beside the stage, so every tier that serves this page gets it. */
import OfflineWorkMeter from "./shared/OfflineWorkMeter.svelte";
import OfflineBlobPanel from "./panels/OfflineBlobPanel.svelte";
import "./shared/devCard.css";
import OfflineConfigPanel from "./panels/OfflineConfigPanel.svelte";
import PinLibrary from "./panels/PinLibrary.svelte";
import {
	pinAssetPath,
	type PinKey,
} from "./shared/icons";
import { satImageKey } from "./onPhone/satellite/satelliteImage";
import {
	LAYER_TOGGLES,
	OPT_IN_LAYERS,
} from "./onPhone/render/wallLegend";

/** THE ENTIRE DATA LAYER. Add a pin here — or drop one on the map, which
 *  pushes onto this same list through `fixturePorts.addPlace` — and the
 *  engine bakes it. */
const PINS: Array<{ name: string; lngLat: [number, number]; touched?: string }> = [
	{ name: "Ottawa valley", lngLat: [-76.16797958683314, 45.061348227515055] },
	{ name: "Vancouver", lngLat: [-123.1207, 49.2827] },
	{ name: "Prince George", lngLat: [-122.7497, 53.9171] },
];


/**
 * The host ports, implemented with literals. Compare with ReTreever's
 * retreeverPorts.ts: same interface, everything TinyBase-shaped gone.
 */
// hostPorts is a real caller-supplied override — e.g. ReTreever's
// retreeverPorts(), passed by the host page that mounts <Demo hostPorts={...}
// />. When omitted, the literal fixture below stands: the honest answer a
// checkout with no host gives.
const placeListeners = new Set<() => void>();
/**
 * PINS ENDURE. Chris, 28 Aug 2026: "for real we need pins to endure." On
 * ReTreever they live in TinyBase; the fixture has no database, so dropped
 * pins go to localStorage under this key and come back on the next load.
 * The three literals above are the floor — always present, never stored.
 */
const FIXTURE_PINS_KEY = "rt_fixture_pins";
try {
	const raw = localStorage.getItem(FIXTURE_PINS_KEY);
	if (raw) for (const p of JSON.parse(raw) as typeof PINS) PINS.push(p);
} catch {
	// codestyle-allow-swallow: no storage (SSR / private mode) → literals only.
}
const fixturePorts: HostPorts = {
	places: () =>
		PINS.map((p) => ({
			anchors: [p.lngLat],
			// Static demo data never changes, so one fixed timestamp is honest:
			// every pin is equally "recent" and the conveyor has no reason to
			// prefer one over another.
			lastTouched: p.touched ?? "2026-01-01T00:00:00Z",
			corridor: false,
			// Display-only, so the blob panel can name a row instead of printing
			// its areaKey. The bake service ignores every field here.
			featureKey: p.name,
			featureName: p.name,
			featureType: "Point",
			groupKey: "demo",
			groupName: "literal fixture",
		})),
	// A PUSH channel, per hostPorts.ts: fires once on register and on every
	// addPlace. This used to be `() => () => {}` — "nothing ever changes this
	// list" — which was true only because dropping a pin did not write to it.
	onPlacesChanged: (fn) => {
		placeListeners.add(fn);
		fn();
		return () => placeListeners.delete(fn);
	},
	addPlace: (lngLat, name) => {
		PINS.push({ name, lngLat, touched: new Date().toISOString() });
		try {
			localStorage.setItem(FIXTURE_PINS_KEY, JSON.stringify(PINS.slice(3)));
		} catch {
			// codestyle-allow-swallow: storage refused → the pin still bakes this session.
		}
		for (const fn of placeListeners) fn();
	},
	// Hydrated the moment the module evaluates — the array is right there.
	// NOT the same question as "has places"; see hostPorts.ts.
	ready: () => true,
	// No `fires`, no `gps` — both optional, both ReTreever's business.
};

/**
 * IS A HOST LENDING ITS STYLE?
 *
 * The child must not know what a "style flag" is — that is host business. It
 * reads one variable: --host-decor is 1 when a host wants the scenery, absent
 * otherwise. So the DULL version is the default and the art is opt-in, which
 * is the right way round for a debugger: a standalone checkout gets a plain
 * value read-out without having to strip anything away.
 */
let decor = $state(false);
onMount(() => {
	const v = getComputedStyle(document.documentElement)
		.getPropertyValue("--host-decor")
		.trim();
	decor = v === "1";
});

/**
 * TWO VIEWS, ONE PAGE.
 *
 * `rails` is the difference between the debugger and the plain offline map:
 * the map, the engine and the fixtures are identical, and only the two debug
 * panels come and go. A second page would mean a second copy of the engine
 * wiring, which is the thing that drifts.
 */
let {
	/**
	 * ⛔ DEFAULTS OFF. It used to default TRUE, which meant a route that said
	 * nothing got the debugger — so /offline showed instrument panels and
	 * /offline/debug showed the same thing, and the two urls were identical
	 * for the wrong reason. Panels are opt-IN: a route that wants them says
	 * so, and the plain map is what you get by default. */
	rails = false,
	/**
	 * THE INSTRUMENT PANELS. Alias of `rails`, and the name ReTreever's two
	 * routes pass — /offline renders this component bare, /offline/debug
	 * renders it with `cards`. ONE WORD is the whole difference between the
	 * map and the debugger.
	 *
	 * ⛔ Two names, one flag, deliberately: `rails` is what the layout CSS has
	 * always called them and renaming it would touch every rule; `cards` is
	 * what a route reads. A second boolean would be a second source of truth
	 * for the same question — the exact mistake that produced two offline maps
	 * (ReTreever's 1,702-line copy, deleted 27 Aug 2026).
	 */
	cards,
	hostPorts,
	/**
	 * THE PHONE RIG IS FOR A HOST THAT HAS NO PHONE. Standalone (rapper) this
	 * component IS the phone: the 452×936 rig, the hand, the gold bezel, the
	 * rails either side. A host that already draws a phone around its routes
	 * — ReTreever's (getcache) shell — passes `framed={false}` and the rig
	 * collapses to "fill the box I was given": no bezel, no hand, no scale,
	 * and the rails become an overlay inside that box. Without it you get a
	 * phone inside a phone, orange edge and all (seen 28 Aug 2026).
	 * Same shape as `rails`: one component, one boolean, the host decides.
	 */
	framed = true,
	/**
	 * WHERE THE DEV CHROME GOES. The `debug` toggle is transient — they exist in `vite dev` and must
	 * not ship. Their DATA is this component's (layers, blobs, dropped pins,
	 * wall status), so they stay owned here; but their PLACE is the host's.
	 * A page hands in an element — the content box of an EphemeralCard from
	 * `$parent/retreeved/sharedComponents/effemeralCard` — and the nodes are
	 * moved into it, wiring, state and scoped styles intact. Absent, they sit
	 * on the stage as before, which is what a standalone rapper checkout gets.
	 */
	debugHost,
	/**
	 * WHERE THE RAILS GO. Separate from `debugHost` because they are a
	 * different kind of thing: the tray holds chrome every page has; the
	 * rails are this map's own instruments and are large. A page gives each
	 * an EphemeralDock (same folder as the card). Unset, the panels have
	 * nowhere to go and are not laid out — every tier passes both.
	 */
	railLeftHost,
	railRightHost,
}: {
	rails?: boolean;
	cards?: boolean;
	hostPorts?: HostPorts;
	framed?: boolean;
	debugHost?: HTMLElement;
	railLeftHost?: HTMLElement;
	railRightHost?: HTMLElement;
} = $props();

/**
 * PORTAL — move a node into `target`, follow it if it changes, put nothing
 * back on destroy (Svelte tears the node down itself). A no-op without a
 * target, so every `use:portal` below is inert until a host asks.
 */
function portal(node: HTMLElement, target?: HTMLElement) {
	if (target) target.appendChild(node);
	return {
		update(next?: HTMLElement) {
			if (next) next.appendChild(node);
		},
		destroy() {
			node.remove();
		},
	};
}

/**
 * THE DEBUG PANELS. One boolean. A button flips it.
 *
 * That is the entire mechanism, and it replaces two routes, a redirect, a
 * url-param reader, a popstate listener, a window event and a nav bridge —
 * all of which existed to make a NAVIGATION behave like a toggle. A boolean
 * is a toggle. Nothing navigates, so the map is never rebuilt, the camera
 * cannot jump, and no pin can vanish. The debugger IS the map with this true.
 *
 * `cards`/`rails` still seed it, so a host that mounts <Demo cards /> opens
 * with the panels up, exactly as before.
 */
/**
 * STICKY, DEFAULT OPEN. Chris, 28 Aug 2026: "can it default to sticky
 * debugger open/closed status instead of having to open it every time."
 * The last toggle wins across reloads (localStorage); with nothing stored
 * the panels are OPEN — this is the debugger, hiding it by default made
 * every session start with a click. Dev-only chrome, so this never ships.
 */
const PANELS_KEY = "rt_offline_panels";
function readPanels(): boolean {
	try {
		const v = localStorage.getItem(PANELS_KEY);
		if (v === "0") return false;
		if (v === "1") return true;
	} catch {
		// codestyle-allow-swallow: no storage (SSR / private mode) → default.
	}
	return cards ?? rails ?? true;
}
let showPanels = $state(readPanels());
$effect(() => {
	try {
		localStorage.setItem(PANELS_KEY, showPanels ? "1" : "0");
	} catch {
		// codestyle-allow-swallow: storage refused → the toggle still works this session.
	}
});

/**
 * THE PORTS, RESOLVED ONCE — the map is the SAME MAP on every tier.
 *
 * `hostPorts ?? fixturePorts` used to be written out at all THREE call sites
 * (the bake service, the marker loop, the blob panel). Three copies of one
 * decision is three chances for them to disagree, and the visible symptom was
 * the one that mattered: the same url on two servers drew different pins, so
 * "/offline and /offline/debug are the same page" stopped being believable.
 *
 * Resolved here, once, and read everywhere. A tier that supplies ports gets
 * its own data; a tier that supplies none gets the fixtures — but whatever it
 * gets, EVERY part of the page gets the same one.
 */
const ports = $derived(hostPorts ?? fixturePorts);

let activePin = $state("pin");

/** Pins dropped this session — the MARKER side only (which artwork, which
 *  one is selected). The PLACE side goes through `ports.addPlace()` at the
 *  drop, so the host keeps it and the bake is asked for it. This list used to
 *  be the only record of a drop ("this page has no database"), which is why a
 *  dropped pin downloaded nothing — see HostPorts.addPlace. */
let dropped = $state<Array<{ lng: number; lat: number; pin: string }>>([]);
let markers: unknown[] = [];

/** THE SELECTED PIN — index into `dropped`, or null for none. Tapping a marker
 *  selects it and opens the library popover ON THE MAP, anchored under that
 *  pin, exactly as the app's feature popover behaves. */
let selectedIdx = $state<number | null>(null);
/** Where to draw the popover, in PIXELS inside the map canvas. Recomputed as
 *  the map moves so the card tracks its pin instead of drifting off it. */
let popAt = $state<{ x: number; y: number } | null>(null);

/** Project the selected pin to screen space. Called on every map move — the
 *  card is a plain DOM element, so nothing repositions it for us. */
function syncPopover(): void {
	if (selectedIdx === null || !mapInstance) {
		popAt = null;
		return;
	}
	const d = dropped[selectedIdx];
	if (!d) {
		popAt = null;
		return;
	}
	const p = mapInstance.project([d.lng, d.lat]);
	popAt = { x: p.x, y: p.y };
}

/** Re-point the selected pin at a new artwork. Updates the marker element in
 *  place — cheaper than tearing the marker down, and it keeps the popover
 *  anchored while the pin changes underneath it. */
function changeSelectedPin(key: string): void {
	if (selectedIdx === null) return;
	dropped[selectedIdx].pin = key;
	const m = markers[selectedIdx] as { getElement?: () => HTMLImageElement };
	const el = m?.getElement?.();
	if (el) el.src = pinAssetPath(key as PinKey);
}

let mapContainer: HTMLDivElement;
let phoneEl = $state<HTMLDivElement>();

/**
 * THE RAILS FILL EDGE-TO-PHONE. Chris, 28 Aug 2026, "for the 400th time":
 * the docks were a fixed `min(28vw, 420px)` — a NUMBER where "the distance to
 * the phone" belongs — so a dead strip sat between cramped panels and the
 * phone at every window size. The phone is drawn by a transform (see .rig's
 * --fit), so its on-screen edge cannot be written as CSS; it is MEASURED here
 * and published on :root as --dock-width-left / --dock-width-right, which the
 * shared dock and tray read. 12px at the viewport edge, 15px at the phone.
 */
/** Viewport edge → panel: the dock's own `left/right: 12px`. Panel → phone:
 *  a touch wider, so the panel edge does not read as part of the bezel. */
const EDGE_GUTTER = 12;
const PHONE_GUTTER = 15;
function publishDockWidths(el: HTMLElement) {
	const root = document.documentElement.style;
	const apply = () => {
		const r = el.getBoundingClientRect();
		const left = Math.max(0, r.left - EDGE_GUTTER - PHONE_GUTTER);
		const right = Math.max(0, window.innerWidth - r.right - EDGE_GUTTER - PHONE_GUTTER);
		root.setProperty("--dock-width-left", `${Math.round(left)}px`);
		root.setProperty("--dock-width-right", `${Math.round(right)}px`);
	};
	apply();
	const ro = new ResizeObserver(apply);
	ro.observe(el);
	ro.observe(document.documentElement);
	window.addEventListener("resize", apply);
	return () => {
		ro.disconnect();
		window.removeEventListener("resize", apply);
		root.removeProperty("--dock-width-left");
		root.removeProperty("--dock-width-right");
	};
}
$effect(() => (phoneEl ? publishDockWidths(phoneEl) : undefined));
let detachTap: (() => void) | undefined;

/** Paint one dropped pin. A plain DOM marker — the artwork is a .webp, and the
 *  anchor is BOTTOM so the point of the pin sits on the coordinate, not its
 *  middle. */
function addMarker(
	map: maplibreType.Map,
	lng: number,
	lat: number,
	pin: string,
): void {
	const el = document.createElement("img");
	el.src = pinAssetPath(pin as PinKey);
	el.style.cssText = "width:34px;height:auto;display:block;cursor:pointer";
	// TAP A PIN → select it and open the library over the map. stopPropagation
	// so the map's own click handler doesn't immediately deselect it.
	const myIndex = dropped.length - 1;
	el.addEventListener("click", (ev) => {
		ev.stopPropagation();
		selectedIdx = myIndex;
		syncPopover();
	});
	// ⚠️ NEVER `new maplibregl.Marker(...)` — the namespace-qualified form binds
	// this child to one GL library, and a Mapbox Marker attached to a MapLibre
	// map throws `_addMarker` / `_requestDomTask` (and vice versa). That is the
	// bug rendererMixing.test.ts exists to catch.
	//
	// DESTRUCTURE instead, which is the pattern that guard calls correct (see
	// fireLayer). The child cannot use ReTreever's markerCtor() seam — $lib is
	// tier 1, and a child must stand alone — and MapLibre's Map class exposes no
	// static .Marker, so the module's own export is the honest source.
	import("maplibre-gl").then(({ Marker }) => {
		markers.push(
			new Marker({ element: el, anchor: "bottom" })
				.setLngLat([lng, lat])
				.addTo(map),
		);
	});
}
let mapError = $state("");
let wallStatus = $state("wall not mounted yet");
/** WHERE THE MAP OPENED, as a string on the SCREEN — not in the console.
 *  A URL camera that only reports itself to devtools is indistinguishable
 *  from one that was ignored: you paste a coordinate, the map shows blank
 *  because nothing is baked there, and "it moved" and "it did nothing" look
 *  identical. This badge is the difference, and it renders on BOTH routes
 *  (outside `{#if showPanels}`) because /offline is where you actually paste. */
let cameraBadge = $state("");

// Layer toggles, driving the CONFIG panel's `layers` section. Same shape the
// real /offline route passes, so the panel behaves identically here.
const layerOn = $state<Record<string, boolean>>(
	Object.fromEntries(
		LAYER_TOGGLES.map((t) => [t.key, !OPT_IN_LAYERS.includes(t.key)]),
	),
);
let mapInstance: maplibreType.Map | null = null;
/** Name of the row OfflineBlobPanel currently exports — see its onFocusedName
 *  doc. Forwarded into OfflineWorkMeter so the export button's sub-label
 *  always names the SAME area export json actually exports. */
let focusedBlobName = $state<string | null>(null);

/** Show/hide a layer group. Mirrors the real /offline route's local helper,
 *  including the Satellite special case: that toggle owns every per-pin photo
 *  layer (`v4-sat-*`), which reconcile mounts dynamically, so they get swept
 *  too or half the imagery stays visible after switching it off. */
function setLayerVisibility(ids: readonly string[], visible: boolean): void {
	if (!mapInstance) return;
	const vis = visible ? "visible" : "none";
	for (const id of ids) {
		if (mapInstance.getLayer(id))
			mapInstance.setLayoutProperty(id, "visibility", vis);
		if (id === "v4-sat") {
			for (const l of mapInstance.getStyle?.()?.layers ?? []) {
				if (typeof l.id === "string" && l.id.startsWith("v4-sat-"))
					mapInstance.setLayoutProperty(l.id, "visibility", vis);
			}
		}
	}
}

function toggleLayer(key: string, ids: readonly string[]): void {
	layerOn[key] = !layerOn[key];
	setLayerVisibility(ids, layerOn[key]);
}

const layers = $derived(
	LAYER_TOGGLES.map((t) => ({
		key: t.key,
		label: t.label,
		// The mechanism hint travels WITH the row. Declared once in
		// wallLegend.ts beside the ids it describes, so a layer that changes
		// how it draws changes its hint in the same edit.
		hint: t.hint,
		on: layerOn[t.key],
		toggle: () => toggleLayer(t.key, t.ids),
	})),
);

onMount(() => {
	const stopBake = startOfflineBakeService(ports);
	let cleanup: (() => void) | undefined;
	let satMount: ReturnType<typeof createSatelliteMount> | undefined;
	let satPoll: ReturnType<typeof setInterval> | undefined;
	try {
		// WHERE THE MAP OPENS. A coordinate in the query string wins over the
		// fixture, so `?=58.7986,-122.6761` points BOTH routes at the same
		// spot — see cameraFromUrl.ts. Absent, the first fixture pin stands.
		const urlCam = cameraFromUrl(location.search);
		// The badge states WHICH source won, always — "from the URL" vs the
		// fixture default. Reporting only the success case would leave the
		// ignored-param case silent, which is the case worth seeing.
		cameraBadge = urlCam
			? `${urlCam.center[1]}, ${urlCam.center[0]}` +
				`${urlCam.zoom !== undefined ? ` · z${urlCam.zoom}` : ""} · from the URL`
			: `${PINS[0].lngLat[1]}, ${PINS[0].lngLat[0]} · z9 · default (no coords in URL)`;
		if (urlCam)
			console.info(
				`[map] opening at ${urlCam.center[1]},${urlCam.center[0]}` +
					`${urlCam.zoom !== undefined ? ` z${urlCam.zoom}` : ""} (from the URL)`,
			);
		cleanup = initializeOfflineMap(mapContainer, {
			style: buildOfflineBaseStyle() as maplibreType.StyleSpecification,
			initialCenter: urlCam?.center ?? PINS[0].lngLat,
			initialZoom: urlCam?.zoom ?? 9,
			// LAW 0, at the renderer's own door: every non-local URL is rejected,
			// so the map CANNOT stream even if a style entry tried to.
			transformRequest:
				v4TransformRequest as maplibreType.RequestTransformFunction,
			onMapCreated: (map: maplibreType.Map) => {
				// OUR OWN handle. __rtMap is set by the initializer and survives a
				// teardown, so probing it can read a DEAD map from a previous mount
				// — which is exactly what made this bug unreadable for an hour.
				(window as unknown as Record<string, unknown>).__debugMap = map;
				wallStatus = "onMapCreated fired";
				// DIAGNOSTIC: onMapReady waits on the `load` event, and load waits
				// on every source settling. Report what the map is actually doing
				// so a stall is visible instead of looking like a blank page.
				map.on("error", (e) =>
					console.error("[debug/map] map error", e?.error ?? e),
				);
				map.once("styledata", () => (wallStatus = "styledata fired"));
				map.once("load", () => (wallStatus = "load fired"));
				// DIAGNOSTIC: prove whether MapLibre applies ANY style here. If a
				// bare background style also fails, the problem is the renderer in
				// this repo, not our offline style.
				setTimeout(() => {
					if (map.isStyleLoaded()) return;
					wallStatus = `STALLED · style._loaded=${
						(map as unknown as { style?: { _loaded?: boolean } }).style?._loaded
					} · sheet=${
						(map as unknown as { style?: { stylesheet?: unknown } }).style
							?.stylesheet
							? "set"
							: "null"
					}`;
				}, 4000);
			},
			onMapReady: (map: maplibreType.Map) => {
				mapInstance = map;
				// THE WALL MAP. Without this the only source on the map is the
				// bundled world base (z0-6) — a couple of highways and a lake —
				// and every byte the bake downloaded sits in IndexedDB unread.
				// That is exactly what "the map looks empty" was.
				//
				// Protocol FIRST, so the first tile request resolves; it and the
				// source add are both idempotent.
				// LONG-PRESS / DOUBLE-TAP TO DROP. The gesture module's map type is
				// structural and written for both renderers, so the MapLibre map
				// satisfies it unchanged.
				// ⚠️ onMeasureSeed, NOT onDrop. In the app a double-tap SEEDS THE
				// SNAKE RULER, and the ruler's own Save button is what drops a pin
				// — this module declares `onDrop` but never calls it. Without the
				// ruler here, the seed IS the drop.
				// THE CARD IS PLAIN DOM, so nothing moves it when the map moves.
				// Re-project on every camera change, and dismiss on a click that
				// wasn't a marker (markers stopPropagation above).
				map.on("move", syncPopover);
				map.on("zoom", syncPopover);
				/**
				 * THE ADDRESS BAR FOLLOWS THE MAP — the missing half of the camera.
				 *
				 * cameraFromUrl has always READ ?at=; nothing ever WROTE it. So the
				 * only way to get a shareable coordinate was to hand-type one into
				 * the address bar — exactly the chore the feature exists to remove.
				 * Pan or zoom now and the url updates itself, so the url in front of
				 * you is always the url that reproduces what you are looking at.
				 *
				 * `moveend`, not `move`: one write per gesture instead of one per
				 * frame. `replaceState`, not `pushState`: panning must not stack
				 * hundreds of entries that the back button then has to walk.
				 *
				 * lat,lng — human order, matching what cameraFromUrl parses, so the
				 * url it writes is one it can read back. 6dp ≈ 0.1 m; more is noise.
				 */
				const writeCameraToUrl = () => {
					const c = map.getCenter();
					const at = `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`;
					const z = map.getZoom().toFixed(2);
					history.replaceState(history.state, "", `?at=${at}&z=${z}`);
					cameraBadge = `${at} · z${z}`;
				};
				// ON LOAD, NOT JUST ON MOVE. Writing only from `moveend` meant a
				// freshly-opened page had a BARE url until you happened to drag —
				// so the feature looked absent exactly when you went to check it,
				// which is the whole reason it kept reading as "gone again".
				// The url must describe the view from the first frame.
				writeCameraToUrl();
				map.on("moveend", writeCameraToUrl);
				map.on("click", () => {
					selectedIdx = null;
					popAt = null;
				});

				detachTap = attachDoubleTapToPin(map, {
					onDrop: () => {},
					onMeasureSeed: (lng: number, lat: number) => {
						dropped = [...dropped, { lng, lat, pin: activePin }];
						addMarker(map, lng, lat, activePin);
						// THE ASK. Circles go grey (this pin, not the last one), then
						// the host keeps the place → onPlacesChanged → the bake requests
						// it → yellow → green/red. A host with no addPlace gets told,
						// because a silent no-op here is the exact bug this replaces.
						resetCircuits();
						if (ports.addPlace) {
							ports.addPlace(
								[lng, lat],
								`${activePin} ${lng.toFixed(4)},${lat.toFixed(4)}`,
							);
						} else {
							console.warn(
								"[offline] pin dropped but this host has no addPlace port — nothing will be downloaded for it.",
							);
						}
					},
				});

				try {
					if (!map.getSource(RAW_SOURCE)) {
						installRawWallProtocol();
						// ⛔ WIRE THE SELF-HEAL, OR IT IS A SPECTATOR.
						//
						// rawWallProtocol detects "asking, finding nothing" and calls
						// onBlind — but NOTHING EVER SET IT. MEASURED 27 Aug 2026 in a
						// live browser with a pack successfully stored (`1 area · 574
						// KB`): "[roads] ⚠️ map is reading NOTHING from disk (4 tiles
						// asked, 0 found)". The detector fired, narrated, and did
						// nothing, because `setRawWallBlindHandler` had no callers
						// anywhere in the repo — its own comment says "Set by the
						// route", and the route never did.
						//
						// The cause is a race, not an address bug: MapLibre requests
						// tiles before the download lands, caches the 404s, and then
						// STOPS ASKING — so it can never recover however long you
						// wait. That is the whole "it works sometimes" pattern; it
						// depends only on whether the pack beat the first render.
						// (A write→read round trip over the real key functions passes
						// at every rendered zoom — see readWriteRoundTrip.test.ts — so
						// the addresses were never the problem.)
						//
						// refreshRawTiles is the narrow fix: setTiles with the same URL
						// invalidates the tile cache and nothing else. Do NOT re-add
						// the source or the layers here — that rebuilds the stack and
						// drops the per-pin satellite layers.
						setRawWallBlindHandler(() => refreshRawTiles(map));
						map.addSource(RAW_SOURCE, rawSourceSpec());
						for (const layer of wallLayers()) map.addLayer(layer);
					}

					// ── THE SATELLITE PHOTOS ─────────────────────────────
					// ⛔ THIS PAGE RENDERED NO SATELLITE FOR DAYS while
					// ReTreever's /offline rendered it fine, because the
					// mount lived inline in THAT page and nowhere else. The
					// debugger showed different pixels than the map it
					// debugs. See mountSatellite.ts. One copy, both pages.
					satMount = createSatelliteMount(map);
					const showPhotos = async (): Promise<void> => {
						let shown = 0;
						for (const p of ports.places())
							for (const c of p.anchors) {
								await satMount?.display(c);
								if (satMount?.mounted().has(satImageKey(c))) shown++;
							}
						// LOUD either way — "no photo on disk yet" and "the
						// mount is missing" look identical on a black map,
						// and only one of them is a bug.
						console.info(
							`[sat] ${shown} photo(s) on the map` +
								(shown === 0 ? " — nothing baked here yet" : ""),
						);
					};
					void showPhotos();
					// Re-check after the bake conveyor has had a pass: a
					// photo that lands 30 s in must still appear without a
					// reload.
					satPoll = setInterval(() => void showPhotos(), 20000);

					wallStatus = `wall ok · ${map.getStyle().layers.length} layers`;
				} catch (err) {
					// LOUD, not swallowed: a wall map that fails to mount is the
					// difference between "the offline map works" and a page that
					// looks fine and shows nothing. [[no-silent-fallbacks]]
					wallStatus = `wall FAILED: ${err instanceof Error ? err.message : String(err)}`;
					console.error("[debug/map] wall mount failed", err);
				}
			},
		});
	} catch (err) {
		mapError = err instanceof Error ? err.message : String(err);
	}
	return () => {
		detachTap?.();
		clearInterval(satPoll);
		// Revoke every photo object-URL. Without this each unmount strands
		// the blob in memory — the steady RAM climb.
		satMount?.dispose();
		cleanup?.();
		stopBake();
	};
});
</script>

<!-- No <title> here: naming the page is the HOST's job. A child that titled
     itself would fight whatever surrogate parent mounts it, and would carry a
     hard-coded product name into a repo meant to be handed out. -->

<!-- --grab-cursor carries the COMPLETE url() token (see .map-canvas rules):
     the bundler rewrites `grabCursorUrl` to the built asset path, so the cursor
     resolves in every tier without any tier-specific URL in the CSS. -->
<div class="stage" class:unframed={!framed} style="--grab-cursor: url({grabCursorUrl});">
	<!-- THE CAMERA BADGE. OUTSIDE {#if showPanels} on purpose: /offline is the route
	     you paste a coordinate into, and it is the route with no rails to
	     report anything. Both routes therefore answer "did my URL land?" the
	     same way, which is the same reason they share this one component. -->


	<!-- LEFT RAIL — ONE component. Both read-outs live inside it so they share a
	     stacking context and can never drift apart or slide under the hand. It
	     sits 15px clear of the phone — see .stage's gap and, more importantly,
	     the margin-inline on .rig that makes that 15px real. -->
	{#if showPanels}
	<aside class="rail left" use:portal={railLeftHost}>
		<!-- LEFT: what this SESSION is doing (meter) and how it is set (config).
		     RIGHT: what is on DISK (blobs), full height — it is the long list.
		     Swapped 28 Aug 2026: the blobs list was crammed under the meter. -->
		<OfflineWorkMeter
			docked
			route="debug/map"
			pins={PINS.map((p) => ({ lng: p.lngLat[0], lat: p.lngLat[1] }))}
			{layers}
			{focusedBlobName}
		/>
		<OfflineConfigPanel {layers} />

		<!-- ONE pin library, not two. The NEXT PIN picker used to live here, but
		     nobody thinks to arm a pin BEFORE dropping it — you drop, then you
		     change it. The library on the map (above) does that, so this one was
		     a second way to do the same thing, competing with it. -->
		<div class="pin-box dev-card">
			<div class="pin-note">
				{dropped.length} dropped · session only, no database
			</div>
			<p class="wall-status">{wallStatus}</p>
		</div>
	</aside>
	{/if}

	<!-- CENTRE — the phone in the hand, fitted to the viewport exactly as the
	     app's own frame is (see .rig's --fit). -->
	<div class="rig">
		<!-- The hand is scenery, so it is opt-IN: only a host lending its style
		     asks for it. Without one the phone stands on plain black, which is
		     what a value-only demo should look like. -->
		{#if decor && framed}
			<img
				class="hand"
				src={handPhoneUrl}
				alt=""
				draggable="false"
			/>
		{/if}
		<div class="phone" bind:this={phoneEl}>
		<!-- ⛔ INSIDE THE PHONE, not fixed to the viewport. Both of these were
		     `position: fixed; top: 8px` — which is the PARENT'S HEADER. The nav
		     bar (67px tall under rapper) painted over them, so the button was
		     unclickable and the badge invisible, on every tier, and nobody
		     could say why. Measured 28 Aug 2026 with elementFromPoint: the tier
		     pill was on top. Anchored to the phone they sit on the map, in the
		     child's own space, where no parent chrome can reach. -->
		<button
			type="button"
			class="debug-toggle"
			use:portal={debugHost}
			class:on={showPanels}
			aria-pressed={showPanels}
			onclick={() => (showPanels = !showPanels)}
		>debug</button>
		{#if cameraBadge}
			<output class="camera-badge" aria-live="polite">{cameraBadge}</output>
		{/if}
			{#if mapError}
				<div class="map-error">
					<p>Map unavailable</p>
					<p class="detail">{mapError}</p>
				</div>
			{/if}
			<div bind:this={mapContainer} class="map-canvas"></div>
			
			<!-- THE PIN LIBRARY, ON THE MAP. Anchored under the selected pin and
			     re-projected on every camera move, so it behaves like the app's
			     feature popover rather than a panel off to one side. -->
			{#if selectedIdx !== null && popAt}
				<div
					class="map-popover"
					style="left:{popAt.x}px; top:{popAt.y}px"
					role="dialog"
					aria-label="Pin library"
				>
					<div class="map-popover__hdr">
						<img
							class="map-popover__glyph"
							src={pinAssetPath(dropped[selectedIdx].pin as PinKey)}
							alt=""
						/>
						<div class="map-popover__title">
							{dropped[selectedIdx].pin}
						</div>
						<button
							class="rt-popover-close"
							aria-label="Close"
							onclick={() => {
								selectedIdx = null;
								popAt = null;
							}}>✕</button
						>
					</div>
					<PinLibrary
						selected={dropped[selectedIdx].pin}
						onChange={changeSelectedPin}
					/>
				</div>
			{/if}
		</div>
	</div>

	<!-- RIGHT RAIL — ONE component, mirroring the left. -->
	{#if showPanels}
	<aside class="rail right" use:portal={railRightHost}>
		<OfflineBlobPanel
			places={ports.places()}
			areaKeyOf={satImageKey}
			onFocusedName={(name) => (focusedBlobName = name)}
		/>
	</aside>
	{/if}
</div>

<style>
	
	/* THE CAMERA BADGE — fixed to the viewport, not the stage, so it cannot be
	   pushed off by a rail's flex-grow (see .rail) and reads the same on both
	   routes. pointer-events:none keeps it from ever eating a map drag. */
	.debug-toggle {
		position: absolute;
		/* The phone's top edge sits UNDER the parent's nav (67px on rapper).
		   Clear it, or the button is clickable but half-hidden. */
		top: 40px;
		right: 12px;
		z-index: 50;
		padding: 4px 12px;
		border: 1px solid #555;
		border-radius: 999px;
		background: rgb(0 0 0 / 0.78);
		color: #ddd;
		font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		cursor: pointer;
	}
	.debug-toggle.on {
		background: #e8b923;
		border-color: #e8b923;
		color: #111;
	}

	.camera-badge {
		position: absolute;
		top: 40px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgb(0 0 0 / 0.78);
		color: #fff;
		font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
		pointer-events: none;
	}

:global(html),
:global(body) {
	margin: 0;
	height: 100%;
	background: #000;
	overflow: hidden;
}

/* THE STAGE — fills the SLOT ITS HOST GAVE IT, not the viewport.
   `container-type: size` is what makes 100cqh below resolve against THIS box,
   which is how the phone gets fitted to the space available. */
.stage {
	/* absolute, NOT fixed. This is the whole header/footer fix.
	   `fixed` anchors to the VIEWPORT, so the stage covered the host's top bar
	   and tab bar no matter what either of them did — the debugger sat ON TOP
	   of the chrome instead of between it. `absolute` anchors to the nearest
	   positioned ancestor instead: mounted in ReTreever that is
	   `.mobile-content` (flex:1, position:relative — the box BETWEEN
	   TopBarMobile and TabBarMobile), and standalone it is the body. One rule,
	   correct in both tiers, because the host's own flexbox has already done
	   the measuring.
	   This DELETES the --host-chrome workaround rather than extending it: that
	   var subtracted the header's height from the top and hardcoded 0 for the
	   bottom, so a footer could never be accounted for at all — and it only
	   worked while the child's guess about the host's bar stayed in sync with
	   the host. A child that fills its slot needs no such guess. */
	position: absolute;
	inset: 0;
	container-type: size;
	display: flex;
	/* Rails hang from the TOP so the read-outs start where the eye does; the rig
	   re-centres itself below. Centring the whole row instead left both panels
	   floating in the middle of the stage with the map beside them. */
	align-items: flex-start;
	/* NOT space-between, and NOT any other free-space distribution. Those make
	   the rail-to-phone gap a RESIDUAL — whatever width is left over after the
	   row is laid out — which is why every previous attempt to shrink it by
	   editing `gap` did nothing: `gap` is a MINIMUM separation, and
	   space-between is free to exceed it, which it does on every viewport
	   wider than the row's content. Measured 27 Aug 2026: gap read 5px in the
	   CSS while the rendered distance was 80px.
	   The rails flex-grow instead (see .rail), so there IS no leftover width to
	   distribute, and the gap below is the whole and only separation. */
	justify-content: center;
	/* THE gap — the real one, now that nothing can add to it. 15px between each
	   rail and the phone. The rails are dense read-outs, not framing, so every
	   extra pixel between them and the phone is width the CONFIG/MEMORY panels
	   could be using instead. This value is only trustworthy because the rails
	   grow to eat the slack; restore any free-space justify-content above and
	   this number becomes decorative again. */
	gap: 15px;
	/* STYLE OFF is the DEFAULT here: plain black, no scenery. The host opts
	   INTO the art by setting --host-decor: 1, which is only true when a
	   parent is lending its style. A debugger should look like a value
	   read-out, not a poster — and a standalone checkout gets the dull
	   version without having to strip anything. */
	background: #000;
	background-image: var(--demo-backdrop, none);
	background-position: center;
	background-size: cover;
	background-repeat: no-repeat;
	color: #d8d4c8;
	font-family: ui-monospace, monospace;
}

/* The rails fill edge-to-phone: the phone's on-screen edges are MEASURED
   (see publishDockWidths in the script) and published as
   --dock-width-left/right, which EphemeralDock and EphemeralCard read. */

/* .rail / .rail.left used to lay the two rails out either side of the phone
   on the stage. Every tier now hands them to an EphemeralDock (see the
   railLeftHost / railRightHost props), so the stage never lays them out. */
.rail {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

/* ── THE RIG ─────────────────────────────────────────────────────────────
   Geometry hand-tuned against hand_phoneV3.webp; do NOT re-derive. --fit is the
   app's own crop rule: shrink the whole assembly by (stage height ÷ phone
   height), capped at 1, so the phone always fills the viewport top-to-bottom
   without the art reflowing (it cannot). */
.rig {
	/* The rig is the only thing that centres — align-self, not the row. */
	align-self: center;
	--phone-width: 452px;
	--phone-height: 936px;
	--hand-width: 1484px;
	--hand-left: -673px;
	--hand-top: -51px;
	--hand-stretch: 1.023;
	--stage-pad: 20px;
	--fit: min(1, calc((100cqh - var(--stage-pad)) / var(--phone-height)));

	position: relative;
	z-index: 2;
	flex: 0 0 auto;
	width: var(--phone-width);
	height: var(--phone-height);
	transform: scale(var(--fit));
	transform-origin: center center;

	/* THE PHANTOM WIDTH — the actual source of the "crazy padding", found by
	   measuring the live page on 27 Aug 2026 rather than reading this file.
	   `transform: scale()` shrinks what the rig PAINTS but not what it
	   RESERVES: the box still occupies var(--phone-width) (452px) of layout
	   while drawing only 452 * --fit. At --fit 0.669 that is 149px of reserved
	   but permanently empty space, which flex splits evenly onto both sides —
	   74.7px per side, on top of whatever `gap` says. Measured: gap read 15px,
	   rendered distance 89.7px, and 89.7 - 15 = 74.7 exactly.
	   That is why editing `gap`/`padding` never worked and could never have
	   worked; neither property can reach space that lives INSIDE the rig's own
	   layout box. Pulling the two sides in by half the shortfall each collapses
	   the layout box onto the painted box, so `gap` finally means what it says.
	   The visual scaling is untouched — the hand-tuned geometry above is not
	   re-derived, only the dead space around it is reclaimed. */
	margin-inline: calc(-0.5 * var(--phone-width) * (1 - var(--fit)));
}
.hand {
	position: absolute;
	z-index: 2;
	max-width: none;
	width: var(--hand-width);
	height: auto;
	left: var(--hand-left);
	top: var(--hand-top);
	transform: scaleX(var(--hand-stretch));
	transform-origin: center top;
	pointer-events: none;
	user-select: none;
}
.phone {
	position: absolute;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	background: #05101f;
	border-radius: 40px;
	/* With the hand hidden the phone has no edge, so it needs its own. Gold,
	   3px, matching the rapper bar's rule — the one deliberate bit of colour
	   in the dull view. A host that supplies the hand sets --demo-bezel:none
	   so the artwork provides the edge instead of doubling it. */
	outline: var(--demo-bezel, 3px solid #f5a119);
	outline-offset: -1px;
}
.map-canvas {
	position: absolute;
	inset: 0;
}
/* UNFRAMED — the host already owns the phone (see the `framed` prop). The rig
   stops being a fixed-size scaled prop and becomes the whole stage; bezel and
   hand go with it; the rails slide over the map instead of standing beside
   it, because a 452px screen has no "beside". Same map, same panels, same
   camera. */
.stage.unframed {
	background: none;
	background-image: none;
	gap: 0;
}
.stage.unframed .rig {
	align-self: stretch;
	flex: 1 1 auto;
	width: auto;
	height: auto;
	transform: none;
	margin-inline: 0;
}
.stage.unframed .phone {
	border-radius: 0;
	outline: none;
}
/* THE GRAB HAND. MapLibre ships a stock white glove for `grab`/`grabbing`,
   which reads as "generic web map" — the opposite of what this demo is for.
   These override its canvas cursors with the app's own hand.
   `11 5` is the hotspot (the fingertip), matching SnakeRuler.svelte so the
   pointer lands in the same place here as it does in the real app — a cursor
   whose hotspot disagrees between two screens feels broken even when nobody
   can say why. The trailing `grab`/`grabbing` are the fallbacks for the moment
   before the image loads, or if it ever fails to.
   `--grab-cursor` carries the WHOLE `url(...)` token, set from the import on
   .stage below. `url(var(--x))` does not work — the var has to supply the
   complete function, not just its argument.
   `:global` because the canvas and its container are MapLibre's own elements,
   not this component's markup, so Svelte would otherwise scope these away. */
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive),
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive .maplibregl-canvas) {
	cursor: var(--grab-cursor) 11 5, grab;
}
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive:active),
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive:active .maplibregl-canvas) {
	cursor: var(--grab-cursor) 11 5, grabbing;
}
/* THE ON-MAP POPOVER. Positioned in the phone's own coordinate space (.phone
   is position:absolute), with left/top set per-frame from map.project(). The
   translate puts the card BELOW the pin and centred on it, and the 10px drop
   clears the pin's point. .phone has overflow:hidden, so a card near the edge
   clips to the screen exactly like the app's does. */
.map-popover {
	position: absolute;
	z-index: 3;
	transform: translate(-50%, 10px);
	width: 260px;
	max-width: calc(100% - 16px);
	background: #12100cf5;
	border: 2px solid var(--rt-yellow, #ffd24a);
	border-radius: 14px;
	padding: 8px 10px 10px;
	font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	box-shadow: 0 8px 24px #000a;
}
.map-popover__hdr {
	display: flex;
	align-items: center;
	gap: 8px;
}
.map-popover__glyph {
	width: 22px;
	height: auto;
	display: block;
}
.map-popover__title {
	color: var(--rt-yellow, #ffd24a);
	font-weight: 800;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	margin-right: auto;
}
/* Ghost grey, never red — dismissal is not destruction. */
.rt-popover-close {
	background: none;
	border: 1px solid #3a3428;
	border-radius: 8px;
	color: #8f8a76;
	font: inherit;
	line-height: 1;
	padding: 3px 7px;
	cursor: pointer;
}

.map-error {
	position: absolute;
	inset: 0;
	z-index: 2;
	display: grid;
	place-content: center;
	text-align: center;
	color: #ffb4a2;
	padding: 1rem;
}
.detail {
	font-size: 0.75rem;
	opacity: 0.8;
}

.pin-note {
	color: #8f8a76;
	margin-top: 0.3rem;
}
/* Shell from devCard.css (.dev-card) — same card as the rest of the rail. */
.pin-box {
	color: var(--muted);
}

/* ── CONFIG ──────────────────────────────────────────────────────────────── */
.wall-status {
	color: #7a7568;
	margin: 0 0 0.4rem;
}
</style>
