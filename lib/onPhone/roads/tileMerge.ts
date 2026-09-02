/**
 * Layer-level merge of MVT blobs that share the SAME address (same z/x/y frame).
 *
 * ⛔ NOT BYTE-CONCAT. Every pin's blob carries a layer named `roads`, and the MVT
 * parser indexes layers BY NAME — `layers[name] = layer` keeps only the LAST
 * duplicate and silently discards the others. Two pins owning one address meant
 * the whole tile flipped to one pin (the farthest, since keysForAddress sorts
 * ascending and concat order = winner order) whenever a pack landed and the
 * source re-requested — roads vanishing/appearing in axis-aligned strips
 * wherever the two pins' radius boxes differ (2026-09-01).
 *
 * The merge is frame-identical to the Worker's `buildBlobTile` table logic
 * (oneBlob.ts): features are copied VERBATIM — same frame, so no geometry remap
 * is needed — but every feature's `tags` are re-indexed from its own tile's
 * keys/values tables into the merged tables. ⚠️ parsing the tables is not
 * optional: tags are PAIRS OF INDICES into the tile's OWN tables, and skipping
 * the remap renders an interstate as a foot trail (measured on screen).
 */

/** Read a varint at `pos`. Returns [value, nextPos]. */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
	let result = 0;
	let shift = 0;
	let p = pos;
	for (;;) {
		const b = buf[p++];
		// * 2**shift, not <<: lengths can exceed 31 bits of headroom
		result += (b & 0x7f) * 2 ** shift;
		if ((b & 0x80) === 0) break;
		shift += 7;
	}
	return [result, p];
}

function writeVarint(out: number[], value: number): void {
	let v = value;
	while (v > 0x7f) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

/** Skip one protobuf field's payload; returns the new position. */
function skipField(buf: Uint8Array, wire: number, pos: number): number {
	let p = pos;
	if (wire === 0) [, p] = readVarint(buf, p);
	else if (wire === 2) {
		let len: number;
		[len, p] = readVarint(buf, p);
		p += len;
	} else if (wire === 5) p += 4;
	else if (wire === 1) p += 8;
	return p;
}

/** Split a tile message into its raw Layer messages (field 3). */
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

/** A layer split into its parts (frame-identical to oneBlob.ts's LayerParts). */
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
 * the merged layer's tables. Geometry and everything else are untouched —
 * same frame, so the geometry is already correct as-is.
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

/**
 * Merge blob tiles of the SAME address into ONE tile: same-named layers fuse
 * into a single layer (one `roads`), keys/values tables merged with per-feature
 * tag remap, features copied verbatim. Order-independent — every owner draws.
 */
export function mergeSameFrameTiles(parts: readonly Uint8Array[]): Uint8Array {
	const byName = new Map<string, LayerParts>();

	for (const data of parts) {
		if (!data || data.byteLength === 0) continue;
		for (const raw of splitTile(data)) {
			const src = splitLayer(raw);
			let dst = byName.get(src.name);
			if (!dst) {
				dst = {
					name: src.name,
					header: src.header,
					features: [],
					keys: [],
					values: [],
					extent: src.extent,
				};
				byName.set(src.name, dst);
			}

			// MERGE THE TABLES and re-index this tile's tags into them — same
			// law as oneBlob.ts: without the remap a `kind` index resolves to a
			// different string (a highway rendered as a foot trail).
			const keyMap: number[] = src.keys.map((k) => {
				let i = dst.keys.indexOf(k);
				if (i === -1) {
					i = dst.keys.length;
					dst.keys.push(k);
				}
				return i;
			});
			const valMap: number[] = src.values.map((v) => {
				const id = valueId(v);
				let i = dst.values.findIndex((e) => valueId(e) === id);
				if (i === -1) {
					i = dst.values.length;
					dst.values.push(v);
				}
				return i;
			});
			for (const f of src.features) {
				dst.features.push(remapTags(f, keyMap, valMap));
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
		// extent, declared once
		writeVarint(body, (5 << 3) | 0);
		writeVarint(body, layer.extent);
		for (const f of layer.features) {
			writeVarint(body, (2 << 3) | 2);
			writeVarint(body, f.length);
			for (let i = 0; i < f.length; i++) body.push(f[i]);
		}
		writeVarint(out, (3 << 3) | 2);
		writeVarint(out, body.length);
		for (const b of body) out.push(b);
	}
	return new Uint8Array(out);
}

