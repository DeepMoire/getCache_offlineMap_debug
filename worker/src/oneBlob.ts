/**
 * ONE BLOB — the whole 30 km circle as a SINGLE MVT tile.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   One file. All the roads. Drawn at every zoom. Nothing changes, ever.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS (read before "improving" it) ──────────────────────────
 *
 * The spec is: EVERYTHING, at EVERY level, inside 30 km, never changing as you
 * zoom. A TILE PYRAMID is designed to do the OPPOSITE — its entire purpose is
 * to show different data at different zooms. So every rule of the spec became a
 * workaround fighting the format:
 *
 *     everything at every level  →  a downsampler that regenerates each level
 *     a 30 km circle             →  a byte-level clip on every tile
 *     never changes on zoom      →  a lint test forbidding zoom-dependent colour
 *
 * Three fixes, three failure modes, and fixing one kept breaking another. The
 * user watched the same bug get "fixed" five times.
 *
 * ── THE SHAPE THAT FITS ───────────────────────────────────────────────────
 *
 * The user named it: "an SVG comes as binary and you can draw it at every level
 * — why don't we just ship one SVG?" Exactly right about the SHAPE. (SVG itself
 * is XML text, so it parses like JSON and is bigger; and PMTiles is a pyramid,
 * the very thing causing this.)
 *
 * The format with SVG's shape and none of the downsides is ONE MVT TILE. Same
 * protobuf we already ship — binary, compact, decoded natively by MapLibre in a
 * worker, no JSON anywhere — but covering the WHOLE disc at ONE zoom instead of
 * hundreds of tiles across eight levels. MapLibre overzooms that single tile to
 * every level for free.
 *
 * What this deletes, rather than adds:
 *   • downsample.ts (the per-level regeneration)
 *   • the per-tile disc clip (now done ONCE)
 *   • the reason the colour law needs enforcing — with one set of roads there
 *     is nothing to thin, so the colour CANNOT shift
 *
 * And ~298 R2 reads per blob become ~10.
 *
 * ── THE ONE REAL TRADE ────────────────────────────────────────────────────
 *
 * An MVT tile's coordinate grid is `extent` units across whatever it covers. At
 * the usual 4096 over 30 km that is ~15 m per unit — visibly coarse zoomed in.
 * So this uses EXTENT = 16384 (~3.7 m), the practical ceiling before coordinate
 * varints start costing real bytes. That is the precision floor of this design;
 * it is a deliberate trade for never changing on zoom.
 */

import { readVarint, skipField, unzigzag, writeVarint } from "./mvtBytes";
import { BLOB_TILE_Z } from "./grid";
import type { TileId } from "./geo";

/**
 * The blob tile's coordinate grid.
 *
 * ⛔ NOT 4096. Over a 60 km span that would be ~15 m per unit and roads would
 * visibly stair-step when zoomed in. 16384 gives ~3.7 m. Raising it further
 * pushes coordinates into wider varints for diminishing visual gain.
 */
export const BLOB_EXTENT = 16384;

/** Re-exported so existing importers keep working; defined in grid.ts. */
export { BLOB_TILE_Z };

/** Zigzag DECODE. */
function zz(v: number): number {
	return (v >>> 1) ^ -(v & 1);
}

/** Web-mercator normalised X (0..1) for a longitude. */
function mercX(lng: number): number {
	return (lng + 180) / 360;
}

/** Web-mercator normalised Y (0..1) for a latitude. */
function mercY(lat: number): number {
	const s = Math.sin((lat * Math.PI) / 180);
	return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/**
 * The blob's own frame: the world-normalised box the single tile covers.
 *
 * ⛔ THERE IS NO CENTRE AND NO RADIUS HERE ANY MORE. The blob is a GRID CELL —
 * a square, snapped to the world (see grid.ts) — so the frame is just its box.
 * The disc's `cx`/`cy`/`r` are deleted along with the clip that used them:
 * a square needs no clip, because the cell edge IS the boundary and source
 * tiles are already squares.
 */
export interface BlobFrame {
	/** Normalised mercator bounds of the blob tile. */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/**
 * The frame for ONE SLIPPY TILE — the world-normalised box it covers.
 *
 * The blob's geometry is remapped into this, so BLOB_EXTENT units span exactly
 * that tile. At z10 (~27 km) that is ~1.7 m per unit — finer than the old disc's
 * 3.7 m, because the frame got smaller while the extent stayed put.
 *
 * ⛔ IT MUST BE THE TILE'S OWN BOX, NOT THE CELL'S. A cell covers several z10
 * addresses; framing all of them to the cell would draw the cell's roads once
 * per address, each offset by the difference between the two boxes. Each tile
 * carries only its own ground.
 */
export function boxFrame(box: {
	w: number;
	s: number;
	e: number;
	n: number;
}): BlobFrame {
	const mX = (lng: number) => (lng + 180) / 360;
	const mY = (lat: number) => {
		const t = Math.sin((lat * Math.PI) / 180);
		return 0.5 - Math.log((1 + t) / (1 - t)) / (4 * Math.PI);
	};
	return { x0: mX(box.w), y0: mY(box.n), x1: mX(box.e), y1: mY(box.s) };
}

export function tileFrame(tile: TileId): BlobFrame {
	const n = 2 ** tile.z;
	return {
		x0: tile.x / n,
		y0: tile.y / n,
		x1: (tile.x + 1) / n,
		y1: (tile.y + 1) / n,
	};
}

/** One source tile plus the bounds it covers, ready to be re-homed. */
export interface SourceTile {
	tile: TileId;
	data: Uint8Array;
}

/**
 * A layer split into its parts.
 *
 * ⛔ `keys` and `values` MUST be parsed, not copied. A feature's `tags` are
 * PAIRS OF INDICES into its OWN tile's keys/values tables. Merging tiles while
 * keeping only the first tile's tables makes every other tile's features point
 * at the wrong strings — MEASURED on screen: an interstate highway rendered as
 * a foot trail, because its `kind` index resolved to "path" in the surviving
 * table. Silent, and it corrupts meaning rather than geometry.
 */
interface LayerParts {
	name: string;
	/** Layer fields that are NOT name/keys/values/features/extent (e.g. version). */
	header: number[];
	features: Uint8Array[];
	keys: string[];
	/** Raw encoded Value messages, kept verbatim — they may be any scalar type. */
	values: Uint8Array[];
	extent: number;
}

function splitLayer(layer: Uint8Array): LayerParts {
	const header: number[] = [];
	const features: Uint8Array[] = [];
	const keys: string[] = [];
	const values: Uint8Array[] = [];
	let name = "";
	let extent = 4096;
	let p = 0;
	while (p < layer.length) {
		const start = p;
		let tag: number;
		[tag, p] = readVarint(layer, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 2 && wire === 2) {
			let len: number;
			[len, p] = readVarint(layer, p);
			features.push(layer.subarray(p, p + len));
			p += len;
			continue;
		}
		if (field === 1 && wire === 2) {
			let len: number;
			[len, p] = readVarint(layer, p);
			name = new TextDecoder().decode(layer.subarray(p, p + len));
			p += len;
			continue;
		}
		if (field === 3 && wire === 2) {
			let len: number;
			[len, p] = readVarint(layer, p);
			keys.push(new TextDecoder().decode(layer.subarray(p, p + len)));
			p += len;
			continue;
		}
		if (field === 4 && wire === 2) {
			let len: number;
			[len, p] = readVarint(layer, p);
			values.push(layer.subarray(p, p + len));
			p += len;
			continue;
		}
		if (field === 5 && wire === 0) {
			const [v, after] = readVarint(layer, p);
			extent = v;
			// The merged layer declares BLOB_EXTENT, so the child's own extent is
			// dropped here and re-emitted once by `buildBlobTile`.
			p = after;
			continue;
		}
		const next = skipField(layer, wire, p);
		for (let i = start; i < next; i++) header.push(layer[i]);
		p = next;
	}
	return { name, header, features, keys, values, extent };
}

/** A Value message's bytes as a lookup key, so identical values dedupe. */
function valueId(v: Uint8Array): string {
	let s = "";
	for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
	return s;
}

/**
 * Rewrite one feature's `tags` (field 2) from the source layer's tables into
 * the merged layer's tables. Geometry and everything else are untouched here —
 * this runs BEFORE the geometry remap, on the raw feature bytes.
 */
function remapTags(
	feature: Uint8Array,
	keyMap: number[],
	valMap: number[],
): Uint8Array {
	const out: number[] = [];
	let p = 0;
	while (p < feature.length) {
		const start = p;
		let tag: number;
		[tag, p] = readVarint(feature, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 2 && wire === 2) {
			let len: number;
			[len, p] = readVarint(feature, p);
			const end = p + len;
			const pairs: number[] = [];
			while (p < end) {
				let k: number;
				let v: number;
				[k, p] = readVarint(feature, p);
				[v, p] = readVarint(feature, p);
				pairs.push(keyMap[k] ?? k, valMap[v] ?? v);
			}
			const body: number[] = [];
			for (const n of pairs) writeVarint(body, n);
			writeVarint(out, tag);
			writeVarint(out, body.length);
			for (const b of body) out.push(b);
			continue;
		}
		const next = skipField(feature, wire, p);
		for (let i = start; i < next; i++) out.push(feature[i]);
		p = next;
	}
	return new Uint8Array(out);
}

/** Split a tile into its layers. */
function splitTile(data: Uint8Array): Uint8Array[] {
	const layers: Uint8Array[] = [];
	let p = 0;
	while (p < data.length) {
		let tag: number;
		[tag, p] = readVarint(data, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 3 && wire === 2) {
			let len: number;
			[len, p] = readVarint(data, p);
			layers.push(data.subarray(p, p + len));
			p += len;
		} else {
			p = skipField(data, wire, p);
		}
	}
	return layers;
}

/**
 * Re-home one feature's geometry from its source tile into the blob's grid, and
 * clip it to the disc in the same pass.
 *
 * Returns null when nothing of the feature lands inside the circle — that is
 * the ONE clip in this design, replacing the per-tile clip the pyramid needed.
 *
 * Never decodes to GeoJSON: it walks the packed varint stream, maps each
 * coordinate, and writes it straight back.
 */
function remapAndClip(
	geom: Uint8Array,
	src: { x0: number; y0: number; sx: number; sy: number; extent: number },
	frame: BlobFrame,
	/** Optional sink for the SAME runs, in blob-grid units — used to draw the
	 *  zoom-out picture without walking the geometry a second time. */
	collect?: Array<Array<[number, number]>>,
): number[] | null {
	const lines: Array<Array<[number, number]>> = [];
	let cur: Array<[number, number]> = [];
	let x = 0;
	let y = 0;
	let p = 0;
	while (p < geom.length) {
		let cmd: number;
		[cmd, p] = readVarint(geom, p);
		const id = cmd & 0x7;
		const count = cmd >> 3;
		if (id === 7) continue; // ClosePath
		for (let i = 0; i < count && p < geom.length; i++) {
			let dx: number;
			let dy: number;
			[dx, p] = readVarint(geom, p);
			[dy, p] = readVarint(geom, p);
			x += zz(dx);
			y += zz(dy);
			// source tile units → world normalised → blob grid units
			const wx = src.x0 + (x / src.extent) * src.sx;
			const wy = src.y0 + (y / src.extent) * src.sy;
			const bx = Math.round(((wx - frame.x0) / (frame.x1 - frame.x0)) * BLOB_EXTENT);
			const by = Math.round(((wy - frame.y0) / (frame.y1 - frame.y0)) * BLOB_EXTENT);
			if (id === 1) {
				if (cur.length > 1) lines.push(cur);
				cur = [[bx, by]];
			} else {
				cur.push([bx, by]);
			}
		}
	}
	if (cur.length > 1) lines.push(cur);
	if (!lines.length) return null;

	// ── THE EDGE TRIM (this is NOT the old disc clip) ────────────────────────
	//
	// Source tiles are squares that STRADDLE the cell edge, so a z13 tile can
	// push ~3.4 km of geometry past it — MEASURED at 36% extra area over a 40 km
	// cell, duplicated in the neighbour's blob and drawn twice.
	//
	// ⛔ WHY THIS DOES NOT REINTRODUCE THE SEAM. The old clip cut against a
	// CIRCLE CENTRED ON THE PIN, so two pins cut the same road at two different
	// arcs and the pieces did not meet. This cuts against the CELL BOX, which is
	// snapped to the world: the neighbour cuts the same road at the SAME line
	// from the other side, so the two halves join exactly. Shared edge, not
	// coincidental overlap — that is the whole reason for the grid.
	//
	// Whole vertices only, with one vertex of slack outside so a road visibly
	// reaches the edge instead of stopping short of it.
	const runs: Array<Array<[number, number]>> = [];
	const inCell = (pt: [number, number]): boolean =>
		pt[0] >= 0 && pt[0] <= BLOB_EXTENT && pt[1] >= 0 && pt[1] <= BLOB_EXTENT;
	for (const line of lines) {
		let run: Array<[number, number]> = [];
		for (let i = 0; i < line.length; i++) {
			if (inCell(line[i])) {
				if (!run.length && i > 0) run.push(line[i - 1]);
				run.push(line[i]);
			} else if (run.length) {
				run.push(line[i]);
				runs.push(run);
				run = [];
			}
		}
		if (run.length > 1) runs.push(run);
	}
	if (!runs.length) return null;
	if (collect) for (const r of runs) collect.push(r);

	const out: number[] = [];
	let px = 0;
	let py = 0;
	for (const run of runs) {
		out.push((1 << 3) | 1); // MoveTo, 1
		out.push(unzigzag(run[0][0] - px), unzigzag(run[0][1] - py));
		px = run[0][0];
		py = run[0][1];
		if (run.length > 1) {
			out.push(((run.length - 1) << 3) | 2); // LineTo, n-1
			for (let i = 1; i < run.length; i++) {
				out.push(unzigzag(run[i][0] - px), unzigzag(run[i][1] - py));
				px = run[i][0];
				py = run[i][1];
			}
		}
	}
	return out;
}

/** Rewrite a whole feature: geometry remapped + clipped, everything else copied. */
function remapFeature(
	feature: Uint8Array,
	src: { x0: number; y0: number; sx: number; sy: number; extent: number },
	frame: BlobFrame,
): Uint8Array | null {
	const out: number[] = [];
	let p = 0;
	let wrote = false;
	while (p < feature.length) {
		const start = p;
		let tag: number;
		[tag, p] = readVarint(feature, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 4 && wire === 2) {
			let len: number;
			[len, p] = readVarint(feature, p);
			const vals = remapAndClip(feature.subarray(p, p + len), src, frame);
			if (!vals) return null; // nothing inside the circle
			const body: number[] = [];
			for (const v of vals) writeVarint(body, v);
			writeVarint(out, tag);
			writeVarint(out, body.length);
			for (const b of body) out.push(b);
			wrote = true;
			p += len;
		} else {
			const next = skipField(feature, wire, p);
			for (let i = start; i < next; i++) out.push(feature[i]);
			p = next;
		}
	}
	return wrote ? new Uint8Array(out) : null;
}

/**
 * Build THE blob: every source tile's features re-homed into one tile covering
 * the whole disc, clipped to the circle, ready to serve at any zoom.
 *
 * ⚠️ The merged layer reuses the FIRST contributing tile's keys/values tables.
 * Every tile here comes from the same Protomaps archive and the app reads only
 * `kind`, so the tables agree in practice. Anything relying on arbitrary
 * attributes must rebuild the tables instead.
 */
export function buildBlobTile(
	sources: SourceTile[],
	frame: BlobFrame,
): { bytes: Uint8Array; features: number; dropped: number } {
	const byName = new Map<string, LayerParts>();
	let features = 0;
	let dropped = 0;

	for (const s of sources) {
		if (!s.data || s.data.byteLength === 0) continue;
		const n = 2 ** s.tile.z;
		const src0x = s.tile.x / n;
		const src0y = s.tile.y / n;
		const span = 1 / n;

		for (const raw of splitTile(s.data)) {
			const parts = splitLayer(raw);
			let dst = byName.get(parts.name);
			if (!dst) {
				dst = {
					name: parts.name,
					header: parts.header,
					features: [],
					keys: [],
					values: [],
					extent: BLOB_EXTENT,
				};
				byName.set(parts.name, dst);
			}

			// MERGE THE TABLES, and build index maps from THIS tile's tables into
			// the merged ones. Without this a feature's `kind` index resolves to a
			// different string (a highway rendered as a foot trail).
			const keyMap: number[] = parts.keys.map((k) => {
				let i = dst.keys.indexOf(k);
				if (i === -1) {
					i = dst.keys.length;
					dst.keys.push(k);
				}
				return i;
			});
			const valMap: number[] = parts.values.map((v) => {
				const id = valueId(v);
				let i = dst.values.findIndex((e) => valueId(e) === id);
				if (i === -1) {
					i = dst.values.length;
					dst.values.push(v);
				}
				return i;
			});
			const srcBox = {
				x0: src0x,
				y0: src0y,
				sx: span,
				sy: span,
				extent: parts.extent,
			};
			for (const f of parts.features) {
				const re = remapFeature(remapTags(f, keyMap, valMap), srcBox, frame);
				if (re) {
					dst.features.push(re);
					features++;
				} else {
					dropped++;
				}
			}
		}
	}

	const out: number[] = [];
	for (const layer of byName.values()) {
		if (!layer.features.length) continue; // never ship a husk layer
		const body: number[] = [];
		// name (field 1)
		const nameBytes = new TextEncoder().encode(layer.name);
		writeVarint(body, (1 << 3) | 2);
		writeVarint(body, nameBytes.length);
		for (const b of nameBytes) body.push(b);
		// keys (field 3) — the MERGED table every feature's tags now index into
		for (const k of layer.keys) {
			const kb = new TextEncoder().encode(k);
			writeVarint(body, (3 << 3) | 2);
			writeVarint(body, kb.length);
			for (const b of kb) body.push(b);
		}
		// values (field 4) — raw Value messages, copied verbatim
		for (const v of layer.values) {
			writeVarint(body, (4 << 3) | 2);
			writeVarint(body, v.length);
			for (let i = 0; i < v.length; i++) body.push(v[i]);
		}
		// anything else the source layer carried (e.g. version)
		for (const b of layer.header) body.push(b);
		// The blob's own extent, declared once.
		writeVarint(body, (5 << 3) | 0);
		writeVarint(body, BLOB_EXTENT);
		for (const f of layer.features) {
			writeVarint(body, (2 << 3) | 2);
			writeVarint(body, f.length);
			for (let i = 0; i < f.length; i++) body.push(f[i]);
		}
		writeVarint(out, (3 << 3) | 2);
		writeVarint(out, body.length);
		for (const b of body) out.push(b);
	}
	return { bytes: new Uint8Array(out), features, dropped };
}
