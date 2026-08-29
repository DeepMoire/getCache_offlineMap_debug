// ⛔ THE CLIP IS GONE — don't re-add per-tile circle clipping here; the unit is now a snapped square cell (grid.ts), trimmed against the cell frame in oneBlob.ts.

/** Read a varint at `pos`. Returns [value, nextPos]. */
export function readVarint(buf: Uint8Array, pos: number): [number, number] {
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

export function writeVarint(out: number[], value: number): void {
	let v = value;
	while (v > 0x7f) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

/** Skip one protobuf field's payload; returns the new position. */
export function skipField(buf: Uint8Array, wire: number, pos: number): number {
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

/** The `extent` (field 5) of a Layer. 4096 is the MVT default. */
export function layerExtent(layer: Uint8Array): number {
	let p = 0;
	while (p < layer.length) {
		let tag: number;
		[tag, p] = readVarint(layer, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 5 && wire === 0) {
			let v: number;
			[v, p] = readVarint(layer, p);
			return v;
		}
		p = skipField(layer, wire, p);
	}
	return 4096;
}

/** Zigzag ENCODE — the inverse of `zigzag`. */
export function unzigzag(v: number): number {
	return v < 0 ? -v * 2 - 1 : v * 2;
}

/** Feature `type` field (1=point, 2=line, 3=polygon). 0 when absent. */
export function featureType(feature: Uint8Array): number {
	let p = 0;
	while (p < feature.length) {
		let tag: number;
		[tag, p] = readVarint(feature, p);
		const field = tag >>> 3;
		const wire = tag & 7;
		if (field === 3 && wire === 0) {
			const [v] = readVarint(feature, p);
			return v;
		}
		p = skipField(feature, wire, p);
	}
	return 0;
}

export function featureIsLine(feature: Uint8Array): boolean {
	return featureType(feature) === 2;
}
