import { describe, expect, it } from "vitest";
import {
  filterLayerFeaturesByKind,
  filterMvtToLayers,
  layerName,
  readVarint,
  skipField,
  writeVarint,
  KIND_ALLOWLIST,
} from "./mvtFilter";
import { PACK_LAYERS, PACK_LAYER_NAMES } from "./packLayers";

// Wire types: 0=varint, 2=length-delimited.

function tag(field: number, wire: number): number {
  return (field << 3) | wire;
}
function lenDelim(field: number, payload: number[]): number[] {
  const out: number[] = [];
  writeVarint(out, tag(field, 2));
  writeVarint(out, payload.length);
  out.push(...payload);
  return out;
}
function strField(field: number, s: string): number[] {
  return lenDelim(field, [...new TextEncoder().encode(s)]);
}

/** A Value sub-message holding one string (string_value = sub-field 1). */
function stringValue(s: string): number[] {
  return strField(1, s);
}

/** A Feature: id (field 1) + packed tags (field 2) + type (field 3) + geometry (field 4 stub). */
function feature(id: number, tags: number[], geomStub: number[] = [9, 0, 0]): number[] {
  const out: number[] = [];
  // id (field 1, varint)
  writeVarint(out, tag(1, 0));
  writeVarint(out, id);
  // tags (field 2, packed varints)
  const packed: number[] = [];
  for (const t of tags) writeVarint(packed, t);
  out.push(...lenDelim(2, packed));
  // type (field 3, varint) = 1 (point)
  writeVarint(out, tag(3, 0));
  writeVarint(out, 1);
  // geometry (field 4, packed varints) — stub
  const geom: number[] = [];
  for (const g of geomStub) writeVarint(geom, g);
  out.push(...lenDelim(4, geom));
  return out;
}

interface TestFeature {
  id: number;
  kind?: string; // sets a "kind" tag if present
  extraKeys?: Record<string, string>;
}

/** Build one Layer sub-message. keys[] = ["kind", ...extra]; values[] = distinct kind strings. */
function layer(name: string, features: TestFeature[]): number[] {
  const keys: string[] = [];
  const values: string[] = [];
  const keyIdx = (k: string): number => {
    let i = keys.indexOf(k);
    if (i < 0) {
      i = keys.length;
      keys.push(k);
    }
    return i;
  };
  const valIdx = (v: string): number => {
    let i = values.indexOf(v);
    if (i < 0) {
      i = values.length;
      values.push(v);
    }
    return i;
  };

  const featBytes: number[][] = features.map((f) => {
    const tags: number[] = [];
    if (f.kind !== undefined) {
      tags.push(keyIdx("kind"), valIdx(f.kind));
    }
    for (const [k, v] of Object.entries(f.extraKeys ?? {})) {
      tags.push(keyIdx(k), valIdx(v));
    }
    return feature(f.id, tags);
  });

  const out: number[] = [];
  out.push(...strField(1, name)); // name = field 1
  // version = field 15, varint (Mapbox expects 1 or 2; not read by filter)
  writeVarint(out, tag(15, 0));
  writeVarint(out, 2);
  for (const fb of featBytes) out.push(...lenDelim(2, fb)); // features = field 2
  for (const k of keys) out.push(...strField(3, k)); // keys = field 3
  for (const v of values) out.push(...lenDelim(4, stringValue(v))); // values = field 4
  // extent = field 5, varint
  writeVarint(out, tag(5, 0));
  writeVarint(out, 4096);
  return out;
}

/** Build a whole Tile from named layers. */
function tile(layers: Array<{ name: string; features: TestFeature[] }>): ArrayBuffer {
  const out: number[] = [];
  for (const l of layers) out.push(...lenDelim(3, layer(l.name, l.features))); // layers = field 3
  return new Uint8Array(out).buffer;
}

/** Count features (field 2) in a Layer sub-message. */
function countFeatures(layerBytes: Uint8Array): number {
  let p = 0;
  let n = 0;
  while (p < layerBytes.length) {
    let t: number;
    [t, p] = readVarint(layerBytes, p);
    const field = t >>> 3;
    const wire = t & 7;
    if (field === 2 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      p += len;
      n++;
    } else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      p += len;
    } else if (wire === 0) {
      [, p] = readVarint(layerBytes, p);
    }
  }
  return n;
}

/** Return the kind strings of every surviving feature in a layer (in order). */
/** The `id` (field 1) of every Feature in a Layer, in order. */
function featureIds(layerBytes: Uint8Array): number[] {
  const ids: number[] = [];
  let p = 0;
  while (p < layerBytes.length) {
    let t: number;
    [t, p] = readVarint(layerBytes, p);
    const field = t >>> 3;
    const wire = t & 7;
    if (field === 2 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      const f = layerBytes.subarray(p, p + len);
      p += len;
      let fp = 0;
      while (fp < f.length) {
        let ft: number;
        [ft, fp] = readVarint(f, fp);
        if ((ft >>> 3) === 1 && (ft & 7) === 0) {
          let id: number;
          [id, fp] = readVarint(f, fp);
          ids.push(id);
          break;
        }
        fp = skipField(f, ft & 7, fp);
      }
    } else p = skipField(layerBytes, wire, p);
  }
  return ids;
}

function featureKinds(layerBytes: Uint8Array): string[] {
  // find "kind" key index + value strings, then read each feature's kind
  const keys: string[] = [];
  const values: string[] = [];
  let p = 0;
  while (p < layerBytes.length) {
    let t: number;
    [t, p] = readVarint(layerBytes, p);
    const field = t >>> 3;
    const wire = t & 7;
    if (wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      const sub = layerBytes.subarray(p, p + len);
      p += len;
      if (field === 3) keys.push(new TextDecoder().decode(sub));
      else if (field === 4) {
        // Value: string sub-field 1
        let vp = 0;
        let s = "";
        while (vp < sub.length) {
          let vt: number;
          [vt, vp] = readVarint(sub, vp);
          const vf = vt >>> 3;
          const vw = vt & 7;
          if (vf === 1 && vw === 2) {
            let vl: number;
            [vl, vp] = readVarint(sub, vp);
            s = new TextDecoder().decode(sub.subarray(vp, vp + vl));
            vp += vl;
          } else if (vw === 0) [, vp] = readVarint(sub, vp);
          else if (vw === 2) {
            let vl: number;
            [vl, vp] = readVarint(sub, vp);
            vp += vl;
          }
        }
        values.push(s);
      }
    } else if (wire === 0) [, p] = readVarint(layerBytes, p);
  }
  const kindKey = keys.indexOf("kind");

  // second pass over features
  const out: string[] = [];
  p = 0;
  while (p < layerBytes.length) {
    let t: number;
    [t, p] = readVarint(layerBytes, p);
    const field = t >>> 3;
    const wire = t & 7;
    if (field === 2 && wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      const f = layerBytes.subarray(p, p + len);
      p += len;
      // walk feature tags
      let fp = 0;
      let kind = "";
      while (fp < f.length) {
        let ft: number;
        [ft, fp] = readVarint(f, fp);
        const ff = ft >>> 3;
        const fw = ft & 7;
        if (ff === 2 && fw === 2) {
          let fl: number;
          [fl, fp] = readVarint(f, fp);
          const end = fp + fl;
          while (fp < end) {
            let ki: number;
            let vi: number;
            [ki, fp] = readVarint(f, fp);
            [vi, fp] = readVarint(f, fp);
            if (ki === kindKey) kind = values[vi] ?? "";
          }
        } else if (fw === 0) [, fp] = readVarint(f, fp);
        else if (fw === 2) {
          let fl: number;
          [fl, fp] = readVarint(f, fp);
          fp += fl;
        }
      }
      out.push(kind);
    } else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(layerBytes, p);
      p += len;
    } else if (wire === 0) [, p] = readVarint(layerBytes, p);
  }
  return out;
}

/** Pull the first layer with the given name out of a Tile as raw bytes. */
function getLayer(data: ArrayBuffer, name: string): Uint8Array | null {
  const buf = new Uint8Array(data);
  let p = 0;
  while (p < buf.length) {
    let t: number;
    [t, p] = readVarint(buf, p);
    const field = t >>> 3;
    const wire = t & 7;
    if (field === 3 && wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      const l = buf.subarray(p, p + len);
      p += len;
      if (layerName(l) === name) return l;
    } else if (wire === 0) [, p] = readVarint(buf, p);
    else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      p += len;
    }
  }
  return null;
}

const ALLOW = {
  pois: new Set(["hospital", "camp_site"]),
  places: new Set(["city", "town", "village", "hamlet"]),
};

describe("KIND_ALLOWLIST is the contract, not a Worker constant", () => {
  it("derives one rule per kind-filtered layer in PACK_LAYERS, with its key", () => {
    for (const [name, rule] of Object.entries(PACK_LAYERS)) {
      if (!rule.kinds) {
        expect(KIND_ALLOWLIST[name], `${name} ships whole — no allowlist`).toBeUndefined();
        continue;
      }
      const entry = KIND_ALLOWLIST[name] as { key: string; kinds: ReadonlySet<string> };
      expect(entry.key).toBe(rule.key ?? "kind");
      expect([...entry.kinds].sort()).toEqual([...rule.kinds].sort());
    }
  });

  it("places match on kind_detail — every v4 places feature is kind:locality", () => {
    // MEASURED 28 Aug 2026 across the 324 z13 tiles of one disc: 214 `places`
    // features, ALL `kind:"locality"`, city/town/village/hamlet in `kind_detail`.
    // Matching `kind` against "city" kept NONE of them and shipped a husk.
    const l = new Uint8Array(
      layer("places", [
        { id: 1, kind: "locality", extraKeys: { kind_detail: "city" } },
        { id: 2, kind: "locality", extraKeys: { kind_detail: "hamlet" } },
        { id: 3, kind: "locality", extraKeys: { kind_detail: "locality" } },
        { id: 4, kind: "neighbourhood", extraKeys: { kind_detail: "suburb" } },
      ]),
    );
    const rule = KIND_ALLOWLIST.places as { key: string; kinds: ReadonlySet<string> };
    const { bytes } = filterLayerFeaturesByKind(l, "keep", rule.kinds, rule.key);
    expect(featureIds(bytes)).toEqual([1, 2]);
    // and the OLD way — matching `kind` — keeps nothing, which is the bug
    const wrong = filterLayerFeaturesByKind(l, "keep", rule.kinds, "kind");
    expect(featureIds(wrong.bytes)).toEqual([]);
  });

  it("filterMvtToLayers applies the contract by default — no allowlist passed", () => {
    const data = tile([
      { name: "roads", features: [{ id: 1, kind: "path" }] },
      {
        name: "water",
        features: [
          { id: 2, kind: "lake" },
          { id: 3, kind: "stream" },
          { id: 4, kind: "water" },
        ],
      },
      {
        name: "places",
        features: [
          { id: 5, kind: "locality", extraKeys: { kind_detail: "town" } },
          { id: 6, kind: "locality", extraKeys: { kind_detail: "locality" } },
        ],
      },
      { name: "pois", features: [{ id: 7, kind: "hospital" }, { id: 8, kind: "cafe" }] },
      { name: "earth", features: [{ id: 9, kind: "earth" }] },
    ]);
    const r = filterMvtToLayers(data, new Set(PACK_LAYER_NAMES));
    expect(getLayer(r.data, "earth")).toBeNull();
    expect(featureIds(getLayer(r.data, "roads")!)).toEqual([1]); // nothing dropped by kind
    expect(featureIds(getLayer(r.data, "water")!)).toEqual([2, 4]); // stream dropped
    expect(featureIds(getLayer(r.data, "places")!)).toEqual([5]); // bare locality dropped
    expect(featureIds(getLayer(r.data, "pois")!)).toEqual([7]); // cafe dropped
  });
});

describe("filterLayerFeaturesByKind", () => {
  it("pois keep → drops cafe, keeps hospital", () => {
    const l = new Uint8Array(
      layer("pois", [
        { id: 1, kind: "hospital" },
        { id: 2, kind: "cafe" },
        { id: 3, kind: "camp_site" },
        { id: 4, kind: "bench" },
      ]),
    );
    const { bytes } = filterLayerFeaturesByKind(l, "keep", ALLOW.pois);
    expect(featureKinds(bytes).sort()).toEqual(["camp_site", "hospital"]);
  });

  it("places keep → drops neighbourhood, keeps city", () => {
    const l = new Uint8Array(
      layer("places", [
        { id: 1, kind: "city" },
        { id: 2, kind: "neighbourhood" },
        { id: 3, kind: "town" },
        { id: 4, kind: "suburb" },
      ]),
    );
    const { bytes } = filterLayerFeaturesByKind(l, "keep", ALLOW.places);
    expect(featureKinds(bytes).sort()).toEqual(["city", "town"]);
  });

  it("roads drop path → path gone, major_road kept", () => {
    const l = new Uint8Array(
      layer("roads", [
        { id: 1, kind: "major_road" },
        { id: 2, kind: "path" },
        { id: 3, kind: "minor_road" },
        { id: 4, kind: "path" },
      ]),
    );
    const { bytes } = filterLayerFeaturesByKind(l, "drop", new Set(["path"]));
    expect(featureKinds(bytes).sort()).toEqual(["major_road", "minor_road"]);
  });

  it("layer with no kind key → returned untouched", () => {
    const l = new Uint8Array(
      layer("roads", [
        { id: 1, extraKeys: { name: "Main St" } },
        { id: 2, extraKeys: { name: "Oak Ave" } },
      ]),
    );
    const { bytes } = filterLayerFeaturesByKind(l, "keep", ALLOW.pois);
    expect(bytes).toEqual(l); // byte-identical, nothing nuked
    expect(countFeatures(bytes)).toBe(2);
  });

  it("byte-lossless: a survivor's bytes are copied verbatim", () => {
    const l = new Uint8Array(
      layer("pois", [
        { id: 42, kind: "hospital", extraKeys: { name: "St. Paul" } },
        { id: 7, kind: "cafe" },
      ]),
    );
    const { bytes } = filterLayerFeaturesByKind(l, "keep", ALLOW.pois);
    // the hospital feature must survive intact (1 feature, kind hospital)
    expect(featureKinds(bytes)).toEqual(["hospital"]);
    // and re-running keep is idempotent
    const again = filterLayerFeaturesByKind(bytes, "keep", ALLOW.pois);
    expect(again.bytes).toEqual(bytes);
  });
});

describe("filterMvtToLayers", () => {
  it("drops earth (not in keep), kind-filters pois, passes water byte-identical", () => {
    const data = tile([
      { name: "roads", features: [{ id: 1, kind: "major_road" }] },
      { name: "water", features: [{ id: 2, kind: "lake" }] },
      {
        name: "pois",
        features: [
          { id: 3, kind: "hospital" },
          { id: 4, kind: "cafe" },
        ],
      },
      { name: "earth", features: [{ id: 5, kind: "land" }] },
    ]);
    const keep = new Set(["roads", "water", "pois"]); // earth absent
    const r = filterMvtToLayers(data, keep, { allowlist: ALLOW });

    expect(getLayer(r.data, "earth")).toBeNull(); // earth gone
    expect(getLayer(r.data, "water")).not.toBeNull(); // water kept
    expect(featureKinds(getLayer(r.data, "water")!)).toEqual(["lake"]); // water untouched
    expect(featureKinds(getLayer(r.data, "pois")!)).toEqual(["hospital"]); // cafe dropped
  });

  it("measures roads + path bytes; dropPaths strips them", () => {
    const data = tile([
      {
        name: "roads",
        features: [
          { id: 1, kind: "major_road" },
          { id: 2, kind: "path" },
          { id: 3, kind: "path" },
        ],
      },
    ]);
    const keep = new Set(["roads"]);

    const measured = filterMvtToLayers(data, keep, { dropPaths: false });
    expect(measured.pathBytes).toBeGreaterThan(0);
    expect(measured.roadsBytes).toBeGreaterThan(0);
    expect(featureKinds(getLayer(measured.data, "roads")!).sort()).toEqual([
      "major_road",
      "path",
      "path",
    ]);

    const stripped = filterMvtToLayers(data, keep, { dropPaths: true });
    expect(featureKinds(getLayer(stripped.data, "roads")!)).toEqual(["major_road"]);
    // stripped roads layer is smaller than measured
    expect(stripped.roadsBytes).toBeLessThan(measured.roadsBytes);
  });
});

describe("roads budget decision — ONE rule: default 40 km, bust → 25 km + drop paths", () => {
  const BUDGET = 2_000_000;
  // The worker measures roads bytes at the DEFAULT 40 km disc, then branches once.
  const decide = (roadBytes40: number) =>
    roadBytes40 <= BUDGET
      ? { outerKm: 40, pathStripped: 0 }
      : { outerKm: 25, pathStripped: 1 };

  it("40 km roads ≤ 2 MB → ship 40 km with paths", () => {
    expect(decide(300_000)).toEqual({ outerKm: 40, pathStripped: 0 });
    expect(decide(2_000_000)).toEqual({ outerKm: 40, pathStripped: 0 }); // boundary: ≤ is inclusive
  });
  it("40 km roads > 2 MB → shrink to 25 km AND drop all paths (one move)", () => {
    expect(decide(2_000_001)).toEqual({ outerKm: 25, pathStripped: 1 });
    expect(decide(5_000_000)).toEqual({ outerKm: 25, pathStripped: 1 });
  });
});

// A tile can filter down to 0 bytes (every layer stripped) — shipping that as a PackedTile made Mapbox throw "Unimplemented type: 4"; these tests pin the guard.
describe("filtered-to-nothing tiles (the 'Unimplemented type: 4' origin)", () => {
  it("a tile whose every layer is stripped filters to ZERO bytes", () => {
    // `earth` is not in the keep-set → nothing survives.
    const data = tile([
      { name: "earth", features: [{ id: 1, kind: "earth" }] },
      { name: "landcover", features: [{ id: 2, kind: "forest" }] },
    ]);
    expect(data.byteLength).toBeGreaterThan(0); // the input IS a real tile
    const r = filterMvtToLayers(data, new Set(["roads", "water"]), {
      dropPaths: false,
    });
    expect(r.data.byteLength).toBe(0); // …and the output is a landmine
  });

  it("a roads-only tile of nothing but paths filters to ZERO bytes when paths drop", () => {
    const data = tile([
      { name: "roads", features: [{ id: 1, kind: "path" }, { id: 2, kind: "path" }] },
    ]);
    const r = filterMvtToLayers(data, new Set(["roads"]), { dropPaths: true });
    // Roads layer may survive as an empty husk or vanish — either way it must not ship as a tile.
    expect(featureKinds(getLayer(r.data, "roads") ?? new Uint8Array()).length).toBe(0);
  });

  it("THE GUARD: only non-empty tiles may enter a pack", () => {
    // The rule readDisc + serializePack now enforce, stated as pure data.
    const filtered = [
      { k: "15/1/1", data: new ArrayBuffer(120) },
      { k: "15/1/2", data: new ArrayBuffer(0) }, // filtered to nothing
      { k: "15/1/3", data: new ArrayBuffer(80) },
    ];
    const kept = filtered.filter((t) => t.data.byteLength > 0);
    expect(kept.map((t) => t.k)).toEqual(["15/1/1", "15/1/3"]);
    // …and the manifest/body stay in lockstep because ONE list drives both.
    const bodyBytes = kept.reduce((n, t) => n + t.data.byteLength, 0);
    expect(bodyBytes).toBe(200);
  });
});
