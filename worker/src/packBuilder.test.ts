// packBuilder — ring geometry + the three-ring routing.
//
// These guard the two things that broke while the z13 MID ring was being added, both
// of which fail SILENTLY in production: a mid-ring tile routed to the wrong keep-set
// (water vanishes across the default camera band) and the mid ring's bytes folded
// into the roads budget (every area reads as dense → paths stripped, reach cut).

import { describe, expect, it } from "vitest";
import {
  MID_ROAD_KINDS,
  RINGS,
  countsTowardBudget,
  keepSetForZoom,
  tilesForRing,
} from "./packBuilder";
import { BLOB_DETAIL_LEVEL } from "./blob";
import { PACK_LAYER_NAMES } from "./packLayers";

const HOME = { lng: -76.32622, lat: 45.25341 };

describe("RINGS", () => {
  it("ships three levels: z15 core, z13 mid, z12 outer", () => {
    expect(RINGS.map((r) => r.z).sort((a, b) => a - b)).toEqual([12, 13, 15]);
  });

  it("has NO gap wider than one zoom below the core", () => {
    // The whole point of the mid ring. MapLibre overzooms UP only, so a hole
    // between two shipped levels is a band with nothing to stretch — which is
    // what the phone's decoder existed to paper over.
    const zooms = RINGS.map((r) => r.z).sort((a, b) => a - b);
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i] - zooms[i - 1]).toBeLessThanOrEqual(2);
    }
  });
});

describe("keepSetForZoom", () => {
  it("ships EXACTLY the contract's layers — roads, water, places, pois", () => {
    // ⛔ THE LIST IS NOT DECLARED IN THE WORKER. `lib/contract/packLayers.ts` is
    // the one table; the phone's debug report reads the same file to say what a
    // blob is meant to hold. Three ring keep-sets routed by a zoom threshold
    // used to live here and the threshold compared two constants that drifted,
    // so the live pack shipped `roads` and nothing else (MEASURED 28 Aug 2026).
    expect([...keepSetForZoom(BLOB_DETAIL_LEVEL, false)].sort()).toEqual(
      [...PACK_LAYER_NAMES].sort(),
    );
    expect([...keepSetForZoom(BLOB_DETAIL_LEVEL, false)].sort()).toEqual([
      "places",
      "pois",
      "roads",
      "water",
    ]);
  });

  it("does NOT route by zoom — one blob, one read level, one list", () => {
    // Every tile is read at BLOB_DETAIL_LEVEL, so a zoom-routed keep-set has
    // exactly one live branch and N dead ones that look like coverage. Any z
    // must answer the same.
    for (const z of [1, 5, 9, 12, 13, 15]) {
      expect([...keepSetForZoom(z, false)].sort()).toEqual(
        [...keepSetForZoom(BLOB_DETAIL_LEVEL, false)].sort(),
      );
    }
  });

  it("does NOT ship landcover, landuse or earth", () => {
    // landcover: MEASURED empty at every zoom in this archive. landuse: the
    // v4-land-* fills that read it were deleted client-side. earth: coarse
    // tile-square blocks on the download frontier.
    const keep = keepSetForZoom(BLOB_DETAIL_LEVEL, false);
    for (const dead of ["landcover", "landuse", "earth", "buildings", "boundaries"]) {
      expect(keep.has(dead), `${dead} must not ship`).toBe(false);
    }
  });

  it("forces roads-only for corridor packs at every zoom", () => {
    for (const z of [12, 13, 15]) {
      expect([...keepSetForZoom(z, true)]).toEqual(["roads"]);
    }
  });
});

describe("MID_ROAD_KINDS", () => {
  it("drops paths — half the z13 road bytes, invisible at regional zoom", () => {
    // MEASURED across 5 cities' z13 tiles: path 58.0 kB of ~136 kB total.
    expect(MID_ROAD_KINDS.has("path")).toBe(false);
  });

  it("KEEPS minor_road — in rural country it IS the road network", () => {
    // REGRESSION GUARD. minor_road was dropped as dead weight on city byte counts;
    // a real pack then came back with 46 of 193 z13 tiles holding ZERO road
    // features, the tile under the pin among them, because sparse areas have no
    // major_road at all. Dropping this blanks the regional view exactly where the
    // app is used.
    expect(MID_ROAD_KINDS.has("minor_road")).toBe(true);
  });

  it("keeps the long-distance network that reads at regional zoom", () => {
    for (const k of ["major_road", "highway", "rail", "ferry"]) {
      expect(MID_ROAD_KINDS.has(k)).toBe(true);
    }
  });
});

describe("countsTowardBudget", () => {
  // ⛔ REWRITTEN 2026-08-21. These asserted the THREE-RING model (z15 core /
  // z13 mid / z12 outer), where excluding z13 was correct because it was extra
  // bytes over ground the other two rings already covered.
  //
  // `buildPack` no longer builds rings: it reads ONE grid box at
  // `BLOB_DETAIL_LEVEL`. So "exclude the mid ring" excluded the only ring there
  // is, and `roadsBytes` was 0 for every pack on earth — MEASURED live on
  // Wyoming, Washington and Toronto, the last of which read 10.5 MB from R2 to
  // report zero road bytes. See budgetZoomDrift.test.ts.
  it("counts the level the pack actually reads", () => {
    expect(countsTowardBudget(BLOB_DETAIL_LEVEL)).toBe(true);
  });

  it("still counts the shallow ring the threshold was calibrated on", () => {
    // BUDGET_OUTER_Z (12) is still emitted and still carries real road weight,
    // so the 2 MB threshold keeps seeing it.
    expect(countsTowardBudget(12)).toBe(true);
  });

  it("still counts levels deeper than the read level", () => {
    expect(countsTowardBudget(15)).toBe(true);
  });
});

describe("tilesForRing", () => {
  it("covers the same ground with ~4x the tiles one zoom deeper", () => {
    const z12 = tilesForRing(HOME.lng, HOME.lat, 25, 12);
    const z13 = tilesForRing(HOME.lng, HOME.lat, 25, 13);
    const ratio = z13.length / z12.length;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5);
  });

  it("returns a jagged disc, not the bounding rectangle", () => {
    // Law 2: the frontier is real tile edges. A full rectangle would mean the
    // radius filter stopped working.
    const tiles = tilesForRing(HOME.lng, HOME.lat, 25, 13);
    const xs = new Set(tiles.map((t) => t.x));
    const ys = new Set(tiles.map((t) => t.y));
    expect(tiles.length).toBeLessThan(xs.size * ys.size);
  });

  it("emits every tile at the requested zoom", () => {
    for (const t of tilesForRing(HOME.lng, HOME.lat, 25, 13)) {
      expect(t.z).toBe(13);
    }
  });
});
