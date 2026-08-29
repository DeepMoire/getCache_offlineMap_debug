/**
 * WHAT THE PACK SHIPS — the one list of source-layers (and the feature kinds
 * inside each) that a blob tile carries. Worker and phone both read THIS file.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   roads (all) · water (lakes + rivers) · places (city…hamlet) · pois (hospital, camp_site)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ⛔ WHY THIS IS A CONTRACT, NOT A WORKER CONSTANT. The keep-set used to live
 * only in `worker/src/packBuilder.ts`, and the phone's debug report answered
 * "does the pack hold this layer?" with `t.key === "vector"` — a hard-coded
 * "roads only" that could never learn otherwise. MEASURED 28 Aug 2026 on a
 * live pack: ONE source layer, `roads`, so Labels / Places / Hospitals all
 * reported `arrived:false` and nobody could tell a Worker gap from a phone
 * bug. Now the Worker filters BY this table and the report reads FROM it, so
 * the two cannot disagree — the same "one source, re-exported" rule as
 * `grid.ts` and `blob.ts`.
 *
 * ⚠️ THE ATTRIBUTE KEY MATTERS. Protomaps v4 tags every `places` feature
 * `kind: "locality"` and puts city/town/village/hamlet in `kind_detail`. The
 * old allowlist matched `kind` against "city" — MEASURED across the 324 z13
 * tiles of one disc: 214 places features, ALL `kind:locality`, so every one
 * was dropped and the layer shipped as a husk (then dropped as empty). The
 * phone's town-label filter made the identical mistake, so even a pack that
 * carried places would have drawn none. Each rule names its key.
 *
 * ── MEASURED (raw z13 feature bytes, one 30 km disc, lat 43.4, 28 Aug 2026) ──
 *     roads        444,675 B  2,394 feats   (everything — the whole pack today)
 *     water         66,858 B  polygons kind=water + 574 B lake
 *     river/canal   16,973 B  170 line feats
 *     stream        50,041 B  295 line feats   ← DROPPED: a third of the water
 *                                                 bytes for creeks sub-pixel at
 *                                                 any zoom the disc is drawn at
 *     places         7,159 B  214 pts (179 hamlets)
 *     pois             174 B  3 hospitals + 4 camp sites
 * Shipping the rows kept below adds ~92 kB raw to a 445 kB roads-only pack.
 */

/** One source-layer the pack carries, and which of its features survive. */
export interface PackLayerRule {
	/** The feature attribute the allowlist is matched against. Omitted = `kind`. */
	readonly key?: string;
	/** Feature values (of `key`) that ship. Omitted = the WHOLE layer ships. */
	readonly kinds?: readonly string[];
	/** One line for a human reading a debug report. */
	readonly why: string;
}

export const PACK_LAYERS: Readonly<Record<string, PackLayerRule>> = {
	roads: {
		why: "every road, path and rail line — nothing dropped by kind (one blob, drawn at every zoom)",
	},
	water: {
		kinds: ["water", "lake", "river", "canal"],
		why: "lake / pond polygons and river + canal lines; streams dropped (50 kB of sub-pixel creeks)",
	},
	places: {
		key: "kind_detail",
		kinds: ["city", "town", "village", "hamlet"],
		why: "town labels — Protomaps v4 files city/town/village/hamlet under kind_detail, kind is always `locality`",
	},
	pois: {
		kinds: ["hospital", "camp_site"],
		why: "the two icons the map draws — a handful of points per disc",
	},
};

/** The source-layer names the pack keeps, in table order. */
export const PACK_LAYER_NAMES: readonly string[] = Object.keys(PACK_LAYERS);

/** One thing a style layer reads out of the pack. */
export interface PackRead {
	readonly layer: string;
	/** Attribute key the style filters on. Omitted = `kind`. */
	readonly key?: string;
	/** Values the style filters for. Omitted = it reads the whole layer. */
	readonly kinds?: readonly string[];
}

/**
 * Does the pack carry what this read asks for? TRUE only when the layer ships
 * AND every kind the style filters on survives the Worker's allowlist under the
 * SAME attribute key — a style reading `kind:"city"` against a pack that keeps
 * `kind_detail:"city"` gets `false`, which is exactly the mismatch that hid.
 */
export function packShips(read: PackRead): boolean {
	const rule = PACK_LAYERS[read.layer];
	if (!rule) return false;
	if (!rule.kinds) return true;
	if (!read.kinds) return false; // style wants the whole layer, pack ships a subset
	if ((read.key ?? "kind") !== (rule.key ?? "kind")) return false;
	return read.kinds.every((k) => rule.kinds!.includes(k));
}

/** `roads (all)`, `pois kind∈{hospital,camp_site}` — for reports. */
export function describePackLayer(layer: string): string {
	const rule = PACK_LAYERS[layer];
	if (!rule) return `${layer} (NOT shipped)`;
	if (!rule.kinds) return `${layer} (all)`;
	return `${layer} ${rule.key ?? "kind"}∈{${rule.kinds.join(",")}}`;
}
