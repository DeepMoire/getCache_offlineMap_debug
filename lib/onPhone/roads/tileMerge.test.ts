import { describe, expect, it } from "vitest";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { mergeSameFrameTiles } from "./tileMerge";

// ── minimal protobuf writers (mirrors the MVT wire format the blobs use) ──

function writeVarint(out: number[], value: number): void {
	let v = value;
	while (v > 0x7f) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

function bytesField(field: number, payload: Uint8Array): number[] {
	const out: number[] = [];
	writeVarint(out, (field << 3) | 2);
	writeVarint(out, payload.length);
	for (const b of payload) out.push(b);
	return out;
}

/** A Value message carrying one string (field 1). */
function strValue(s: string): Uint8Array {
	return new Uint8Array(bytesField(1, new TextEncoder().encode(s)));
}

function feature(tags: number[]): Uint8Array {
	// field 2 = tags (packed varint pairs), field 3 = type LINESTRING, field 4 = one MoveTo command
	const packed: number[] = [];
	for (const n of tags) writeVarint(packed, n);
	const out: number[] = [];
	for (const b of bytesField(2, new Uint8Array(packed))) out.push(b);
	out.push((3 << 3) | 0, 2); // type = LINESTRING
	for (const b of bytesField(4, new Uint8Array([9, 4, 4]))) out.push(b); // MoveTo(+2,+2)
	return new Uint8Array(out);
}

function layer(
	name: string,
	keys: string[],
	values: Uint8Array[],
	features: Uint8Array[],
	extent = 16384,
): Uint8Array {
	const body: number[] = [];
	for (const b of bytesField(1, new TextEncoder().encode(name))) body.push(b);
	for (const k of keys)
		for (const b of bytesField(3, new TextEncoder().encode(k))) body.push(b);
	for (const v of values) for (const b of bytesField(4, v)) body.push(b);
	writeVarint(body, (5 << 3) | 0);
	writeVarint(body, extent); // extent
	for (const f of features) for (const b of bytesField(2, f)) body.push(b);
	return new Uint8Array(body);
}

function tile(layers: Uint8Array[]): Uint8Array {
	const out: number[] = [];
	for (const l of layers) for (const b of bytesField(3, l)) out.push(b);
	return new Uint8Array(out);
}

/** Exactly what two pins' blobs look like for one SHARED z8 address. */
function pinATile(): Uint8Array {
	return tile([
		layer("roads", ["kind"], [strValue("highway")], [
			feature([0, 0]),
			feature([0, 0]),
		]),
	]);
}
function pinBTile(): Uint8Array {
	// different table order AND extra key — the worst case for index remap
	return tile([
		layer("roads", ["ref", "kind"], [strValue("5"), strValue("path")], [
			feature([1, 1]), // kind = "path"
			feature([0, 0]), // ref = "5"
		]),
	]);
}

describe("mergeSameFrameTiles — two pins owning one address", () => {
	it("byte-concat keeps ONLY the last same-named layer (the bug this merge replaces)", () => {
		const concat = new Uint8Array(pinATile().length + pinBTile().length);
		concat.set(pinATile(), 0);
		concat.set(pinBTile(), pinATile().length);
		const roads = new VectorTile(new Pbf(concat)).layers.roads;
		// pin A's 2 features are GONE — the parser's layer map kept pin B's layer only
		expect(roads.length).toBe(2);
	});

	it("the merge keeps EVERY owner's features in ONE layer", () => {
		const merged = mergeSameFrameTiles([pinATile(), pinBTile()]);
		const t = new VectorTile(new Pbf(merged));
		expect(Object.keys(t.layers)).toEqual(["roads"]);
		expect(t.layers.roads.length).toBe(4);
	});

	it("tags resolve to each feature's OWN strings — no highway rendered as a foot trail", () => {
		const merged = mergeSameFrameTiles([pinATile(), pinBTile()]);
		const roads = new VectorTile(new Pbf(merged)).layers.roads;
		expect(roads.feature(0).properties.kind).toBe("highway");
		expect(roads.feature(1).properties.kind).toBe("highway");
		expect(roads.feature(2).properties.kind).toBe("path");
		expect(roads.feature(3).properties.ref).toBe("5");
	});

	it("is order-independent — the nearest pin must not win, the farthest must not win", () => {
		const ab = mergeSameFrameTiles([pinATile(), pinBTile()]);
		const ba = mergeSameFrameTiles([pinBTile(), pinATile()]);
		const abL = new VectorTile(new Pbf(ab)).layers.roads;
		const baL = new VectorTile(new Pbf(ba)).layers.roads;
		expect(abL.length).toBe(baL.length);
		const kinds = (l: typeof abL) =>
			Array.from({ length: l.length }, (_, i) => l.feature(i).properties.kind).sort();
		expect(kinds(abL)).toEqual(kinds(baL));
	});

	it("keeps extent, geometry and feature type intact", () => {
		const merged = mergeSameFrameTiles([pinATile(), pinBTile()]);
		const roads = new VectorTile(new Pbf(merged)).layers.roads;
		expect(roads.extent).toBe(16384);
		for (let i = 0; i < roads.length; i++) {
			expect(roads.feature(i).type).toBe(2);
			const g = roads.feature(i).loadGeometry();
			// LINESTRING geometry: one part, one vertex, at (+2,+2) — verbatim, un-remapped
			expect(g.length).toBe(1);
			expect(g[0].length).toBe(1);
			expect(g[0][0].x).toBe(2);
			expect(g[0][0].y).toBe(2);
		}
	});

	it("a single owner passes through unchanged in content", () => {
		const merged = mergeSameFrameTiles([pinATile()]);
		const roads = new VectorTile(new Pbf(merged)).layers.roads;
		expect(roads.length).toBe(2);
		expect(roads.feature(0).properties.kind).toBe("highway");
	});
});
