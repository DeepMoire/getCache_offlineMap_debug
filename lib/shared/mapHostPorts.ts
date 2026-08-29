/**
 * mapHostPorts.ts — THE MAP UI'S DOOR TO ITS HOST.
 *
 * Every map component and store in lib/mapUi/ and lib/mapState/ used to live
 * in ReTreever/src/lib and reach the proprietary side directly — `$lib` icon
 * system, share sheet, GPS permission, the TinyBase-backed map store, the
 * quality-704 plot stores. They moved into this child on 28 Aug 2026 ("all map
 * code in ONE place"), and a child may not import `$lib` (childBoundary.test.ts)
 * or name a parent (noParentNames.test.ts). So everything they need from the
 * host comes IN through this file, as a typed prop, the same way HostPorts in
 * ./hostPorts.ts feeds the offline engine.
 *
 * RULES
 * - Structural types only. The host's real store is ASSIGNED to MapHostStore;
 *   it never has to import this file to conform, and this file never imports
 *   the host. The assignment in ReTreever (retreeverMapPorts.ts) is the
 *   type-check at the boundary.
 * - Narrow. A member appears here because a file under lib/mapUi or
 *   lib/mapState USES it. Add the member the day a mover needs it; do not
 *   mirror the host's whole interface "for later".
 * - Components come in as components (Svelte 5 `Component`), rendered with
 *   `<ports.Icon .../>`. One Icon definition in the host; none copied here.
 * - Optional groups (`q704?`, `scenes?`) are for components only some hosts
 *   have. A component that needs one renders nothing (or its fallback) when it
 *   is absent — it never crashes, per deps.json `_channel_why`.
 */
import type { Component } from "svelte";
import type { Feature } from "geojson";

// ─────────────────────────────────────────────────────────────────────────────
// [store] — the host's map session store, as the map UI sees it
// ─────────────────────────────────────────────────────────────────────────────

/** A text label baked onto a PDF ground-overlay. Mirrors the host's
 *  OverlayLabel; only the fields the overlay manager reads. */
export interface MapHostOverlayLabel {
	/** The text itself, e.g. "2427". */
	t: string;
	/** Label centre as [lng, lat]. */
	p: [number, number];
	/** Text height in ground metres. */
	m: number;
	/** Rotation, degrees clockwise. */
	r: number;
}

/** One feature row of the active map. Structural mirror of the host's
 *  MapSessionFeature — the host's type is assignable to this. */
export interface MapHostFeature {
	mapFeatureKey: string;
	featureName: string;
	featureType: string;
	featureDesc: string | null;
	featureData: string | null;
	contacts?: string[];
	geometry: Feature | null;
	lastEditedBy: string | null;
	importedCount: number | null;
	hectaresCalc: number | null;
	senderName: string | null;
	senderId: string | null;
	overlayStorageKey: string | null;
	overlayBounds: [number, number, number, number] | null;
	overlayCorners:
		| [[number, number], [number, number], [number, number], [number, number]]
		| null;
	overlayLabels: MapHostOverlayLabel[] | null;
	featureSource: string | null;
	isRetreever: string;
	createdAt: string;
	lastTouched: string;
}

/** One map session (a "map" the user is in). */
export interface MapHostSession {
	mapKey: string;
	mapTitle: string;
	landKey: string | null;
	createdAt: string;
	lastTouched: string;
	senderName: string | null;
	senderId: string | null;
	features: MapHostFeature[];
}

/** The slice of the host's MapStore the map UI touches. Reactive getters on
 *  the host side (Svelte 5 runes) read through fine as plain properties. */
export interface MapHostStore {
	readonly activeMapKey: string | null;
	readonly activeMap: MapHostSession | null;
	readonly allMaps: MapHostSession[];
	readonly features: Feature[];
	readonly ready: boolean;
	onActiveMapChange(fn: () => void): () => void;
	addFeature(
		geojsonFeature: Feature,
		featureType?: string,
		lastEditedBy?: string,
		username?: string | null,
		abstraction?: string | null,
		opts?: Record<string, unknown>,
	): string;
	updateFeature(
		mapFeatureKey: string,
		patch: {
			name?: string;
			featureDesc?: string;
			featureData?: string;
			contacts?: string[];
			geometry?: Feature | null;
			[extra: string]: unknown;
		},
	): void;
	deleteFeature(mapFeatureKey: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// [ui] — host furniture the map components render or call
// ─────────────────────────────────────────────────────────────────────────────

export interface IconProps {
	name: string;
	size?: number;
	stroke?: number;
	style?: string;
	class?: string;
}

/** One row of the host's share sheet. Mirrors SharePicker's ShareFormat. */
export interface MapShareRow {
	ext: string;
	label?: string;
	icon?: string;
	run: () => Promise<unknown> | unknown;
	[extra: string]: unknown;
}

/** The file formats a map can be shared as. THE definition — the host's
 *  kmzExport re-exports it. */
export type MapShareFormat = "getcache" | "kmz" | "kml";

export interface MapUiPorts {
	/** The app's line-icon component. */
	Icon: Component<IconProps>;
	MaskedIcon: Component<Record<string, unknown>>;
	EmojiPin: Component<Record<string, unknown>>;
	GoldButton: Component<Record<string, unknown>>;
	SharePicker: Component<Record<string, unknown>>;
	/** The feature editor body FeatureMapPopover defers ALL content to
	 *  (host-owned: it edits the host's store). Added 28 Aug 2026. */
	FeatureDetail: Component<Record<string, unknown>>;
	/** The online/offline crow switch MapTopControls stacks under the eye.
	 *  Added 28 Aug 2026. */
	CrowSwitch: Component<Record<string, unknown>>;
	copyToClipboard(text: string): Promise<boolean>;
	/** Log-and-continue for a swallowed error. */
	reportSwallowed(scope: string, err: unknown, extra?: Record<string, unknown>): void;
	/** TEMP remote diagnostic breadcrumb (host's /api/devlog). Optional — added
	 *  28 Aug 2026 for overlayManager's "overlay-mounted" event; a host without
	 *  it is skipped, never crashed. */
	devlog?(data: Record<string, unknown>): void;
	/** Svelte action that lifts a node into the host's overlay layer. */
	overlayPortal(node: HTMLElement): { destroy(): void } | void;
	/** The blinking eye used by legend toggles. */
	createEyeToggle(): {
		srcFor(on: boolean, key?: string): string;
		isSettledOff(on: boolean, key?: string): boolean;
		play(on: boolean, key?: string): void;
		destroy(): void;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// [gps] — location permission + error reporting
// ─────────────────────────────────────────────────────────────────────────────

export interface MapGpsPorts {
	isGranted(): Promise<boolean>;
	reportError(scope: string, err: unknown, extra?: Record<string, unknown>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// [scenes] — frame-animation asset facts (MapTopControls)
// ─────────────────────────────────────────────────────────────────────────────

export interface MapScenePorts {
	assetFacts(dir: string): { startFrame: number; frameCount: number; fps: number };
	framePath(dir: string, frameNumber: number): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// [q704] — quality-704 plot popover (PlotMapPopoverV2). Optional: only the
// GetCache host has inspections.
// ─────────────────────────────────────────────────────────────────────────────

// Structural mirrors of the host's quality-704 types (q704.ts PlotRow /
// BlockHeader, quality704Plots PlotPinData / PendingDrop / ActivePlotEdit).
// ONLY the fields PlotMapPopoverV2 reads or writes — the host's real types are
// assignable to these; these never import the host. (28 Aug 2026)

/** One species split of a plot's `planted` count. */
export interface MapQ704Species {
	name: string;
	count: number | null;
}

/** One plot row of the ACTIVE inspection, as the popover's deck edits it.
 *  Mirrors q704.ts PlotRow — required fields match the host's exactly so a row
 *  the popover builds in memory is a legal host row. */
export interface MapQ704PlotRow {
	id: string;
	plotNo?: number;
	planted: number | null;
	plantableSpotsOverride: number | null;
	plantableSpots?: number | null;
	faults: string[];
	comment: string;
	species?: MapQ704Species[];
	gpsFeatureKey?: string;
	openLocode?: string;
	committed: boolean;
}

/** The inspection header the deck binds to. Mirrors q704.ts BlockHeader
 *  (speciesChoices optional on read — older rows have no cell). */
export interface MapQ704BlockHeader {
	blockNo: string;
	treesPerHa: number | null;
	totalHa: number | null;
	speciesChoices?: string[];
}

/** Popover data for one plot pin. Mirrors quality704Plots PlotPinData. */
export interface MapQ704PlotPinData {
	plotNo: number;
	displayNo: number;
	planted: number | null;
	spots: number | null;
	excess: number | null;
	faults: string[];
	comment: string;
}

/** The in-flight (uncounted, memory-only) map drop. Mirrors PendingDrop. */
export interface MapQ704PendingDrop {
	plotNo: number;
	rowKey: string;
	gridCode: string;
}

/** The per-plot targeted write. Mirrors quality704Plots ActivePlotEdit. */
export interface MapQ704PlotEdit {
	planted?: number | null;
	plantableSpotsOverride?: number | null;
	plantableSpots?: number | null;
	faults?: string[];
	comment?: string;
	species?: MapQ704Species[] | undefined;
}

/** Discriminated write outcome — mirrors ActivePlotWriteOutcome. "missing" is
 *  a REFUSED write the caller must surface, never fold into "unchanged". */
export type MapQ704WriteOutcome = "updated" | "unchanged" | "missing";

/** The deck props the popover passes (a subset of the host deck's props). */
export interface MapQ704DeckProps {
	block?: MapQ704BlockHeader & { speciesChoices: string[] };
	rows?: MapQ704PlotRow[];
	showHeader?: boolean;
	singlePlot?: boolean;
	onReward?: () => void;
	onFocusingChange?: (focusing: boolean) => void;
	autoRestoreMissed?: boolean;
	mapNumberFor?: (row: MapQ704PlotRow) => number;
}

/** The deck's `bind:this` surface — the two imperative calls the popover makes. */
export interface MapQ704DeckExports {
	focusRow(rowId: string): void;
	openPlantedFor(rowId: string): void;
}

export interface MapQ704FaultChipProps {
	code: string;
	count?: number;
}

export interface MapQ704CelebrateHostProps {
	target: HTMLElement | null;
}

export interface MapQ704Ports {
	Quality704Deck: Component<MapQ704DeckProps, MapQ704DeckExports>;
	FaultChip: Component<MapQ704FaultChipProps>;
	CelebrateHost: Component<MapQ704CelebrateHostProps>;
	/** The reward-arm controller; `onInputComplete()` fires the celebration. */
	celebrate: { onInputComplete(): void };
	/** Svelte action: `<button use:atvShare>` arms the ATV ride on tap. */
	atvShare(
		node: HTMLElement,
		opts?: { exit?: "left" | "right" | "auto" },
	): { update?(next?: { exit?: "left" | "right" | "auto" }): void; destroy(): void } | void;
	loadInspection(): Promise<{ block: MapQ704BlockHeader; rows: MapQ704PlotRow[] } | null>;
	/** gpsFeatureKey → the DYNAMIC per-map plot number the user sees. */
	activeMapNumbering(): Map<string, number>;
	plotByGpsKey(gpsFeatureKey: string): MapQ704PlotPinData | null;
	plotFullCodeByGpsKey(gpsFeatureKey: string): string;
	updateActivePlot(plotNo: number, fields: MapQ704PlotEdit): MapQ704WriteOutcome;
	setActiveSpeciesChoices(choices: string[]): void;
	getPendingDrop(): MapQ704PendingDrop | null;
	pendingDropPinData(): MapQ704PlotPinData | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE prop
// ─────────────────────────────────────────────────────────────────────────────

export interface MapHostPorts {
	store: MapHostStore;
	ui: MapUiPorts;
	gps: MapGpsPorts;
	scenes?: MapScenePorts;
	q704?: MapQ704Ports;
}
