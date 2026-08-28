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
  it("does NOT put water on the z13 mid ring", () => {
    // Water here was TRIED and MEASURED: it made the mid ring 77% of the entire
    // pack (655 kB vs 285 kB at the sparse test site) for lake polygons the z15
    // core already draws where the user actually is. The mid ring exists to give
    // z13-z14 a road network to stretch, not a second copy of the hydrology.
    expect([...keepSetForZoom(13, false)]).not.toContain("water");
    expect([...keepSetForZoom(13, false)]).toContain("roads");
  });

  it("ROADS ONLY on the detail level — no water, no landuse", () => {
    // BUILD SPEED. Water polygons are the heaviest thing in a z15 tile and a
    // cold 30 km blob is ~3,950 of them; the build hit 56 s, which timed the
    // client out and made the feature look broken. `landuse` was already dead
    // weight — the v4-land-* style layers that read it were deleted, so those
    // bytes shipped and painted nothing.
    const keep = keepSetForZoom(15, false);
    expect([...keep].sort()).toEqual(["pois", "roads"]);
  });

  it("does NOT ship landcover — it is empty in this archive", () => {
    // MEASURED at home / Cascades / Vancouver, z12 / z13 / z15: landcover had 0
    // features every time while landuse carried all the fill kinds.
    expect([...keepSetForZoom(15, false)]).not.toContain("landcover");
  });

  it("ONE threshold: detail level gets the basemap, every shallower level roads + places", () => {
    // The old model had three named rings with three keep-sets and an inline
    // ternary routing between them — the shape that silently regressed once
    // already (the z13 ring fell through and lost all its water).
    //
    // Now there is ONE threshold, from the spec. At or above the detail level:
    // the full basemap. Below it: roads + places, because at those zooms the
    // whole disc is a few pixels wide and water/landuse are invisible weight.
    expect([...keepSetForZoom(15, false)].sort()).toEqual([
      "pois",
      "roads",
    ]);
    // ⛔ THE READ LEVEL IS THE DETAIL LEVEL. `buildPack` reads every tile at
    // `BLOB_DETAIL_LEVEL` (13) — the three-ring model is gone, so z13 is not a
    // "mid ring", it is the ONLY ring. It therefore gets the full basemap.
    //
    // This test previously asserted z13 → ["places","roads"], which passed
    // while the routing compared against BLOB_DETAIL_Z (15): `13 >= 15` was
    // false, so every tile fell through to OUTER_RING and `pois` — the entire
    // offline hospitals feature — shipped in NO pack anywhere. The test was
    // green the whole time because it encoded the bug.
    expect([...keepSetForZoom(BLOB_DETAIL_LEVEL, false)].sort()).toEqual([
      "pois",
      "roads",
    ]);
    for (const z of [12, 9, 5, 1]) {
      expect([...keepSetForZoom(z, false)].sort()).toEqual(["places", "roads"]);
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
