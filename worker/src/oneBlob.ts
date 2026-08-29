import { readVarint, skipField, unzigzag, writeVarint } from "./mvtBytes";
import { BLOB_TILE_Z } from "./grid";
import type { TileId } from "./geo";

/** The blob tile's coordinate grid. ⛔ NOT 4096 — over a 60 km span that's ~15 m/unit and roads stair-step; 16384 gives ~3.7 m, the ceiling before varints cost more bytes. */
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

/** The blob's own frame: the world-normalised box the tile covers. ⛔ NO centre/radius — it's a grid-cell square, so the cell edge IS the boundary; the disc's cx/cy/r are gone. */
export interface BlobFrame {
	/** Normalised mercator bounds of the blob tile. */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The world-normalised box for ONE slippy tile. ⛔ Must be the tile's OWN box, not the cell's — framing to the cell would draw its roads once per address, offset each time. */
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

/** A layer split into its parts. ⛔ `keys`/`values` MUST be parsed, not copied — a feature's tags are index pairs into its OWN tile's tables; keeping only the first tile's tables silently resolves other features to the wrong string (highway → foot trail). */
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
			// The merged layer declares BLOB_EXTENT; each child's own extent is dropped here, re-emitted once by buildBlobTile.
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

/** Rewrites a feature's `tags` (field 2) from source-layer table indices into merged-layer indices; runs before the geometry remap, on raw feature bytes. */
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

/** Re-homes one feature's geometry into the blob's grid and clips it in the same pass (the one clip in this design); walks the packed varint stream directly, never decoding to GeoJSON. */
function remapAndClip(
	geom: Uint8Array,
	src: { x0: number; y0: number; sx: number; sy: number; extent: number },
	frame: BlobFrame,
	/** Optional sink for the same runs, in blob-grid units — avoids walking the geometry twice for the zoom-out picture. */
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

	// ⛔ Cuts against the CELL BOX (not the old pin-centred circle) — the neighbour cuts the same road at the SAME shared edge, so the two halves join exactly.
	// Whole vertices only, with one vertex of slack outside so a road visibly reaches the edge rather than stopping short of it.
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

/** Builds THE blob: every source tile's features re-homed into one tile, ready to serve at any zoom. ⚠️ Reuses the FIRST tile's keys/values tables — fine since the app only reads `kind`; anything needing arbitrary attributes must rebuild the tables. */
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

			// Merges the tables and builds index maps — without this a feature's `kind` index resolves to the wrong string (highway → foot trail).
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
