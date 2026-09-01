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

/** Re-emit a single Layer sub-message keeping only features whose kind ∈ `kinds`.
 *  Survivors' feature bytes are copied verbatim; name/keys/values tables pass
 *  through untouched. If the layer has no `key` attribute, it's returned
 *  unchanged (don't nuke a schema variant). */
export function filterLayerFeaturesByKind(
  layer: Uint8Array,
  kinds: ReadonlySet<string>,
  /** The attribute matched — `kind` unless the contract says otherwise. */
  key = "kind",
): Uint8Array {
  const kindKeyIdx = kindKeyIndex(layer, key);
  if (kindKeyIdx < 0) return layer;
  const values = layerStringValues(layer);
  // value indices whose string is a wanted kind
  const wantedValueIdx = new Set<number>();
  for (let i = 0; i < values.length; i++) if (kinds.has(values[i])) wantedValueIdx.add(i);

  const out: number[] = [];
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
      if (valIdx >= 0 && wantedValueIdx.has(valIdx)) {
        for (let i = fieldStart; i < featureEnd; i++) out.push(layer[i]);
      }
    } else {
      // name / keys / values / extent / version — copy the whole field verbatim
      const next = skipField(layer, wire, p);
      for (let i = fieldStart; i < next; i++) out.push(layer[i]);
      p = next;
    }
  }
  return new Uint8Array(out);
}

/** Pass through only the Tile's layers whose name is in `keep`, applying the
 *  per-layer KIND allowlist where configured. A layer with no rule (roads)
 *  ships whole — nothing is dropped by kind. */
export function filterMvtToLayers(
  data: ArrayBuffer,
  keep: ReadonlySet<string>,
  allowlist: KindAllowlist = KIND_ALLOWLIST,
): ArrayBuffer {
  const buf = new Uint8Array(data);
  const out: number[] = [];
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
      if (allowlist[name]) {
        const rule = ruleOf(allowlist[name]);
        layerBytes = filterLayerFeaturesByKind(layer, rule.kinds, rule.key);
      }

      // re-emit: field 3 (layers) tag + length-delimited layerBytes
      writeVarint(out, tag);
      writeVarint(out, layerBytes.length);
      for (let i = 0; i < layerBytes.length; i++) out.push(layerBytes[i]);
    } else {
      p = skipField(buf, wire, p);
    }
  }
  return new Uint8Array(out).buffer;
}
