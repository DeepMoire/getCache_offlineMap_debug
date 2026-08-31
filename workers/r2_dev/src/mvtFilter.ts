export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++];
    result += (b & 0x7f) * 2 ** shift; // * 2**shift (not <<) — lengths can exceed 31 bits of headroom
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
/** Skip one protobuf field's payload given its wire type; returns the new position. */
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
/** The `name` (field 1, string) of an MVT Layer sub-message. */
export function layerName(layer: Uint8Array): string {
  let p = 0;
  while (p < layer.length) {
    let tag: number;
    [tag, p] = readVarint(layer, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layer, p);
      return new TextDecoder().decode(layer.subarray(p, p + len));
    }
    p = skipField(layer, wire, p);
  }
  return "";
}

// ── per-source-layer KIND allowlist ──────────────────────────────────────────
// DERIVED FROM THE CONTRACT — `lib/contract/packLayers.ts` is the one table of
// what a pack ships, read by the Worker here and by the phone's debug report.
// A layer with no `kinds` rule passes through whole (roads). A rule names the
// attribute KEY it matches on: Protomaps v4 files city/town/village/hamlet under
// `kind_detail` (every `places` feature is `kind:locality`), so matching `kind`
// against "city" kept nothing and shipped a husk — MEASURED, 214/214 dropped.
import { PACK_LAYERS } from "./packLayers";

/** One allowlist entry: the attribute key to match and the values that survive. */
export interface KindRule {
  key: string;
  kinds: ReadonlySet<string>;
}
/** A bare Set is shorthand for `{ key: "kind", kinds }` — the historical shape,
 *  still accepted so hand-built test allowlists keep working. */
export type KindAllowlist = Record<string, ReadonlySet<string> | KindRule>;

export const KIND_ALLOWLIST: KindAllowlist = Object.fromEntries(
  Object.entries(PACK_LAYERS)
    .filter(([, r]) => r.kinds)
    .map(([name, r]) => [name, { key: r.key ?? "kind", kinds: new Set(r.kinds) }]),
);

function ruleOf(entry: ReadonlySet<string> | KindRule): KindRule {
  return entry instanceof Set ? { key: "kind", kinds: entry } : (entry as KindRule);
}

/** The decoded string values of a Layer's `values` table (field 4). Only string
 *  Values (sub-field 1) matter for `kind`; non-string values yield "" (never a kind). */
function layerStringValues(layer: Uint8Array): string[] {
  const values: string[] = [];
  let p = 0;
  while (p < layer.length) {
    let tag: number;
    [tag, p] = readVarint(layer, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 4 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layer, p);
      const value = layer.subarray(p, p + len);
      p += len;
      // Value sub-message: string_value is sub-field 1, wire 2.
      let vp = 0;
      let s = "";
      while (vp < value.length) {
        let vtag: number;
        [vtag, vp] = readVarint(value, vp);
        const vfield = vtag >>> 3;
        const vwire = vtag & 7;
        if (vfield === 1 && vwire === 2) {
          let vlen: number;
          [vlen, vp] = readVarint(value, vp);
          s = new TextDecoder().decode(value.subarray(vp, vp + vlen));
          vp += vlen;
        } else {
          vp = skipField(value, vwire, vp);
        }
      }
      values.push(s);
    } else {
      p = skipField(layer, wire, p);
    }
  }
  return values;
}

/** The index of the attribute `key` (default `"kind"`) in a Layer's `keys` table
 *  (field 3), or -1. */
function kindKeyIndex(layer: Uint8Array, key = "kind"): number {
  let p = 0;
  let idx = 0;
  while (p < layer.length) {
    let tag: number;
    [tag, p] = readVarint(layer, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 3 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layer, p);
      const k = new TextDecoder().decode(layer.subarray(p, p + len));
      p += len;
      if (k === key) return idx;
      idx++;
    } else {
      p = skipField(layer, wire, p);
    }
  }
  return -1;
}

/** Read one Feature's `kind` value index from its packed `tags` (field 2), given the
 *  `kind` key index. Returns the value index, or -1 if the feature has no `kind` tag. */
function featureKindValueIndex(feature: Uint8Array, kindKeyIdx: number): number {
  let p = 0;
  while (p < feature.length) {
    let tag: number;
    [tag, p] = readVarint(feature, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      // packed tags: alternating (keyIndex, valueIndex) varints
      let len: number;
      [len, p] = readVarint(feature, p);
      const end = p + len;
      while (p < end) {
        let keyIdx: number;
        let valIdx: number;
        [keyIdx, p] = readVarint(feature, p);
        [valIdx, p] = readVarint(feature, p);
        if (keyIdx === kindKeyIdx) return valIdx;
      }
      return -1;
    }
    p = skipField(feature, wire, p);
  }
  return -1;
}

export const PATH_KINDS: ReadonlySet<string> = new Set(["path"]);

export type KindMode = "keep" | "drop";

/** Re-emit a single Layer sub-message keeping/dropping features by `kind`. Survivors'
 *  feature bytes are copied verbatim; name/keys/values tables pass through untouched.
 *  If the layer has no `kind` key, it's returned unchanged (don't nuke a schema variant).
 *  Also reports the total byte length of features whose kind ∈ `kinds` (for budgeting). */
export function filterLayerFeaturesByKind(
  layer: Uint8Array,
  mode: KindMode,
  kinds: ReadonlySet<string>,
  /** The attribute matched — `kind` unless the contract says otherwise. */
  key = "kind",
): { bytes: Uint8Array; matchedFeatureBytes: number } {
  const kindKeyIdx = kindKeyIndex(layer, key);
  if (kindKeyIdx < 0) return { bytes: layer, matchedFeatureBytes: 0 };
  const values = layerStringValues(layer);
  // value indices whose string is a wanted kind
  const wantedValueIdx = new Set<number>();
  for (let i = 0; i < values.length; i++) if (kinds.has(values[i])) wantedValueIdx.add(i);

  const out: number[] = [];
  let matchedFeatureBytes = 0;
  let p = 0;
  while (p < layer.length) {
    const fieldStart = p;
    let tag: number;
    [tag, p] = readVarint(layer, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      // a Feature — decide keep/drop by its kind
      let len: number;
      [len, p] = readVarint(layer, p);
      const feature = layer.subarray(p, p + len);
      const featureEnd = p + len;
      p = featureEnd;
      const valIdx = featureKindValueIndex(feature, kindKeyIdx);
      const isMatch = valIdx >= 0 && wantedValueIdx.has(valIdx);
      if (isMatch) matchedFeatureBytes += featureEnd - fieldStart;
      const keep = mode === "keep" ? isMatch : !isMatch;
      if (keep) for (let i = fieldStart; i < featureEnd; i++) out.push(layer[i]);
    } else {
      // name / keys / values / extent / version — copy the whole field verbatim
      const next = skipField(layer, wire, p);
      for (let i = fieldStart; i < next; i++) out.push(layer[i]);
      p = next;
    }
  }
  return { bytes: new Uint8Array(out), matchedFeatureBytes };
}

export interface FilterResult {
  /** the filtered tile bytes */
  data: ArrayBuffer;
  /** total bytes of the `roads` layer in the OUTPUT (after any kind filtering) */
  roadsBytes: number;
  /** of those roads bytes, how many belong to `kind === "path"` features */
  pathBytes: number;
}

/** Pass through only the Tile's layers whose name is in `keep`, applying the per-layer
 *  KIND allowlist where configured. Also measures the output `roads` layer's total
 *  bytes and its `path`-feature byte share (for the roads budget). When `dropPaths`
 *  is true, `path` features are stripped from the roads layer too. */
export function filterMvtToLayers(
  data: ArrayBuffer,
  keep: ReadonlySet<string>,
  opts: {
    dropPaths?: boolean;
    allowlist?: KindAllowlist;
    /**
     * Keep ONLY these road kinds. Separate from `allowlist` because the `roads`
     * branch has to stay in charge of `roadsBytes`/`pathBytes` (the roads budget
     * reads them), so roads can't just be routed through the generic allowlist.
     *
     * Used by the z13 MID ring. MEASURED in a real z13 tile: `path` and
     * `minor_road` are ~80% of the roads bytes (Vancouver: 16.6 kB + 11.1 kB of
     * 34.9 kB) while `major_road` — 103 of the 158 features — is 14%. At a
     * regional zoom the minor stuff is not legible anyway, so keeping the major
     * network buys the whole visual benefit for a fifth of the bytes.
     */
    roadKinds?: ReadonlySet<string>;
  } = {},
): FilterResult {
  const allowlist = opts.allowlist ?? KIND_ALLOWLIST;
  const buf = new Uint8Array(data);
  const out: number[] = [];
  let roadsBytes = 0;
  let pathBytes = 0;
  let p = 0;
  while (p < buf.length) {
    let tag: number;
    [tag, p] = readVarint(buf, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 3 && wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      const layer = buf.subarray(p, p + len);
      p += len;
      const name = layerName(layer);
      if (!keep.has(name)) continue;

      let layerBytes: Uint8Array = layer;
      if (name === "roads" && opts.roadKinds) {
        // MID-RING ROADS: keep only the named kinds. This subsumes dropPaths (a
        // kind list that omits `path` has already dropped them), and the ring is
        // excluded from the roads budget, so nothing downstream needs pathBytes
        // for these tiles.
        layerBytes = filterLayerFeaturesByKind(layer, "keep", opts.roadKinds).bytes;
        roadsBytes += layerBytes.length;
      } else if (name === "roads") {
        // measure path bytes always; strip paths only when asked
        if (opts.dropPaths) {
          const r = filterLayerFeaturesByKind(layer, "drop", PATH_KINDS);
          layerBytes = r.bytes;
          // after stripping, no path bytes remain
        } else {
          const r = filterLayerFeaturesByKind(layer, "keep", PATH_KINDS);
          pathBytes += r.matchedFeatureBytes;
        }
        roadsBytes += layerBytes.length;
      } else if (allowlist[name]) {
        const rule = ruleOf(allowlist[name]);
        layerBytes = filterLayerFeaturesByKind(layer, "keep", rule.kinds, rule.key).bytes;
      }

      // re-emit: field 3 (layers) tag + length-delimited layerBytes
      writeVarint(out, tag);
      writeVarint(out, layerBytes.length);
      for (let i = 0; i < layerBytes.length; i++) out.push(layerBytes[i]);
    } else {
      p = skipField(buf, wire, p);
    }
  }
  return { data: new Uint8Array(out).buffer, roadsBytes, pathBytes };
}

// ── THE DISC CLIP — 30 km means 30 km ───────────────────────────────────────
//
// THE BUG THIS EXISTS TO KILL. Selecting tiles by "does this tile touch the
// 30 km circle" is not the same as shipping a 30 km circle, because a tile is a
// SQUARE and at shallow zooms it is enormous. MEASURED at lat 45:
//
//     z15  0.9 km wide     z11  13.8 km     z9   55.3 km
//     z13  3.5 km          z10  27.6 km     z1  14153.8 km
//
// A z9 tile kept because its nearest corner grazes the circle carries roads up
// to 78 km past the edge. The user measured it on screen with the ruler: 80 km
// of roads in a "30 km" blob, and `1/0/0` — one tile covering half the planet —
// shipped inside the pack. Roads in places nobody downloaded, which is the
// honesty rule broken.
//
// THE FIX, AND WHY IT IS STILL LOSSLESS. We do NOT decode-and-re-encode
// geometry (that is the decode machinery this architecture deleted — 705 MB,
// measured). We read each feature's packed geometry ONLY to compute its
// bounding box in tile-local units, then keep or drop the feature WHOLE, its
// bytes copied verbatim. A feature is dropped iff its bbox lies entirely
// outside the disc. Survivors are untouched, so this stays a byte filter.
//
// A feature straddling the edge is KEPT in full. That is deliberate: cutting a
// road mid-span needs re-encoding, and a road that runs a little past the rim
// is honest — it is a road we really downloaded. What is NOT honest is a whole
// continent riding along inside one z1 tile.

/** MVT geometry commands are zigzag-encoded deltas in tile-local units. */
function zigzag(n: number): number {
  return (n >> 1) ^ -(n & 1);
}

/**
 * Bounding box of one feature's packed geometry, in tile-local units (0..extent).
 * Returns null if the feature carries no geometry.
 *
 * Walks MoveTo/LineTo/ClosePath commands accumulating the cursor. Never builds
 * a geometry object — just four numbers.
 */
export function featureBBox(
  feature: Uint8Array,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let p = 0;
  let x = 0;
  let y = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let seen = false;
  while (p < feature.length) {
    let tag: number;
    [tag, p] = readVarint(feature, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 4 && wire === 2) {
      let len: number;
      [len, p] = readVarint(feature, p);
      const end = p + len;
      while (p < end) {
        let cmd: number;
        [cmd, p] = readVarint(feature, p);
        const id = cmd & 0x7;
        const count = cmd >> 3;
        if (id === 7) continue; // ClosePath carries no coordinates
        for (let i = 0; i < count && p < end; i++) {
          let dx: number;
          let dy: number;
          [dx, p] = readVarint(feature, p);
          [dy, p] = readVarint(feature, p);
          x += zigzag(dx);
          y += zigzag(dy);
          seen = true;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    } else {
      p = skipField(feature, wire, p);
    }
  }
  return seen ? { x0, y0, x1, y1 } : null;
}

/** The `extent` (field 5) of an MVT Layer — tile-local coordinate span. */
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
  return 4096; // the MVT default
}

/** A disc expressed in ONE tile's local coordinates, plus that tile's span. */
export interface TileDisc {
  /** Disc centre in tile-local units. May sit outside 0..extent. */
  cx: number;
  cy: number;
  /** Disc radius in tile-local units. */
  r: number;
}

/**
 * Drop every feature in a layer whose bbox lies wholly outside the disc.
 * Survivors' bytes are copied verbatim; keys/values tables pass through.
 */
export function clipLayerToDisc(
  layer: Uint8Array,
  disc: TileDisc,
): { bytes: Uint8Array; dropped: number; kept: number } {
  const out: number[] = [];
  let dropped = 0;
  let kept = 0;
  let p = 0;
  while (p < layer.length) {
    const fieldStart = p;
    let tag: number;
    [tag, p] = readVarint(layer, p);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 2 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layer, p);
      const feature = layer.subarray(p, p + len);
      const bb = featureBBox(feature);
      // No geometry → keep (nothing to judge). Otherwise: nearest point of the
      // bbox to the disc centre; if that is beyond r, nothing in this feature
      // can be inside the disc.
      let keep = true;
      if (bb) {
        const nx = Math.min(Math.max(disc.cx, bb.x0), bb.x1);
        const ny = Math.min(Math.max(disc.cy, bb.y0), bb.y1);
        const dx = nx - disc.cx;
        const dy = ny - disc.cy;
        keep = dx * dx + dy * dy <= disc.r * disc.r;
      }
      if (keep) {
        kept++;
        for (let i = fieldStart; i < p + len; i++) out.push(layer[i]);
      } else {
        dropped++;
      }
      p += len;
    } else {
      const next = skipField(layer, wire, p);
      for (let i = fieldStart; i < next; i++) out.push(layer[i]);
      p = next;
    }
  }
  // A layer clipped down to ZERO features is a husk: it still carries its
  // name + keys + values tables (MEASURED: `1/0/0` in a live pack was 16,512
  // bytes of `places` keys/values with field 2 — features — entirely absent).
  // Shipping it costs real bytes and paints nothing, so report it empty and let
  // the caller drop the layer.
  return { bytes: kept > 0 ? new Uint8Array(out) : new Uint8Array(0), dropped, kept };
}
