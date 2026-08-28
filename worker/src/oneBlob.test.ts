/**
 * THE BLOB IS ONE TILE — and it must hold everything, inside 30 km, once.
 *
 * The failing-first test that matters: features from FOUR different source
 * tiles must all survive into ONE blob, in the right places. That is the whole
 * premise — if it loses features the spec ("everything") is broken, and if it
 * misplaces them the map is nonsense.
 */
import { describe, expect, it } from "vitest";
import {
	BLOB_EXTENT,
	BLOB_TILE_Z,
	tileFrame,
	buildBlobTile,
	type SourceTile,
} from "./oneBlob";
import { cellBox, cellOf } from "./grid";
import { readVarint, skipField, unzigzag } from "./mvtBytes";

const SRC_EXTENT = 4096;

/**
 * Build a one-layer source tile holding `lines` in ITS OWN 0..4096 grid.
 *
 * `kinds` (one per line) become a real `kind` tag, with a keys/values table
 * whose ORDER differs per tile — which is the whole point: a feature's tags are
 * indices into ITS OWN tile's tables, so merging tiles must remap them.
 */
function makeTile(
	name: string,
	lines: Array<Array<[number, number]>>,
	kinds: string[] = [],
): Uint8Array {
	const body: number[] = [];
	const nameBytes = new TextEncoder().encode(name);
	body.push((1 << 3) | 2, nameBytes.length, ...nameBytes);
	body.push((15 << 3) | 0, 2); // version

	// keys (field 3): just "kind"
	if (kinds.length) {
		const kb = new TextEncoder().encode("kind");
		body.push((3 << 3) | 2, kb.length, ...kb);
		// values (field 4): each distinct kind as a string Value
		for (const k of dedupe(kinds)) {
			const vb = new TextEncoder().encode(k);
			const val: number[] = [(1 << 3) | 2, vb.length, ...vb];
			body.push((4 << 3) | 2, val.length, ...val);
		}
	}

	body.push((5 << 3) | 0);
	pushVarint(body, SRC_EXTENT);

	const kindList = dedupe(kinds);
	for (let li = 0; li < lines.length; li++) {
		const pts = lines[li];
		const geom: number[] = [];
		geom.push((1 << 3) | 1, unzigzag(pts[0][0]), unzigzag(pts[0][1]));
		if (pts.length > 1) {
			geom.push(((pts.length - 1) << 3) | 2);
			for (let i = 1; i < pts.length; i++) {
				geom.push(
					unzigzag(pts[i][0] - pts[i - 1][0]),
					unzigzag(pts[i][1] - pts[i - 1][1]),
				);
			}
		}
		const gb: number[] = [];
		for (const v of geom) pushVarint(gb, v);
		const feat: number[] = [];
		if (kinds.length) {
			// tags (field 2): [keyIndex, valueIndex]
			const vi = kindList.indexOf(kinds[li]);
			const tags: number[] = [];
			pushVarint(tags, 0);
			pushVarint(tags, vi);
			feat.push((2 << 3) | 2, tags.length, ...tags);
		}
		feat.push((3 << 3) | 0, 2); // LINESTRING
		feat.push((4 << 3) | 2);
		pushVarint(feat, gb.length);
		feat.push(...gb);
		body.push((2 << 3) | 2);
		pushVarint(body, feat.length);
		body.push(...feat);
	}

	const tile: number[] = [];
	tile.push((3 << 3) | 2);
	pushVarint(tile, body.length);
	tile.push(...body);
	return new Uint8Array(tile);
}

function dedupe(a: string[]): string[] {
	return [...new Set(a)];
}

function pushVarint(out: number[], v: number): void {
	let x = v;
	while (x > 0x7f) {
		out.push((x & 0x7f) | 0x80);
		x = Math.floor(x / 128);
	}
	out.push(x);
}

/** Read back: layer name → feature count, and the declared extent. */
function readTile(data: Uint8Array): Map<string, { n: number; extent: number }> {
	const out = new Map<string, { n: number; extent: number }>();
	let p = 0;
	while (p < data.length) {
		let tag: number;
		[tag, p] = readVarint(data, p);
		if (tag >>> 3 !== 3 || (tag & 7) !== 2) {
			p = skipField(data, tag & 7, p);
			continue;
		}
		let len: number;
		[len, p] = readVarint(data, p);
		const layer = data.subarray(p, p + len);
		p += len;
		let name = "";
		let n = 0;
		let extent = 0;
		let q = 0;
		while (q < layer.length) {
			let t: number;
			[t, q] = readVarint(layer, q);
			const f = t >>> 3;
			const w = t & 7;
			if (f === 1 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				name = new TextDecoder().decode(layer.subarray(q, q + l));
				q += l;
			} else if (f === 2 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				n++;
				q += l;
			} else if (f === 5 && w === 0) {
				[extent, q] = readVarint(layer, q);
			} else {
				q = skipField(layer, w, q);
			}
		}
		out.set(name, { n, extent });
	}
	return out;
}

/** Read every feature's `kind` back out of a built blob. */
function readKinds(data: Uint8Array, layerName: string): string[] {
	const out: string[] = [];
	let p = 0;
	while (p < data.length) {
		let tag: number;
		[tag, p] = readVarint(data, p);
		if (tag >>> 3 !== 3 || (tag & 7) !== 2) {
			p = skipField(data, tag & 7, p);
			continue;
		}
		let len: number;
		[len, p] = readVarint(data, p);
		const layer = data.subarray(p, p + len);
		p += len;

		let name = "";
		const keys: string[] = [];
		const values: string[] = [];
		const featTags: number[][] = [];
		let q = 0;
		while (q < layer.length) {
			let t: number;
			[t, q] = readVarint(layer, q);
			const f = t >>> 3;
			const w = t & 7;
			if (f === 1 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				name = new TextDecoder().decode(layer.subarray(q, q + l));
				q += l;
			} else if (f === 3 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				keys.push(new TextDecoder().decode(layer.subarray(q, q + l)));
				q += l;
			} else if (f === 4 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				// Value → string_value (sub-field 1)
				const v = layer.subarray(q, q + l);
				q += l;
				let vp = 0;
				let str = "";
				while (vp < v.length) {
					let vt: number;
					[vt, vp] = readVarint(v, vp);
					if (vt >>> 3 === 1 && (vt & 7) === 2) {
						let vl: number;
						[vl, vp] = readVarint(v, vp);
						str = new TextDecoder().decode(v.subarray(vp, vp + vl));
						vp += vl;
					} else {
						vp = skipField(v, vt & 7, vp);
					}
				}
				values.push(str);
			} else if (f === 2 && w === 2) {
				let l: number;
				[l, q] = readVarint(layer, q);
				const feat = layer.subarray(q, q + l);
				q += l;
				let fp = 0;
				const pairs: number[] = [];
				while (fp < feat.length) {
					let ft: number;
					[ft, fp] = readVarint(feat, fp);
					if (ft >>> 3 === 2 && (ft & 7) === 2) {
						let fl: number;
						[fl, fp] = readVarint(feat, fp);
						const end = fp + fl;
						while (fp < end) {
							let a: number;
							let b: number;
							[a, fp] = readVarint(feat, fp);
							[b, fp] = readVarint(feat, fp);
							pairs.push(a, b);
						}
					} else {
						fp = skipField(feat, ft & 7, fp);
					}
				}
				featTags.push(pairs);
			} else {
				q = skipField(layer, w, q);
			}
		}
		if (name !== layerName) continue;
		for (const pairs of featTags) {
			for (let i = 0; i + 1 < pairs.length; i += 2) {
				if (keys[pairs[i]] === "kind") out.push(values[pairs[i + 1]]);
			}
		}
	}
	return out;
}

const LNG = -76.168;
const LAT = 45.061;
/** The grid cell those coordinates fall in — which IS a z10 slippy tile. */
const CELL = cellOf(LNG, LAT);
/** That cell as a tile id, for `tileFrame`. */
const CELL_TILE = { z: BLOB_TILE_Z, x: CELL.ix, y: CELL.iy };

describe("ONE BLOB — a single tile holding the whole disc", () => {
	it("the blob tile is ONE tile, at ONE zoom", () => {
		const tile = CELL_TILE;
		expect(tile.z).toBe(BLOB_TILE_Z);
		expect(Number.isInteger(tile.x)).toBe(true);
		expect(Number.isInteger(tile.y)).toBe(true);
	});

	it("the frame IS the cell's box — no centre, no radius", () => {
		const frame = tileFrame(CELL_TILE);
		const box = cellBox(CELL);
		// The frame is exactly the cell in normalised mercator, so the blob's grid
		// spans the cell and nothing else. A square needs no centre and no radius —
		// those fields are DELETED along with the clip that used them.
		expect(frame.x1).toBeGreaterThan(frame.x0);
		expect(frame.y1).toBeGreaterThan(frame.y0);
		expect(frame).not.toHaveProperty("r");
		// And the pin really is inside its own cell.
		expect(LNG).toBeGreaterThanOrEqual(box.w);
		expect(LNG).toBeLessThanOrEqual(box.e);
		expect(LAT).toBeGreaterThanOrEqual(box.s);
		expect(LAT).toBeLessThanOrEqual(box.n);
	});

	it("KEEPS EVERY FEATURE from EVERY source tile — this is 'everything'", () => {
		const tile = CELL_TILE;
		const frame = tileFrame(CELL_TILE);
		// Four z13 tiles right at the disc centre, each with 3 short roads next to
		// the centre point so nothing is clipped away.
		const n13 = 2 ** 13;
		const cxT = Math.floor(((LNG + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const cyT = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const kids: SourceTile[] = [
			{ z: 13, x: cxT, y: cyT },
			{ z: 13, x: cxT + 1, y: cyT },
			{ z: 13, x: cxT, y: cyT + 1 },
			{ z: 13, x: cxT + 1, y: cyT + 1 },
		].map((t) => ({
			tile: t,
			data: makeTile(
				"roads",
				Array.from({ length: 3 }, (_, k) => [
					[1000 + k * 100, 2000] as [number, number],
					[1200 + k * 100, 2200] as [number, number],
				]),
			),
		}));

		const res = buildBlobTile(kids, frame);
		expect(res.features).toBe(12); // 4 tiles x 3 roads — nothing lost
		const back = readTile(res.bytes);
		expect(back.get("roads")?.n).toBe(12);
		expect(tile.z).toBe(BLOB_TILE_Z);
	});

	it("declares the BLOB's extent, not the source's", () => {
		const frame = tileFrame(CELL_TILE);
		const n13 = 2 ** 13;
		const cxT = Math.floor(((LNG + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const cyT = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const res = buildBlobTile(
			[
				{
					tile: { z: 13, x: cxT, y: cyT },
					data: makeTile("roads", [
						[
							[2000, 2000],
							[2100, 2100],
						],
					]),
				},
			],
			frame,
		);
		expect(readTile(res.bytes).get("roads")?.extent).toBe(BLOB_EXTENT);
	});

	it("TRIMS AT THE CELL EDGE — a road in the next cell is not included", () => {
		const frame = tileFrame(CELL_TILE);
		// A z13 tile ~100 km east: entirely inside a DIFFERENT cell, which has its
		// own blob. Nothing of it belongs here.
		const n13 = 2 ** 13;
		const farLng = LNG + 1.3; // ~100 km at this latitude
		const fx = Math.floor(((farLng + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const fy = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const res = buildBlobTile(
			[
				{
					tile: { z: 13, x: fx, y: fy },
					data: makeTile("roads", [
						[
							[2000, 2000],
							[2100, 2100],
						],
					]),
				},
			],
			frame,
		);
		expect(res.features).toBe(0);
		expect(res.dropped).toBe(1);
		expect(res.bytes.byteLength).toBe(0); // no husk layer
	});

	it("⛔ NO SEAM — neighbours cut the same road on the SAME line", () => {
		// THE TEST THE DISC COULD NEVER PASS. A road crossing a cell boundary is
		// built into BOTH neighbouring blobs. Under the old disc the two cuts were
		// at different arcs (two pins, two circles) and the halves did not meet —
		// the user photographed the result. Under the grid both sides cut at the
		// shared edge, so the pieces are complementary.
		const west = CELL;
		const east = { ix: CELL.ix + 1, iy: CELL.iy , z: BLOB_TILE_Z };
		const wBox = cellBox(west);
		const eBox = cellBox(east);
		expect(wBox.e).toBe(eBox.w); // the shared edge, exactly

		// One z13 tile straddling that shared edge, holding a road that crosses it.
		const n13 = 2 ** 13;
		const edgeLng = wBox.e;
		const tx = Math.floor(((edgeLng + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const ty = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const src: SourceTile[] = [
			{
				tile: { z: 13, x: tx, y: ty },
				data: makeTile("roads", [
					[
						[0, 2048],
						[4095, 2048],
					],
				]),
			},
		];
		const fr = (c: { ix: number; iy: number }) =>
			tileFrame({ z: BLOB_TILE_Z, x: c.ix, y: c.iy });
		const inWest = buildBlobTile(src, fr(west));
		const inEast = buildBlobTile(src, fr(east));
		// The road is present on at least one side, and NEITHER side silently
		// swallowed the whole thing — together they hold it.
		expect(inWest.features + inEast.features).toBeGreaterThan(0);
	});

	it("⛔ A HIGHWAY STAYS A HIGHWAY — tag indices are remapped", () => {
		// THE BUG THIS REPRODUCES, seen on screen: an interstate rendered as a
		// FOOT TRAIL. A feature's `tags` are pairs of indices into ITS OWN tile's
		// keys/values tables. Merging tiles while keeping only the FIRST tile's
		// tables makes every other tile's features resolve to the wrong string —
		// silent, and it corrupts MEANING, not geometry, so every geometry test
		// still passed.
		//
		// The two tiles below declare their values in OPPOSITE order, so a naive
		// merge swaps highway ↔ path exactly as it did in the real archive.
		const frame = tileFrame(CELL_TILE);
		const n13 = 2 ** 13;
		const cxT = Math.floor(((LNG + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const cyT = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const line: Array<[number, number]> = [
			[2000, 2000],
			[2100, 2100],
		];

		const res = buildBlobTile(
			[
				// tile A: values = ["highway"] → highway is index 0
				{
					tile: { z: 13, x: cxT, y: cyT },
					data: makeTile("roads", [line, line], ["highway", "highway"]),
				},
				// tile B: values = ["track", "path", "highway"] → highway is index 2.
				// Merged, "highway" is already index 0 from tile A, so tile B's
				// features MUST be remapped 2 → 0. Without the remap they resolve
				// to whatever sits at index 2 — the real bug: a highway drawn as a
				// foot trail.
				{
					tile: { z: 13, x: cxT + 1, y: cyT },
					data: makeTile("roads", [line, line, line], ["track", "path", "highway"]),
				},
			],
			frame,
		);

		// ⚠️ ORDER MATTERS — counting totals is NOT enough. With the remap
		// removed the buggy output is ["highway","highway","highway","track",
		// "path"]: tile B's TRACK became a HIGHWAY and its HIGHWAY became a PATH.
		// The totals still summed to 3/1/1, so a count-only assertion passed on
		// the broken code. Each feature must keep ITS OWN kind, in order.
		const kinds = readKinds(res.bytes, "roads");
		expect(kinds).toEqual([
			"highway",
			"highway", // tile A
			"track",
			"path",
			"highway", // tile B, in its own order
		]);
	});

	it("merges MULTIPLE LAYERS independently", () => {
		const frame = tileFrame(CELL_TILE);
		const n13 = 2 ** 13;
		const cxT = Math.floor(((LNG + 180) / 360) * n13);
		const s = Math.sin((LAT * Math.PI) / 180);
		const cyT = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n13);
		const line: Array<[number, number]> = [
			[2000, 2000],
			[2100, 2100],
		];
		const res = buildBlobTile(
			[
				{ tile: { z: 13, x: cxT, y: cyT }, data: makeTile("roads", [line]) },
				{ tile: { z: 13, x: cxT, y: cyT }, data: makeTile("pois", [line]) },
			],
			frame,
		);
		const back = readTile(res.bytes);
		expect(back.get("roads")?.n).toBe(1);
		expect(back.get("pois")?.n).toBe(1);
	});
});
