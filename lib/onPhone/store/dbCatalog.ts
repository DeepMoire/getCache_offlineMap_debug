/** ⚠️ Single source of truth for classifying this origin's IndexedDB DBs — register every new store here (isLiveBase or APP_DB) or it's misclassified as legacy and offered up for wipe. */

import {
	currentDbName,
	SANDBOX_SUFFIX,
} from "../../shared/sandboxDbNames";

/** TinyBase store (live user data, not offline-map). */
export const APP_DB = "rt-treeStuff";

// ⚠️ Don't delete these DB name literals — the DBs still exist on old devices and become unreachable storage orphans if unnamed here.
/** v4 Cloudflare tile pile. Dead — v5 does not write it. */
export const V4_TILES_DB = "gc-offlineTiles";
/** v3/v4 baked vector line art. Dead — v5 does not write it. */
export const LEGACY_VECTORS_DB_NAME = "rt-vectors";
/** Shared satellite photo blobs. ⛔ Keep this in sync with satelliteImage.ts's real DB name — a stale value here misclassifies live photos as legacy and offers them up for wipe. */
export const SAT_DB = "gc-offlineSatellite";
/** Pre-rename name; recognised so a device still holding the old DB is classified LIVE (migration source), never wipeable. */
export const SAT_DB_LEGACY_NAME = "rt-satellite";
/** Shared offline-coverage registry. */
export const REGISTRY_DB = "rt-mapRegistry";
/** Wildfire hotspots per area (v4FireCache); MUST stay registered here or /blobs offers to wipe the layer's only offline copy. */
export const FIRE_DB = "rt-fire-cache";

/** Strip a sandbox suffix down to the store's base name. */
export function baseDbName(db: string): string {
	return db.endsWith(SANDBOX_SUFFIX)
		? db.slice(0, -SANDBOX_SUFFIX.length)
		: db;
}

/** The OTHER world's name for a base store (`x` ⇄ `x-sandbox`). */
export function otherWorldDbName(base: string): string {
	return currentDbName(base) === base ? base + SANDBOX_SUFFIX : base;
}

/** True for a V4 wall-map vector-tile pile (either world); callers skip these in per-blob scans — tens of thousands of tiny blobs hang the page. */
export function isV4Tiles(db: string): boolean {
	const b = baseDbName(db);
	return b === V4_TILES_DB || b.startsWith("retreever-v4-tiles");
}

/** Base names of the live offline stores (this world OR the sandbox world). */
export function isLiveBase(b: string): boolean {
	return (
		// ONLY the current tile pile (DB_NAME) is live — an OLD version suffix must count as LEGACY, not hidden as "live".
		b === V4_TILES_DB ||
		b === SAT_DB ||
		b === SAT_DB_LEGACY_NAME ||
		b === REGISTRY_DB ||
		b === FIRE_DB ||
		// v3 is still the shipping offline map — PROTECT rt-vectors from legacy-wipe until v3 is unplugged, then this line can be dropped.
		b === LEGACY_VECTORS_DB_NAME
	);
}

/** Live offline DBs of the CURRENT world — resolved via currentDbName() for this page-load's mode. */
export function isLiveV4(db: string): boolean {
	const b = baseDbName(db);
	return isLiveBase(b) && db === currentDbName(b);
}

/** The OTHER world's protected data (sandbox twin in real mode, or vice versa); never legacy, never wipeable. */
export function isOtherWorld(db: string): boolean {
	const b = baseDbName(db);
	return (isLiveBase(b) || b === APP_DB) && db !== currentDbName(b);
}

/** Dead weight: neither a live store nor an app DB, in EITHER world. */
export function isLegacyDb(db: string): boolean {
	return !isLiveV4(db) && !isOtherWorld(db) && baseDbName(db) !== APP_DB;
}
