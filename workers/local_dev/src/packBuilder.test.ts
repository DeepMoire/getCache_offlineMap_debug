import { describe, expect, it } from "vitest";
import { keepSet, tilesForBox } from "./packBuilder";
import { PACK_LAYER_NAMES } from "./packLayers";

describe("keepSet", () => {
  it("ships EXACTLY the contract's layers — roads, water, places, pois", () => {
    // ⛔ THE LIST IS NOT DECLARED IN THE WORKER. `lib/contract/packLayers.ts` is
    // the one table; the phone's debug report reads the same file to say what a
    // blob is meant to hold. Worker-local keep-sets drifted once and the live
    // pack shipped `roads` and nothing else (MEASURED 28 Aug 2026).
    expect([...keepSet(false)].sort()).toEqual([...PACK_LAYER_NAMES].sort());
    expect([...keepSet(false)].sort()).toEqual(["places", "pois", "roads", "water"]);
  });

  it("does NOT ship landcover, landuse or earth", () => {
    // landcover: MEASURED empty at every zoom in this archive. landuse: the
    // v4-land-* fills that read it were deleted client-side. earth: coarse
    // tile-square blocks on the download frontier.
    const keep = keepSet(false);
    for (const dead of ["landcover", "landuse", "earth", "buildings", "boundaries"]) {
      expect(keep.has(dead), `${dead} must not ship`).toBe(false);
    }
  });

  it("forces roads-only for corridor packs", () => {
    expect([...keepSet(true)]).toEqual(["roads"]);
  });
});

describe("tilesForBox", () => {
  const BOX = { w: -76.4, s: 45.2, e: -76.2, n: 45.3 };

  it("covers the whole box — every tile between the corner tiles, inclusive", () => {
    const tiles = tilesForBox(BOX, 13);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    expect(tiles.length).toBe(xs.size * ys.size);
    expect(tiles.length).toBeGreaterThan(0);
  });

  it("emits every tile at the requested zoom", () => {
    for (const t of tilesForBox(BOX, 13)) expect(t.z).toBe(13);
  });
});
