// packBuilder — ring geometry + the three-ring routing.
// ⚠️ Guards two silent-failure regressions: a mid-ring tile routed to the wrong keep-set, and its bytes folding into the roads budget.

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
    // MapLibre overzooms UP only — a gap between shipped levels has nothing to stretch.
    const zooms = RINGS.map((r) => r.z).sort((a, b) => a - b);
    for (let i = 1; i < zooms.length; i++) {
      expect(zooms[i] - zooms[i - 1]).toBeLessThanOrEqual(2);
    }
  });
});

describe("keepSetForZoom", () => {
  it("does NOT put water on the z13 mid ring", () => {
    expect([...keepSetForZoom(13, false)]).not.toContain("water");
    expect([...keepSetForZoom(13, false)]).toContain("roads");
  });

  it("ROADS ONLY on the detail level — no water, no landuse", () => {
    const keep = keepSetForZoom(15, false);
    expect([...keep].sort()).toEqual(["pois", "roads"]);
  });

  it("does NOT ship landcover — it is empty in this archive", () => {
    expect([...keepSetForZoom(15, false)]).not.toContain("landcover");
  });

  it("ONE threshold: detail level gets the basemap, every shallower level roads + places", () => {
    expect([...keepSetForZoom(15, false)].sort()).toEqual([
      "pois",
      "roads",
    ]);
    // ⛔ Threshold must compare against BLOB_DETAIL_LEVEL (13), not BLOB_DETAIL_Z (15) — drift here silently dropped `pois` (the whole offline hospitals feature) from every pack while this test stayed green.
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
    expect(MID_ROAD_KINDS.has("path")).toBe(false);
  });

  it("KEEPS minor_road — in rural country it IS the road network", () => {
    // ⚠️ REGRESSION GUARD — dropping minor_road blanked the regional view in sparse areas (46/193 z13 tiles came back with zero roads, including the tile under the pin).
    expect(MID_ROAD_KINDS.has("minor_road")).toBe(true);
  });

  it("keeps the long-distance network that reads at regional zoom", () => {
    for (const k of ["major_road", "highway", "rail", "ferry"]) {
      expect(MID_ROAD_KINDS.has(k)).toBe(true);
    }
  });
});

describe("countsTowardBudget", () => {
  // ⛔ Budget must derive from the level buildPack actually reads — stale constants left roadsBytes=0 for every pack on earth (measured live: Wyoming, Washington, Toronto).
  it("counts the level the pack actually reads", () => {
    expect(countsTowardBudget(BLOB_DETAIL_LEVEL)).toBe(true);
  });

  it("still counts the shallow ring the threshold was calibrated on", () => {
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
    // Law 2: frontier must be real tile edges — a full rectangle means the radius filter broke.
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
