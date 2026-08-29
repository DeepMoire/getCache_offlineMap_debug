/** HOST PORTS — the narrow interface between the offline map engine and whatever app hosts it. */

/** A place the map should keep offline: its anchor points plus the two facts the bake order depends on. */
export interface HostPlace {
	/** Anchor coordinates, [lng, lat]. A point has one; a line has many. */
	anchors: [number, number][];
	/** ISO timestamp of the last edit. Newest bakes first and is evicted last. */
	lastTouched: string;
	/** True for lines/corridors — baked along their length rather than as a single disc. */
	corridor: boolean;

	// Display metadata only — the bake service ignores these; a blob is identified by areaKey, never by name.

	/** Stable id of the feature this place came from. */
	featureKey?: string;
	/** Human name, for the inspector's cards. */
	featureName?: string;
	/** Feature type ("Point", "LineString", a PDF overlay…). */
	featureType?: string;
	/** Id of the map/collection that owns it. */
	groupKey?: string;
	/** Human name of that map — the inspector nests cards under it. */
	groupName?: string;
}

/** One hotspot, trimmed to what the map renders. ⚠️ Must stay structurally assignable to the host's hotspot type both ways — keep required fields required, optional optional. */
export interface PortHotspot {
	/** [lng, lat] — GeoJSON order. */
	readonly coordinates: [number, number];
	/** Acquisition time, UTC epoch ms. Drives the age-colour ramp. */
	readonly t: number;
	/** Detection confidence. */
	readonly c: "low" | "nominal" | "high";
	/** Fire radiative power, MW. */
	readonly frp: number;
	/** Pixel footprint in km. Optional — an older cached record predates it. */
	readonly px?: number;
	/** Day / Night overpass. */
	readonly dn?: "D" | "N";
}

/** What one area's fire fetch returns. */
export interface PortFireResult {
	hotspots: readonly PortHotspot[];
	/** The SERVER's fetch time — using our own clock would overstate freshness by the cache TTL, since the edge may serve a cached slice. */
	fetchedAt: number;
	/** How many upstream satellites reported. */
	sourcesOk: number;
	/** Response size, for the cellular-gate tally. */
	bytes: number;
}

/** Fire layer, as the bake service consumes it. ⚠️ arrival is a consume-once debt per reader (not a shared boolean) — merging readers let the bake tick race-eat the flag before the map ran. */
export interface FirePort {
	/** Fetch hotspots for one area. Omit the whole `fires` port to disable fire baking. */
	fetchArea(lng: number, lat: number): Promise<PortFireResult>;
	/** ARM every reader — call on app open, visibility-return and `online`. */
	arrival(): void;
	/** Clear THIS reader's debt and report whether it was owed. */
	takeArrival(): boolean;

	/** This area's cached record, or null if absent / written by an older format. */
	read(areaKey: string): Promise<FireRecord | null>;
	/** Store a freshly fetched record for this area. */
	write(areaKey: string, rec: FireRecord): Promise<void>;
	/** Drop this area's hotspots — an evicted area sheds ALL its data together. */
	delete(areaKey: string): Promise<void>;
	/** Is this record still within its freshness TTL? */
	isFresh(rec: FireRecord): boolean;
	/** Centres + times of every cached disc — NO hotspots. ⚠️ Deliberately coverage-only: pulling full records here held tens of thousands of detections live in the bake service's heap. */
	coverage(): Promise<FireCoverage[]>;
	/** Is this coverage entry fresh enough to count as covering an area? */
	isCoverageFresh(c: FireCoverage): boolean;
}

/** One cached fire record, as the engine reads and writes it. */
export interface FireRecord {
	fetchedAt: number;
	center: [number, number];
	radiusKm: number;
	sourcesOk: number;
	hotspots: readonly PortHotspot[];
}

/** A cached disc's centre, size and age — no hotspots. */
export interface FireCoverage {
	readonly center: [number, number];
	readonly radiusKm: number;
	readonly fetchedAt: number;
}

export interface HostPorts {
	/** Every place to keep offline, right now. Called on each reconcile pass. */
	places(): HostPlace[];
	/** Has the host finished loading? ⚠️ Eviction depends on this — a cold-reload host that's still hydrating looks "empty" but is NOT "no places"; treating those the same nuked stored blobs (the "1 GB → 70 MB" collapse). A host with nothing to hydrate should return true. */
	ready(): boolean;
	/** Register for "the list changed" — a PUSH, not a reactive read; must fire on every add/move/delete/import/restore, and once on register. ⚠️ Required, not a preference — an $effect reading host state across a module boundary silently failed to fire on a fresh pin drop. */
	onPlacesChanged(fn: () => void): () => void;
	/** WRITE A PLACE — the dropped pin becomes a place so places()/onPlacesChanged/bake all see it. ⛔ Without this port, dropped pins lived only in memory and nothing was ever requested for them (measured bug, 28 Aug 2026). Optional so a read-only host still type-checks — but omitting it means dropping a pin downloads nothing. */
	addPlace?(lngLat: [number, number], name: string): void;
	/** Optional fire layer. Omit → the engine bakes no fires and never calls out for them. */
	fires?: FirePort;
	/** Optional live position, [lng, lat]. Omit → no live anchor; features only. */
	gps?: () => Promise<[number, number] | null>;
}
