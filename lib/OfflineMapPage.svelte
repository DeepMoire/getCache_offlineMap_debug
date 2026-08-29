<script lang="ts">

import type * as maplibreType from "maplibre-gl";
import { onMount } from "svelte";
// ⚠️ import assets, don't reference via a static src path — src="/mobileAssets/..." only resolves under a host whose static folder has the file and 404s elsewhere; an import bundles the bytes at build time.
import handPhoneUrl from "$parent/retreeved/sharedAssets/hand_phoneV3.webp";
// ⚠️ keep the _100 cut — CSS cursor images above ~128px are silently ignored (no warning, no fallback), so the full-size hand_shovel_cursor.webp vanishes silently.
import grabCursorUrl from "$parent/retreeved/sharedAssets/hand_shovel_cursor_100.webp";
import { initializeOfflineMap } from "./onPhone/render/offlineMapInit";
import { buildOfflineBaseStyle } from "./onPhone/render/offlineBaseStyle";
import { v4TransformRequest } from "./r2Worker/local_dev/roads/packDownload";
import {
	installRawWallProtocol,
	rawSourceSpec,
	RAW_SOURCE,
	// ⚠️ both refreshRawTiles and setRawWallBlindHandler must be wired together at onMapReady — using only one leaves the self-heal broken.
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
// THE TIER PILL is mounted here, beside the stage, so every tier that serves this page gets it — not in SharedNav, since tiers don't share a nav.
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

// THE ENTIRE DATA LAYER — add a pin here, or drop one on the map via fixturePorts.addPlace, and the engine bakes it.
const PINS: Array<{ name: string; lngLat: [number, number]; touched?: string }> = [
	{ name: "Ottawa valley", lngLat: [-76.16797958683314, 45.061348227515055] },
	{ name: "Vancouver", lngLat: [-123.1207, 49.2827] },
	{ name: "Prince George", lngLat: [-122.7497, 53.9171] },
];


// The host ports, implemented with literals — compare with ReTreever's retreeverPorts.ts: same interface, no TinyBase.
// hostPorts is a caller-supplied override (e.g. ReTreever's retreeverPorts()); omitted, the literal fixture below stands.
const placeListeners = new Set<() => void>();
// PINS ENDURE — dropped pins persist to localStorage under this key; the three literals above are the floor, always present, never stored.
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
			lastTouched: p.touched ?? "2026-01-01T00:00:00Z",
			corridor: false,
			// display-only — the bake service ignores every field here.
			featureKey: p.name,
			featureName: p.name,
			featureType: "Point",
			groupKey: "demo",
			groupName: "literal fixture",
		})),
	// a push channel — fires once on register and on every addPlace.
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
	// hydrated the moment the module evaluates; NOT the same question as "has places" — see hostPorts.ts.
	ready: () => true,
	// No `fires`, no `gps` — both optional, both ReTreever's business.
};

// IS A HOST LENDING ITS STYLE? --host-decor is "1" when a host wants scenery, absent otherwise; the dull version is default, art is opt-in.
let decor = $state(false);
onMount(() => {
	const v = getComputedStyle(document.documentElement)
		.getPropertyValue("--host-decor")
		.trim();
	decor = v === "1";
});

// TWO VIEWS, ONE PAGE — rails is the difference between the debugger and the plain offline map; only the two debug panels come and go.
let {
	// ⛔ rails defaults OFF — it used to default true, making /offline and /offline/debug identical; panels are opt-in.
	rails = false,
	// ⛔ cards is an alias of rails, deliberately two names one flag — a second boolean would duplicate the source of truth.
	cards,
	hostPorts,
	// ⚠️ framed=false when the host already draws its own phone around its routes — without it you get a phone inside a phone.
	framed = true,
	// ⚠️ dev chrome must not ship — it's transient (vite dev only); data stays owned here, place is the host's via an EphemeralCard element.
	debugHost,
	// WHERE THE RAILS GO — separate from debugHost; unset, the panels have nowhere to go and aren't laid out, so every tier must pass both.
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

// PORTAL — move a node into target, follow it if target changes; a no-op without a target.
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

// STICKY, DEFAULT OPEN — last toggle wins via localStorage; unset defaults to open. Dev-only chrome, never ships.
const PANELS_KEY = "rt_offline_panels";
function readPanels(): boolean {
	try {
		const v = localStorage.getItem(PANELS_KEY);
		if (v === "0") return false;
		if (v === "1") return true;
	} catch {
		// codestyle-allow-swallow: no storage (SSR / private mode) → default.
	}
	return cards ?? true; // unstored → OPEN; `rails` defaults false so it must not sit in this chain
}
let showPanels = $state(readPanels());
$effect(() => {
	try {
		localStorage.setItem(PANELS_KEY, showPanels ? "1" : "0");
	} catch {
		// codestyle-allow-swallow: storage refused → the toggle still works this session.
	}
});

// ⚠️ resolve hostPorts ?? fixturePorts ONCE here and read everywhere — duplicating this at each call site let tiers disagree.
const ports = $derived(hostPorts ?? fixturePorts);

let activePin = $state("pin");

// ⚠️ dropped is the MARKER side only — the PLACE side needs ports.addPlace() too, or nothing downloads (see HostPorts.addPlace).
let dropped = $state<Array<{ lng: number; lat: number; pin: string }>>([]);
let markers: unknown[] = [];

// THE SELECTED PIN — index into dropped, or null for none; tapping a marker opens the library popover anchored under it.
let selectedIdx = $state<number | null>(null);
// popAt — where to draw the popover, in pixels inside the map canvas; recomputed as the map moves.
let popAt = $state<{ x: number; y: number } | null>(null);

// project the selected pin to screen space; called on every map move since the card is plain DOM.
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

// re-point the selected pin at new artwork; updates the marker element in place rather than tearing it down.
function changeSelectedPin(key: string): void {
	if (selectedIdx === null) return;
	dropped[selectedIdx].pin = key;
	const m = markers[selectedIdx] as { getElement?: () => HTMLImageElement };
	const el = m?.getElement?.();
	if (el) el.src = pinAssetPath(key as PinKey);
}

let mapContainer: HTMLDivElement;
let phoneEl = $state<HTMLDivElement>();

// phone's on-screen edge is measured here and published as --dock-width-left/right for the shared dock and tray — 12px at the viewport edge, 15px at the phone.
// viewport edge → panel: dock's own left/right:12px. panel → phone: a touch wider so the edge doesn't read as part of the bezel.
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

// paint one dropped pin — plain DOM marker; anchor is BOTTOM so the pin's point sits on the coordinate, not its middle.
function addMarker(
	map: maplibreType.Map,
	lng: number,
	lat: number,
	pin: string,
): void {
	const el = document.createElement("img");
	el.src = pinAssetPath(pin as PinKey);
	el.style.cssText = "width:34px;height:auto;display:block;cursor:pointer";
	// TAP A PIN → select it and open the library over the map; stopPropagation so the map's own click handler doesn't immediately deselect it.
	const myIndex = dropped.length - 1;
	el.addEventListener("click", (ev) => {
		ev.stopPropagation();
		selectedIdx = myIndex;
		syncPopover();
	});
	// ⚠️ NEVER `new maplibregl.Marker(...)` — binds this child to one GL library and throws when mixed with the other renderer; destructure { Marker } from the module instead.
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
// WHERE THE MAP OPENED, shown on screen not just console — renders on both routes since /offline is where you paste a coordinate.
let cameraBadge = $state("");

// layer toggles driving the CONFIG panel's layers section — same shape the real /offline route passes.
const layerOn = $state<Record<string, boolean>>(
	Object.fromEntries(
		LAYER_TOGGLES.map((t) => [t.key, !OPT_IN_LAYERS.includes(t.key)]),
	),
);
let mapInstance: maplibreType.Map | null = null;
// name of the row OfflineBlobPanel currently exports; forwarded into OfflineWorkMeter so the export button's sub-label matches.
let focusedBlobName = $state<string | null>(null);

// ⚠️ show/hide a layer group — Satellite is special: its toggle must also sweep every dynamically-mounted v4-sat-* layer, or half the imagery stays visible after switching off.
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
		// hint travels with the row — declared once in wallLegend.ts beside the ids it describes.
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
		// WHERE THE MAP OPENS — a coordinate in the query string wins over the fixture (see cameraFromUrl.ts); absent, the first fixture pin stands.
		const urlCam = cameraFromUrl(location.search);
		// badge always states which source won — URL vs fixture default, so an ignored param isn't silent.
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
			// LAW 0 — every non-local URL is rejected here, so the map cannot stream even if a style entry tried to.
			transformRequest:
				v4TransformRequest as maplibreType.RequestTransformFunction,
			onMapCreated: (map: maplibreType.Map) => {
				// ⚠️ __debugMap survives teardown — probing it after unmount can read a DEAD map from a previous mount.
				(window as unknown as Record<string, unknown>).__debugMap = map;
				wallStatus = "onMapCreated fired";
				// DIAGNOSTIC — onMapReady waits on `load`, which waits on every source settling; report state so a stall isn't just a blank page.
				map.on("error", (e) =>
					console.error("[debug/map] map error", e?.error ?? e),
				);
				map.once("styledata", () => (wallStatus = "styledata fired"));
				map.once("load", () => (wallStatus = "load fired"));
				// DIAGNOSTIC — prove whether MapLibre applies any style here; if a bare background style also fails, the renderer is the problem, not our style.
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
				// ⚠️ THE WALL MAP — without it the only source is the bundled world base and everything the bake downloaded sits in IndexedDB unread; that's what "map looks empty" was.
				// protocol FIRST so the first tile request resolves; it and the source add are both idempotent.
				// LONG-PRESS / DOUBLE-TAP TO DROP — the gesture module's map type is structural, written for both renderers, so the MapLibre map satisfies it unchanged.
				// ⚠️ use onMeasureSeed, NOT onDrop — the app's double-tap seeds the snake ruler and its Save button drops the pin; onDrop is declared but never called. Without the ruler, the seed IS the drop.
				// THE CARD IS PLAIN DOM — re-project on every camera change, dismiss on a click that wasn't a marker (markers stopPropagation above).
				map.on("move", syncPopover);
				map.on("zoom", syncPopover);
				// THE ADDRESS BAR FOLLOWS THE MAP — moveend (not move) writes once per gesture; replaceState (not pushState) so panning doesn't stack history entries; lat,lng order matches cameraFromUrl, 6dp precision.
				const writeCameraToUrl = () => {
					const c = map.getCenter();
					const at = `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`;
					const z = map.getZoom().toFixed(2);
					history.replaceState(history.state, "", `?at=${at}&z=${z}`);
					cameraBadge = `${at} · z${z}`;
				};
				// ⚠️ write on load too, not just moveend — otherwise a freshly-opened page has a bare url until you drag, and the feature looks absent.
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
						// THE ASK — circle goes grey, host keeps the place → onPlacesChanged → bake requests it → yellow → green/red; a host with no addPlace is told (never a silent no-op).
						resetCircuits(satImageKey([lng, lat]));
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
						// ⛔ wire the self-heal (setRawWallBlindHandler) or it's a spectator — MapLibre caches 404s from tiles requested before the pack lands and stops asking; refreshRawTiles fixes it. Do NOT re-add the source or layers here, that drops the per-pin satellite layers.
						map.addSource(RAW_SOURCE, rawSourceSpec());
						for (const layer of wallLayers()) map.addLayer(layer);
						setRawWallBlindHandler(() => refreshRawTiles(map));
					}

					// ⛔ satellite mount must be shared (see mountSatellite.ts) — inlining it in only one page rendered no satellite here for days while ReTreever's /offline worked fine.
					satMount = createSatelliteMount(map);
					const showPhotos = async (): Promise<void> => {
						let shown = 0;
						for (const p of ports.places())
							for (const c of p.anchors) {
								await satMount?.display(c);
								if (satMount?.mounted().has(satImageKey(c))) shown++;
							}
						// LOUD either way — "no photo yet" and "mount missing" look identical on a black map, but only one is a bug.
						console.info(
							`[sat] ${shown} photo(s) on the map` +
								(shown === 0 ? " — nothing baked here yet" : ""),
						);
					};
					void showPhotos();
					// re-check after the bake conveyor has had a pass — a photo landing 30s in must still appear without a reload.
					satPoll = setInterval(() => void showPhotos(), 20000);

					wallStatus = `wall ok · ${map.getStyle().layers.length} layers`;
				} catch (err) {
					// LOUD, not swallowed — a wall map that fails to mount must not fail silently. [[no-silent-fallbacks]]
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
		// ⚠️ revoke every photo object-URL on unmount, or the blob strands in memory — the steady RAM climb.
		satMount?.dispose();
		cleanup?.();
		stopBake();
	};
});
</script>

<!-- No <title> here — naming the page is the host's job; a child that titled itself would fight whatever parent mounts it. -->

<!-- --grab-cursor carries the complete url() token (see .map-canvas) — the bundler rewrites grabCursorUrl so it resolves in every tier without a tier-specific URL in CSS. -->
<div class="stage" class:unframed={!framed} style="--grab-cursor: url({grabCursorUrl});">
	<!-- THE CAMERA BADGE renders outside {#if showPanels} on purpose — /offline has no rails to report anything, so both routes answer "did my URL land?" the same way. -->


	<!-- LEFT RAIL — one component; both read-outs share a stacking context so they can never drift apart. Sits 15px clear of the phone (see .stage's gap and .rig's margin-inline). -->
	{#if showPanels}
	<aside class="rail left" use:portal={railLeftHost}>
		<!-- LEFT: what this session is doing (meter) and how it's set (config). RIGHT: what's on disk (blobs), full height. -->
		<OfflineWorkMeter
			docked
			route="debug/map"
			pins={PINS.map((p) => ({ lng: p.lngLat[0], lat: p.lngLat[1] }))}
			{layers}
			{focusedBlobName}
		/>
		<OfflineConfigPanel {layers} />

		<!-- ONE pin library, not two — arm a pin from the library on the map, not here. -->
		<div class="pin-box dev-card">
			<div class="pin-note">
				{dropped.length} dropped · session only, no database
			</div>
			<p class="wall-status">{wallStatus}</p>
		</div>
	</aside>
	{/if}

	<!-- CENTRE — the phone in the hand, fitted to the viewport exactly as the app's own frame (see .rig's --fit). -->
	<div class="rig">
		<!-- The hand is scenery, opt-in — only a host lending its style asks for it; without one the phone stands on plain black. -->
		{#if decor && framed}
			<img
				class="hand"
				src={handPhoneUrl}
				alt=""
				draggable="false"
			/>
		{/if}
		<div class="phone" bind:this={phoneEl}>
		<!-- ⛔ keep these inside the phone, not fixed to the viewport — position:fixed put them under the parent's nav bar, making the button unclickable and the badge invisible. -->
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
			
			<!-- THE PIN LIBRARY, ON THE MAP — anchored under the selected pin, re-projected on every camera move like the app's feature popover. -->
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
	
	/* THE CAMERA BADGE — fixed to the viewport, not the stage, so a rail's flex-grow can't push it off; pointer-events:none keeps it from eating a map drag. */
	.debug-toggle {
		position: absolute;
		/* clear the phone's top edge (sits under the parent's nav, 67px on rapper) or the button is half-hidden. */
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

/* THE STAGE fills the slot its host gave it, not the viewport — container-type:size makes 100cqh below resolve against this box. */
.stage {
	/* ⚠️ position:absolute, NOT fixed — fixed anchors to the viewport and covers the host's top/tab bars; absolute anchors to the nearest positioned ancestor (.mobile-content in ReTreever, body standalone). */
	position: absolute;
	inset: 0;
	container-type: size;
	display: flex;
	/* rails hang from the top so read-outs start where the eye does; the rig re-centres itself below. */
	align-items: flex-start;
	/* ⚠️ NOT space-between (or any free-space distribution) — that makes the rail-to-phone gap a residual that editing gap can't shrink; rails flex-grow instead so gap is the only separation. */
	justify-content: center;
	/* ⚠️ 15px is the real gap only because the rails flex-grow to eat the slack above — restore any free-space justify-content and this number becomes decorative. */
	gap: 15px;
	/* STYLE OFF is the default — plain black; a host opts into art via --host-decor:1. */
	background: #000;
	background-image: var(--demo-backdrop, none);
	background-position: center;
	background-size: cover;
	background-repeat: no-repeat;
	color: #d8d4c8;
	font-family: ui-monospace, monospace;
}

/* the rails fill edge-to-phone — the phone's edges are measured (see publishDockWidths) and published as --dock-width-left/right for EphemeralDock/EphemeralCard. */

/* rails are handed to an EphemeralDock (railLeftHost/railRightHost props) — the stage itself never lays them out. */
.rail {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

/* ⚠️ THE RIG — geometry hand-tuned against hand_phoneV3.webp, do NOT re-derive. --fit shrinks by (stage height ÷ phone height), capped at 1. */
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

	/* ⚠️ THE PHANTOM WIDTH — transform:scale() shrinks what the rig paints but not what it reserves, so editing gap/padding can't reach the leftover space; margin-inline below pulls it in instead. */
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
	/* with the hand hidden the phone needs its own edge (gold, 3px). A host supplying the hand sets --demo-bezel:none so the artwork provides the edge instead of doubling it. */
	outline: var(--demo-bezel, 3px solid #f5a119);
	outline-offset: -1px;
}
.map-canvas {
	position: absolute;
	inset: 0;
}
/* UNFRAMED — host already owns the phone (see framed prop); rig becomes the whole stage, bezel/hand go, rails slide over the map instead of beside it. */
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
/* ⚠️ THE GRAB HAND overrides MapLibre's stock cursor — hotspot 11 5 must match SnakeRuler.svelte; --grab-cursor carries the WHOLE url(...) token since url(var(--x)) doesn't work; :global needed because MapLibre's canvas elements aren't Svelte-scoped. */
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive),
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive .maplibregl-canvas) {
	cursor: var(--grab-cursor) 11 5, grab;
}
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive:active),
:global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive:active .maplibregl-canvas) {
	cursor: var(--grab-cursor) 11 5, grabbing;
}
/* THE ON-MAP POPOVER — positioned in the phone's own coordinate space, left/top set per-frame from map.project(); translate puts it below and centred on the pin. */
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

.wall-status {
	color: #7a7568;
	margin: 0 0 0.4rem;
}
</style>
