<script lang="ts">
    /**
     * OfflineMapPage — THE offline map. One component, every tier mounts it.
     *
     * It runs on nothing: no TinyBase, no Supabase, no auth, no mapStore. The
     * entire "database" is the PINS array below unless a host passes `hostPorts`.
     *
     * No `gps` port, so there is no live anchor — the engine treats its absence as
     * a valid configuration. `fires` IS supplied, from the child's own cache and
     * fetch.
     *
     * Pins are fixed locations on purpose: the tile Worker edge-caches /pack by
     * build, so these few areas stay hot. Click-anywhere would mint uncached packs
     * against a 127 GB archive on every visit.
     */
    import type * as maplibreType from "maplibre-gl";
    import { onMount } from "svelte";
    // The app's own grab hand, replacing MapLibre's stock white glove. Imported
    // (not a static URL) so the bytes are part of THIS build in every tier.
    // ⚠️ _100 = the 100px cut. Browsers IGNORE a cursor image above ~128px with no
    // warning and no fallback, which is why the full-size file silently vanished.
    import grabCursorUrl from "$gc/assets/hand_shovel_cursor_100.webp";
    import { initializeOfflineMap } from "./onPhone/render/offlineMapInit";
    import { buildOfflineBaseStyle } from "./onPhone/render/offlineBaseStyle";
    import { v4TransformRequest } from "./worker/worker-local-dev/roads/packDownload";
    import {
        installRawWallProtocol,
        rawSourceSpec,
        RAW_SOURCE,
        refreshRawTiles,
        setRawWallBlindHandler,
        shallowSourceSpec,
        SHALLOW_SOURCE,
    } from "./onPhone/roads/rawWallProtocol";
    import { wallLayers } from "./onPhone/render/wallStyle";
    import { addWallPois, wallLabelLayers } from "./onPhone/render/wallLabels";
    import { createSatelliteMount } from "./onPhone/satellite/mountSatellite";
    import { watchPaint } from "./onPhone/render/paintWatch";
    import { cameraFromUrl } from "./shared/cameraFromUrl";
    import { attachDoubleTapToPin } from "./shared/doubleTapToPin";
    import { startOfflineBakeService } from "./onPhone/bake/bakeService.svelte";
    import {
        resetCircuits,
        subscribeCircuits,
    } from "./shared/workMeter.svelte";
    import { attachFireLayer } from "./onPhone/render/fireLayer";
    import {
        deleteFireCache,
        FIRE_CACHE_VERSION,
        fireCoverage,
        isCoverageFresh,
        isFresh as fireIsFresh,
        readFireCache,
        writeFireCache,
    } from "../routes/fires/fireCache";
    import {
        noteFireArrival,
        takeFireArrival,
    } from "../routes/fires/fireArrival";
    import { fetchAreaFires } from "./worker/worker-local-dev/fires/fireFetch";
    import type { HostPorts } from "./shared/hostPorts";
    import OfflineWorkMeter from "./shared/OfflineWorkMeter.svelte";
    import OfflineBlobPanel from "./panels/OfflineBlobPanel.svelte";
    import "$rig/dev/devCard.css";
    import { portal } from "$rig/dev/portal";
    import OfflineConfigPanel from "./panels/OfflineConfigPanel.svelte";
    import PinLibrary from "./panels/PinLibrary.svelte";
    import { pinAssetPath, type PinKey } from "./shared/icons";
    import { satImageKey } from "./onPhone/satellite/satelliteImage";
    import { LAYER_TOGGLES, OPT_IN_LAYERS } from "./onPhone/render/wallLegend";

    /** THE ENTIRE DATA LAYER. Add a pin here — or drop one on the map, which
     *  pushes onto this same list through `fixturePorts.addPlace` — and the
     *  engine bakes it. */
    const PINS: Array<{
        name: string;
        lngLat: [number, number];
        touched?: string;
    }> = [
        {
            name: "Ottawa valley",
            lngLat: [-76.16797958683314, 45.061348227515055],
        },
        { name: "Vancouver", lngLat: [-123.1207, 49.2827] },
        { name: "Prince George", lngLat: [-122.7497, 53.9171] },
    ];

    /** The host ports, implemented with literals — same interface a real host
     *  supplies through the `hostPorts` prop. */
    const placeListeners = new Set<() => void>();
    /** Dropped pins endure: no database here, so they go to localStorage. The
     *  three literals above are the floor — always present, never stored. */
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
                // One fixed timestamp: every literal pin is equally "recent", so the
                // conveyor has no reason to prefer one over another.
                lastTouched: p.touched ?? "2026-01-01T00:00:00Z",
                corridor: false,
                // Display-only — the bake service ignores every field here.
                featureKey: p.name,
                featureName: p.name,
                featureType: "Point",
                groupKey: "demo",
                groupName: "literal fixture",
            })),
        // A PUSH channel, per hostPorts.ts: fires once on register and on every
        // addPlace.
        onPlacesChanged: (fn) => {
            placeListeners.add(fn);
            fn();
            return () => placeListeners.delete(fn);
        },
        addPlace: (lngLat, name) => {
            PINS.push({ name, lngLat, touched: new Date().toISOString() });
            try {
                localStorage.setItem(
                    FIXTURE_PINS_KEY,
                    JSON.stringify(PINS.slice(3)),
                );
            } catch {
                // codestyle-allow-swallow: storage refused → the pin still bakes this session.
            }
            for (const fn of placeListeners) fn();
        },
        // Hydrated the moment the module evaluates. NOT the same question as "has
        // places"; see hostPorts.ts.
        ready: () => true,
        fires: {
            fetchArea: (lng, lat) => fetchAreaFires(lng, lat),
            arrival: () => noteFireArrival(),
            takeArrival: () => takeFireArrival("bake"),
            read: (key) => readFireCache(key),
            // writeFireCache stamps cacheVersion itself; hotspots are COPIED because
            // the port hands a readonly view and the cache entry owns a mutable array.
            write: (key, rec) =>
                writeFireCache(key, { ...rec, hotspots: [...rec.hotspots] }),
            delete: (key) => deleteFireCache(key),
            // fireIsFresh's param is the full stored entry; the engine's record has no
            // cacheVersion, so supply the current one.
            isFresh: (rec) =>
                fireIsFresh({
                    ...rec,
                    cacheVersion: FIRE_CACHE_VERSION,
                    hotspots: [...rec.hotspots],
                }),
            coverage: () => fireCoverage(),
            isCoverageFresh: (c) => isCoverageFresh(c),
        },
    };

    let {
        /** A real host's ports. Absent → the literal fixtures above. */
        hostPorts,
        /**
         * WHERE THE DEV CHROME GOES. The panels' DATA is this component's, so they
         * stay owned here; their PLACE is the host's. A page hands in an element —
         * the content box of an EphemeralCard / EphemeralDock from `$rig/dev` — and
         * the nodes move into it, wiring, state and scoped styles intact.
         */
        debugHost,
        railLeftHost,
        railRightHost,
    }: {
        hostPorts?: HostPorts;
        debugHost?: HTMLElement;
        railLeftHost?: HTMLElement;
        railRightHost?: HTMLElement;
    } = $props();

    /**
     * THE DEBUG PANELS. One boolean, one button. Nothing navigates, so the map is
     * never rebuilt, the camera cannot jump, and no pin can vanish. Sticky across
     * reloads; open when nothing is stored.
     */
    const PANELS_KEY = "rt_offline_panels";
    function readPanels(): boolean {
        try {
            return localStorage.getItem(PANELS_KEY) !== "0";
        } catch {
            // codestyle-allow-swallow: no storage (SSR / private mode) → default open.
            return true;
        }
    }
    let showPanels = $state(readPanels());
    $effect(() => {
        try {
            localStorage.setItem(PANELS_KEY, showPanels ? "1" : "0");
        } catch {
            // codestyle-allow-swallow: storage refused → the toggle still works this session.
        }
    });

    /** THE PORTS, RESOLVED ONCE. The bake service, the marker loop and the blob
     *  panel all read this, so they cannot disagree about what the data is. */
    const ports = $derived(hostPorts ?? fixturePorts);

    let activePin = $state("pin");

    /** Pins dropped this session — the MARKER side only (which artwork, which one
     *  is selected). The PLACE side goes through `ports.addPlace()` at the drop,
     *  so the host keeps it and the bake is asked for it. */
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
        const m = markers[selectedIdx] as {
            getElement?: () => HTMLImageElement;
        };
        const el = m?.getElement?.();
        if (el) el.src = pinAssetPath(key as PinKey);
    }

    let mapContainer: HTMLDivElement;
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
        el.style.cssText =
            "width:34px;height:auto;display:block;cursor:pointer";
        // TAP A PIN → select it and open the library over the map. stopPropagation
        // so the map's own click handler doesn't immediately deselect it.
        const myIndex = dropped.length - 1;
        el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            selectedIdx = myIndex;
            syncPopover();
        });
        // ⚠️ NEVER `new maplibregl.Marker(...)` — the namespace-qualified form binds
        // this child to one GL library, and a Mapbox Marker on a MapLibre map throws
        // `_addMarker` / `_requestDomTask`. DESTRUCTURE instead; see
        // rendererMixing.test.ts.
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
    /** LIVE CAMERA, FOR THE DEBUG RAIL — the fractional zoom the renderer is at
     *  RIGHT NOW, written on every zoom/move frame. The URL's `&z=` only lands on
     *  `moveend`, so mid-gesture "which tile z will the wall ask for" was
     *  answerable only in DevTools. 0 = the map is not ready yet. */
    let liveZoom = $state(0);
    /** `lat,lng` at 6 dp (~10 cm) — human order, the one cameraFromUrl parses. */
    const llText = (lat: number, lng: number): string =>
        `${lat.toFixed(6)},${lng.toFixed(6)}`;

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
    function setLayerVisibility(
        ids: readonly string[],
        visible: boolean,
    ): void {
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
            // ids: [] = the switch can show/hide nothing (fires, until attachFireLayer
            // lands) — render it dead rather than let it pretend. README open-question 6.
            disabled: t.ids.length === 0,
            disabledHint:
                t.ids.length === 0
                    ? `${t.label} isn't drawn on this route yet — the switch has no layers to flip (README: "FIRES RENDER IS A NO-OP")`
                    : undefined,
        })),
    );

    onMount(() => {
        const stopBake = startOfflineBakeService(ports);
        let cleanup: (() => void) | undefined;
        let satMount: ReturnType<typeof createSatelliteMount> | undefined;
        let stopPaintWatch: (() => void) | undefined;
        let satPoll: ReturnType<typeof setInterval> | undefined;
        let fireHandle: ReturnType<typeof attachFireLayer> | undefined;
        let unsubFireCircuit: (() => void) | undefined;
        let unsubPackCircuit: (() => void) | undefined;
        let firePaintTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            // WHERE THE MAP OPENS. A coordinate in the query string wins over the
            // fixture, so `?=58.7986,-122.6761` points BOTH routes at the same
            // spot — see cameraFromUrl.ts. Absent, the first fixture pin stands.
            const urlCam = cameraFromUrl(location.search);
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
                    // OUR OWN handle. __rtMap survives a teardown, so probing that can
                    // read a DEAD map from a previous mount.
                    (window as unknown as Record<string, unknown>).__debugMap =
                        map;
                    map.on("error", (e) =>
                        console.error("[offline/map] map error", e?.error ?? e),
                    );
                },
                onMapReady: (map: maplibreType.Map) => {
                    mapInstance = map;
                    // LIVE ZOOM FOR THE RAIL — `zoom` alone misses camera changes
                    // that fire only `move` (jumpTo-style programmatic moves);
                    // both handlers are one getZoom() each, so wiring both is free.
                    const syncLiveZoom = () => {
                        liveZoom = map.getZoom();
                    };
                    syncLiveZoom();
                    map.on("move", syncLiveZoom);
                    map.on("zoom", syncLiveZoom);
                    // The popover is plain DOM, so nothing moves it when the map does.
                    map.on("move", syncPopover);
                    map.on("zoom", syncPopover);
                    /**
                     * THE ADDRESS BAR FOLLOWS THE MAP, so the url in front of you always
                     * reproduces what you are looking at. `moveend`, not `move`: one
                     * write per gesture. `replaceState`, not `pushState`: panning must
                     * not stack hundreds of back-button entries. lat,lng at 6dp is what
                     * cameraFromUrl reads back.
                     */
                    const writeCameraToUrl = () => {
                        const c = map.getCenter();
                        const at = llText(c.lat, c.lng);
                        const z = map.getZoom().toFixed(2);
                        history.replaceState(
                            history.state,
                            "",
                            `?at=${at}&z=${z}`,
                        );
                    };
                    // On load too, or a freshly-opened page has a bare url until you drag.
                    writeCameraToUrl();
                    map.on("moveend", writeCameraToUrl);
                    map.on("click", () => {
                        selectedIdx = null;
                        popAt = null;
                    });

                    // ⚠️ onMeasureSeed, NOT onDrop: in the app a double-tap seeds the Snake
                    // Ruler and its Save button drops the pin. With no ruler here, the seed
                    // IS the drop — `onDrop` is declared by the module but never called.
                    detachTap = attachDoubleTapToPin(map, {
                        onDrop: () => {},
                        onMeasureSeed: (lng: number, lat: number) => {
                            dropped = [
                                ...dropped,
                                { lng, lat, pin: activePin },
                            ];
                            addMarker(map, lng, lat, activePin);
                            // Circles go grey for THIS pin, then the host keeps the place →
                            // onPlacesChanged → the bake requests it → yellow → green/red.
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
                        // THE WALL MAP. Protocol FIRST so the first tile request resolves;
                        // it and the source add are both idempotent. Without this the only
                        // source is the bundled world base (z0-6) and every baked byte sits
                        // in IndexedDB unread — "the map looks empty".
                        if (!map.getSource(RAW_SOURCE)) {
                            installRawWallProtocol();
                            // ⛔ WIRE THE SELF-HEAL, OR IT IS A SPECTATOR. MapLibre requests
                            // tiles before the download lands, caches the 404s and then STOPS
                            // ASKING, so it never recovers — the whole "it works sometimes"
                            // pattern. refreshRawTiles is the narrow fix: setTiles with the
                            // same URL invalidates the tile cache and nothing else. Do NOT
                            // re-add the source or the layers here — that rebuilds the stack
                            // and drops the per-pin satellite layers.
                            setRawWallBlindHandler(() => refreshRawTiles(map));
                            map.addSource(RAW_SOURCE, rawSourceSpec());
                            // The z6 tier's OWN source — without this the shallow
                            // store is downloaded but never asked for (z6–7 blank
                            // even with a fresh pv47 pack; the wiring gap of 2026-09-02).
                            map.addSource(SHALLOW_SOURCE, shallowSourceSpec());
                            for (const layer of wallLayers())
                                map.addLayer(layer);
                            for (const layer of wallLabelLayers(map))
                                map.addLayer(layer);
                            void addWallPois(map);
                        }

                        // ── ROADS LAND → THE MAP RE-ASKS ─────────────────────
                        // A `pack` circuit going `ok` means bytes just hit IndexedDB,
                        // so every 404 MapLibre cached before that moment is stale.
                        // Refreshing at the write event makes recovery deterministic;
                        // the blind detector stays only as a backstop for staleness
                        // with no circuit event (wipe, purge).
                        unsubPackCircuit = subscribeCircuits((c) => {
                            if (c.key !== "pack" || c.state !== "ok") return;
                            refreshRawTiles(map);
                        });

                        // ── THE SATELLITE PHOTOS ─────────────────────────────
                        satMount = createSatelliteMount(map);
                        const showPhotos = async (): Promise<void> => {
                            let shown = 0;
                            for (const p of ports.places())
                                for (const c of p.anchors) {
                                    await satMount?.display(c);
                                    if (satMount?.mounted().has(satImageKey(c)))
                                        shown++;
                                }
                            // LOUD either way — "no photo on disk yet" and "the mount is
                            // missing" look identical on a black map.
                            console.info(
                                `[sat] ${shown} photo(s) on the map` +
                                    (shown === 0
                                        ? " — nothing baked here yet"
                                        : ""),
                            );
                        };
                        void showPhotos();
                        // A photo that lands 30 s into the bake must appear without
                        // a reload.
                        satPoll = setInterval(() => void showPhotos(), 20000);
                        stopPaintWatch = watchPaint(
                            map,
                            () => satMount?.mounted() ?? new Set(),
                        );

                        // ── THE FIRES ────────────────────────────────────────
                        // Paints the bake's cached hotspots (see fireLayer.ts).
                        fireHandle = attachFireLayer(map);
                        // ANY fires event, debounced past the meter's TRANSIT_HOLD — the
                        // hold can eat an intermediate `ok`, so keying on `ok` alone left
                        // cached hotspots unpainted until reload.
                        unsubFireCircuit = subscribeCircuits((c) => {
                            if (c.key !== "fires") return;
                            clearTimeout(firePaintTimer);
                            firePaintTimer = setTimeout(
                                () => fireHandle?.repaint(),
                                1300,
                            );
                        });

                        wallStatus = `wall ok · ${map.getStyle().layers.length} layers`;
                    } catch (err) {
                        // LOUD, not swallowed: a wall map that fails to mount is the
                        // difference between "the offline map works" and a page that
                        // looks fine and shows nothing. [[no-silent-fallbacks]]
                        wallStatus = `wall FAILED: ${err instanceof Error ? err.message : String(err)}`;
                        console.error("[offline/map] wall mount failed", err);
                    }
                },
            });
        } catch (err) {
            mapError = err instanceof Error ? err.message : String(err);
        }
        return () => {
            detachTap?.();
            clearInterval(satPoll);
            stopPaintWatch?.();
            clearTimeout(firePaintTimer);
            unsubFireCircuit?.();
            unsubPackCircuit?.();
            fireHandle?.();
            // Revoke every photo object-URL, or each unmount strands the blob.
            satMount?.dispose();
            cleanup?.();
            stopBake();
        };
    });
</script>

<!-- No <title> here: naming the page is the HOST's job. -->

<!-- --grab-cursor carries the COMPLETE url() token (see .map-canvas rules):
     the bundler rewrites `grabCursorUrl` to the built asset path, so the cursor
     resolves in every tier without any tier-specific URL in the CSS. -->
<div class="stage" style="--grab-cursor: url({grabCursorUrl});">
    <!-- LEFT: what this SESSION is doing (meter) and how it is set (config).
	     RIGHT: what is on DISK (blobs), full height — it is the long list. -->
    {#if showPanels}
        <aside class="rail left" use:portal={railLeftHost}>
            <OfflineWorkMeter
                docked
                route="debug/map"
                pins={PINS.map((p) => ({ lng: p.lngLat[0], lat: p.lngLat[1] }))}
                {layers}
                {focusedBlobName}
            />
            <OfflineConfigPanel {layers} />

            <div class="pin-box dev-card">
                <div class="pin-note">
                    {dropped.length} dropped · session only, no database
                </div>
                <!-- LIVE CAMERA — fractional zoom plus the integer tile z the wall
			             actually requests (Math.floor; overzoom draws z13 at z14). -->
                <p class="camera-zoom">
                    camera z{liveZoom.toFixed(2)} · tile
                    z{Math.max(0, Math.floor(liveZoom))}
                </p>
                <p class="wall-status">{wallStatus}</p>
            </div>
        </aside>
    {/if}

    <div class="phone">
        <!-- ⛔ INSIDE THE PHONE, not fixed to the viewport: fixed positioning put it
        		     under the parent's nav bar, unclickable. -->
        <button
            type="button"
            class="debug-toggle"
            use:portal={debugHost}
            class:on={showPanels}
            aria-pressed={showPanels}
            onclick={() => (showPanels = !showPanels)}>debug</button
        >
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
        font:
            12px/1.5 ui-monospace,
            SFMono-Regular,
            Menlo,
            monospace;
        cursor: pointer;
    }
    .debug-toggle.on {
        background: #e8b923;
        border-color: #e8b923;
        color: #111;
    }

    :global(html),
    :global(body) {
        margin: 0;
        height: 100%;
        background: #000;
        overflow: hidden;
    }

    /* Fills the nearest positioned ancestor — .mobile-content inside the host's
   phone, body standalone — never the viewport. No viewport unit, no size of
   its own: a map that measures anything but its slot ends up taller than the
   phone and scrolls off it. */
    .stage {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background: #000;
        color: #d8d4c8;
        font-family: ui-monospace, monospace;
    }
    .rail {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .phone {
        position: absolute;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        background: #05101f;
    }
    .map-canvas {
        position: absolute;
        inset: 0;
    }
    /* THE GRAB HAND, replacing MapLibre's stock white glove. `11 5` is the hotspot
   (the fingertip), matching SnakeRuler.svelte; the trailing `grab`/`grabbing`
   cover the moment before the image loads.
   `--grab-cursor` carries the WHOLE `url(...)` token — `url(var(--x))` does not
   work. `:global` because the canvas is MapLibre's element, not ours. */
    :global(.map-canvas .maplibregl-canvas-container.maplibregl-interactive),
    :global(
        .map-canvas
            .maplibregl-canvas-container.maplibregl-interactive
            .maplibregl-canvas
    ) {
        cursor:
            var(--grab-cursor) 11 5,
            grab;
    }
    :global(
        .map-canvas .maplibregl-canvas-container.maplibregl-interactive:active
    ),
    :global(
        .map-canvas
            .maplibregl-canvas-container.maplibregl-interactive:active
            .maplibregl-canvas
    ) {
        cursor:
            var(--grab-cursor) 11 5,
            grabbing;
    }
    /* THE ON-MAP POPOVER. Positioned in the phone's own coordinate space, with
   left/top set per-frame from map.project(). The translate puts the card below
   the pin and centred on it; the 10px drop clears the pin's point. */
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
        font:
            12px/1.4 ui-monospace,
            SFMono-Regular,
            Menlo,
            monospace;
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
    /* LIVE CAMERA — brighter than .wall-status because it CHANGES as you zoom;
       it is the one number you watch while zooming, not a settled status. */
    .camera-zoom {
        color: #cfc9b8;
        margin: 0.4rem 0 0;
    }
</style>
