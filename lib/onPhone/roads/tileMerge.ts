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

/**
 * Amortised byte writer over ONE growing Uint8Array. ⛔ do NOT go back to
 * `number[]` with a byte per `push()`: boxing hundreds of thousands of small
 * ints per merge was the ~290 MB spike / 1–2 s freeze per zoom change
 * (2026-09-02).
 */
class Writer {
	private buf: Uint8Array;
	private len = 0;

	constructor(capacity = 1 << 16) {
		this.buf = new Uint8Array(capacity);
	}

	private ensure(n: number): void {
		if (this.len + n <= this.buf.length) return;
		let cap = this.buf.length * 2;
		while (cap < this.len + n) cap *= 2;
		const next = new Uint8Array(cap);
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
	}

	varint(v: number): void {
		this.ensure(5);
		while (v > 0x7f) {
			this.buf[this.len++] = (v & 0x7f) | 0x80;
			v = Math.floor(v / 128);
		}
		this.buf[this.len++] = v;
	}

	bytes(b: Uint8Array): void {
		this.ensure(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
	}

	finish(): Uint8Array {
		return this.buf.slice(0, this.len);
	}
}

/** Byte length a value's varint will occupy — sizing pass, no allocation. */
function varintLen(v: number): number {
	let n = 1;
	while (v > 0x7f) {
		v = Math.floor(v / 128);
		n++;
	}
	return n;
}

/** Write a varint straight into a pre-sized buffer; returns bytes written. */
function writeVarintTo(buf: Uint8Array, pos: number, value: number): number {
	let v = value;
	let p = pos;
	while (v > 0x7f) {
		buf[p++] = (v & 0x7f) | 0x80;
		v = Math.floor(v / 128);
	}
	buf[p++] = v;
	return p - pos;
}

// module-level and REUSED — a fresh TextDecoder per field was per-byte churn
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

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
	/** Layer fields that are NOT name/keys/values/features/extent (e.g. version), kept as raw segments. */
	header: Uint8Array[];
	features: Uint8Array[];
	keys: string[];
	/** Raw encoded Value messages, kept verbatim — they may be any scalar type. */
	values: Uint8Array[];
	extent: number;
}

function splitLayer(layer: Uint8Array): LayerParts {
	const header: Uint8Array[] = [];
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
			name = DECODER.decode(layer.subarray(p, p + len));
			p += len;
			continue;
		}
		if (field === 3 && wire === 2) {
			let len: number;
			[len, p] = readVarint(layer, p);
			keys.push(DECODER.decode(layer.subarray(p, p + len)));
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
		// verbatim SEGMENT copy, not byte-per-push
		header.push(layer.subarray(start, next));
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
	// pass 1 — locate EVERY tags field (field 2) and pre-resolve its index pairs
	const spans: Array<{ start: number; end: number; indices: number[] }> = [];
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
			const indices: number[] = [];
			while (p < end) {
				let k: number;
				let v: number;
				[k, p] = readVarint(feature, p);
				[v, p] = readVarint(feature, p);
				indices.push(keyMap[k] ?? k, valMap[v] ?? v);
			}
			spans.push({ start, end, indices });
		} else {
			p = skipField(feature, wire, p);
		}
	}
	if (!spans.length) return feature; // zero-copy — nothing to remap
	// pass 2 — size the output ONCE, then splice in one pre-allocated buffer.
	// The rewritten tag header is canonical: field 2, wire 2 → one 0x12 byte.
	let size = feature.length;
	for (const s of spans) {
		let bodyLen = 0;
		for (const n of s.indices) bodyLen += varintLen(n);
		size -= s.end - s.start;
		size += 1 + varintLen(bodyLen) + bodyLen;
	}
	const out = new Uint8Array(size);
	let w = 0;
	let r = 0;
	for (const s of spans) {
		out.set(feature.subarray(r, s.start), w); // bytes before the tags field
		w += s.start - r;
		out[w++] = (2 << 3) | 2;
		let bodyLen = 0;
		for (const n of s.indices) bodyLen += varintLen(n);
		w += writeVarintTo(out, w, bodyLen);
		for (const n of s.indices) w += writeVarintTo(out, w, n);
		r = s.end;
	}
	out.set(feature.subarray(r), w);
	return out;
}

/**
 * Merge blob tiles of the SAME address into ONE tile: same-named layers fuse
 * into a single layer (one `roads`), keys/values tables merged with per-feature
 * tag remap, features copied verbatim. Order-independent — every owner draws.
 */
export function mergeSameFrameTiles(parts: readonly Uint8Array[]): Uint8Array {
	// keyIndex/valIndex ride along so table dedupe is O(1) per entry — the old
	// indexOf/findIndex scans made table merge O(n²) on real tiles (2026-09-02).
	const byName = new Map<
		string,
		{
			parts: LayerParts;
			keyIndex: Map<string, number>;
			valIndex: Map<string, number>;
		}
	>();

	for (const data of parts) {
		if (!data || data.byteLength === 0) continue;
		for (const raw of splitTile(data)) {
			const src = splitLayer(raw);
			let dst = byName.get(src.name);
			if (!dst) {
				dst = {
					parts: {
						name: src.name,
						header: src.header,
						features: [],
						keys: [],
						values: [],
						extent: src.extent,
					},
					keyIndex: new Map(),
					valIndex: new Map(),
				};
				byName.set(src.name, dst);
			}

			// MERGE THE TABLES and re-index this tile's tags into them — same
			// law as oneBlob.ts: without the remap a `kind` index resolves to a
			// different string (a highway rendered as a foot trail).
			const keyMap: number[] = src.keys.map((k) => {
				let i = dst.keyIndex.get(k);
				if (i === undefined) {
					i = dst.parts.keys.length;
					dst.parts.keys.push(k);
					dst.keyIndex.set(k, i);
				}
				return i;
			});
			const valMap: number[] = src.values.map((v) => {
				const id = valueId(v);
				let i = dst.valIndex.get(id);
				if (i === undefined) {
					i = dst.parts.values.length;
					dst.parts.values.push(v);
					dst.valIndex.set(id, i);
				}
				return i;
			});
			for (const f of src.features) {
				dst.parts.features.push(remapTags(f, keyMap, valMap));
			}
		}
	}

	// ONE amortised buffer per message (Writer) — the previous byte-per-push
	// into JS number[] arrays was the 290 MB spike / 1–2 s freeze per zoom
	// gesture (2026-09-02). Wire format is unchanged.
	const out = new Writer();
	for (const layer of byName.values()) {
		if (!layer.parts.features.length) continue; // never ship a husk layer
		const body = new Writer();
		// name (field 1)
		const nameBytes = ENCODER.encode(layer.parts.name);
		body.varint((1 << 3) | 2);
		body.varint(nameBytes.length);
		body.bytes(nameBytes);
		// keys (field 3) — the MERGED table every feature's tags now index into
		for (const k of layer.parts.keys) {
			const kb = ENCODER.encode(k);
			body.varint((3 << 3) | 2);
			body.varint(kb.length);
			body.bytes(kb);
		}
		// values (field 4) — raw Value messages, copied verbatim
		for (const v of layer.parts.values) {
			body.varint((4 << 3) | 2);
			body.varint(v.length);
			body.bytes(v);
		}
		// anything else the source layer carried (e.g. version)
		for (const seg of layer.parts.header) body.bytes(seg);
		// extent, declared once
		body.varint((5 << 3) | 0);
		body.varint(layer.parts.extent);
		for (const f of layer.parts.features) {
			body.varint((2 << 3) | 2);
			body.varint(f.length);
			body.bytes(f);
		}
		const bodyBytes = body.finish();
		out.varint((3 << 3) | 2);
		out.varint(bodyBytes.length);
		out.bytes(bodyBytes);
	}
	return out.finish();
}

