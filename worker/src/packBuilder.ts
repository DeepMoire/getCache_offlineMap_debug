// ── packBuilder — build ONE area's offline vector pack from the PMTiles archive ──
//
// This is the whole "what tiles, how far, what to drop" brain, kept OUT of index.ts
// (which is just the HTTP router + R2/PMTiles plumbing). Three concerns live here:
//   1. RING GEOMETRY — which slippy tiles a pin's disc covers (jagged discs by radius).
//   2. THE ROADS BUDGET — the one rule that picks the radius + whether to drop paths.
//   3. PACK ASSEMBLY — read+filter the disc's tiles and serialise the binary blob.
//
// The per-tile MVT byte surgery (layer keep + kind allowlist + path strip) lives in
// ./mvtFilter.ts. This file decides WHICH tiles and the budget; mvtFilter decides
// WHAT survives inside each tile. index.ts owns R2 (it constructs the PMTiles archive
// and passes it in), so this module has no R2/Worker-runtime dependency — it's pure
// logic over a PMTiles reader, which keeps it unit-testable.

import type { PMTiles } from "pmtiles";
import {
  filterMvtToLayers,
  layerExtent,
  readVarint,
  skipField,
  writeVarint,
} from "./mvtFilter";
import { BLOB_DETAIL_Z } from "./roadBlob";
import { BLOB_DETAIL_LEVEL } from "./blob";
import { PACK_LAYER_NAMES } from "./packLayers";
import { boxFrame, buildBlobTile } from "./oneBlob";
import {
  BLOB_TILE_Z,
  GRID_RADIUS_KM,
  cellBox,
  cellsFor,
  cellTileKey,
  pinTileKey,
  radiusBox,
  type Cell,
} from "./grid";

/** The second level the roads budget measures, alongside the detail level.
 *  Purely a BUDGET calibration constant — it does not describe a ring, and the
 *  disc no longer has rings. Named so it cannot be mistaken for one. */
const BUDGET_OUTER_Z = 12;

// ── ring geometry — port of the client's tilesForRings() ──────────
// Inner 5 km @ z15 (full detail) + an outer z12 ring. The outer RADIUS is governed by
// the roads budget below (25 ↔ 40 km), so only the inner `km` and the outer `z` are
// read from RINGS (INNER_RING_GEO / OUTER_RING_Z). The client RINGS outer reach is the
// 40 km MAX (the superset for areaTileKeys); the Worker ships the 25-or-40 subset.
export const RINGS: ReadonlyArray<{ km: number; z: number }> = [
  { km: 5, z: 15 },
  { km: 25, z: 13 },
  { km: 25, z: 12 },
];

// ── THE MID RING (z13) — why a THIRD ring exists ─────────────────────────────
//
// The pack used to hold TWO levels and nothing between: a z15 core and a z12
// surround. MapLibre overzooms UP from the deepest level it has, never down, so
// z13-z14 — which is exactly where the default camera sits — had no tile to
// stretch. The phone filled that hole itself: unpack every stored tile into
// GeoJSON, glue the pieces, re-cut a fresh MVT pyramid, re-encode. MEASURED on
// device: the decode worker at 453 MB climbing 113 MB/s, 741 MB total heap.
//
// Shipping z13 removes the REASON that machinery exists. z14 needs no ring of its
// own — it overzooms from z13 for free, which is the "jumping between layers" the
// product explicitly accepts.
//
// COST — measured against the LIVE archive, not estimated. Raw archive bytes for a
// 25 km z13 disc look alarming (+45% to +130% over the raw baseline), but raw bytes
// are not what ships: every tile goes through `filterMvtToLayers` (roads + places
// only out here, kind-stripped) and then gzip, which together take ~90% off. The
// honest before/after is the /pack response size, recorded at the MID_RING_Z
// constant below.
/**
 * The mid ring's reach. Fixed — the roads budget governs the z12 OUTER reach only.
 *
 * 10 km, not 25. MEASURED (filtered + gzipped, the bytes that actually ship):
 *
 *            25 km        15 km       10 km        8 km
 *   home     153 kB        48 kB       24 kB       14 kB
 *   bc       158 kB       103 kB       82 kB       77 kB
 *   van      771 kB       462 kB      321 kB      257 kB
 *
 * Tile count scales with the square of the radius, so this is where the money is —
 * far more than any layer or kind trim. 10 km still puts the z13 band well beyond
 * the 5 km z15 core and the ~2-3 km satellite blob, which is all the user pans
 * around at that zoom; past that the z12 ring takes over, as it always did.
 */
// ── THE SAME DISC, SAVED AT EVERY ZOOM ───────────────────────────────────
// THE GOAL, IN THE USER'S WORDS: "a 30 kilometre radius that goes from 1 to 18.
// That's it. That's all I want."
//
// NOT EXTRA RADII. This is ONE circle — the outer radius, whatever the budget
// settled on — written out once per zoom level. Same centre, same edge, every
// level. There is no second shape and nothing to hand off between.
//
// WHY EVERY LEVEL AND NOT JUST ONE: a vector tile is only ever stretched
// BIGGER, never smaller. So a disc saved at z12 draws z12→z22 and NOTHING
// below: the renderer asks for z11/z10/z9 addresses, they were never saved, it
// draws nothing. Saving ONE extra level only MOVES that cliff — z9 instead of
// z12 — which is exactly what shipped three times tonight and was rejected
// three times ("it stops at 12 the same as every single time", "why can't we
// have a 30 kilometre blob that goes from 1 to 18?"). Saving EVERY level
// removes the cliff entirely, because every zoom has a tile of its own.
//
// COST: near zero, and it shrinks as you zoom out. A z9 tile is 55 km across so
// the whole disc needs ~4; by z6 one tile is 465 km and the disc fits inside a
// SINGLE tile — as do z5, z4, z3, z2 and z1. Eleven levels cost roughly 20-25
// tiles against the ~130 that z15 alone costs. The zoomed-out levels are also
// the cheapest bytes in the archive (Protomaps drops minor roads there).
//
// ⛔ ALWAYS BUILT FROM THE CALLER'S RADIUS. Never hardcode a km here: the disc
// is 40 km normally and 25 km when the roads budget shrinks it, and the wide
// levels must follow whichever it is. Three builds used a FIXED 40 km against a
// smaller disc and every one read on screen as a second, bigger shape popping
// in and out — "this huge really confusing 40 kilometre thing".

// CORRIDOR — a LINE feature's anchors bake a THIN roads-only ribbon, not the full
// satellite rings: one small z15 disc per anchor (~2.5 km), forced roads-only.
// Sampled anchors overlap into a continuous strip along the route.
const CORRIDOR_RINGS: ReadonlyArray<{ km: number; z: number }> = [{ km: 2.5, z: 15 }];

// ── THE layer keep-set ───────────────────────────────────────────────────────
// ⛔ ONE list, and it is NOT declared here: `lib/contract/packLayers.ts` says
// which source-layers (and which kinds inside them) a pack carries, the Worker
// filters by it, and the phone's debug report reads the same table to say what
// a blob is MEANT to hold. Three ring keep-sets (INNER / MID / OUTER) used to
// live here, routed by a zoom threshold that compared two constants which
// drifted apart — so every tile fell to the roads+places set, `places` was
// kind-filtered to a husk, and the live pack shipped `roads` and nothing else
// (MEASURED 28 Aug 2026: one source layer per blob). With ONE blob read at ONE
// level there is nothing to route; every tile gets the contract's list.
const ROADS_ONLY = new Set(["roads"]); // corridor packs: a thin route ribbon, no base
const PACK_KEEP: ReadonlySet<string> = new Set(PACK_LAYER_NAMES);
// Historical, for the record (bytes measured on the sparse test site):
//   · water on the old z13 mid ring was 655 kB vs 285 kB of roads — that was
//     water from ~3,950 z15 tiles across three rings. The contract now ships
//     ONLY lake/pond polygons + river/canal lines from the single z13 read
//     (streams dropped), MEASURED at +85 kB raw on a 445 kB pack.
//   · `landuse` is not shipped: the v4-land-* fills that read it were deleted.
//   · `landcover` is not shipped: empty at every zoom in this archive.
//   · `earth` is not shipped: coarse tile-square blocks on the frontier.
/**
 * The road kinds the z13 MID ring keeps: everything EXCEPT `path`.
 *
 * MEASURED across 5 cities' z13 tiles: path 58.0 kB, minor_road 58.0 kB,
 * major_road 14.9 kB, rail 3.9 kB, highway 0.8 kB, ferry 0.7 kB. Paths are half the
 * roads bytes and a footpath is not resolvable at a regional zoom, so dropping them
 * costs no legibility.
 *
 * ⚠️ `minor_road` WAS ALSO DROPPED, AND THAT WAS WRONG — don't re-drop it to save
 * bytes. It looked like the same dead weight (another 58 kB in the city sample), but
 * MEASURED on a real pack afterwards: 46 of 193 z13 tiles came back with a roads
 * layer holding ZERO features, the tile under the pin among them. In rural country
 * `minor_road` IS the road network and `major_road` is simply absent, so the trim
 * blanked the regional view at exactly the sparse locations this app exists for.
 * City byte counts are not the test; the back roads are.
 */
export const MID_ROAD_KINDS = new Set([
  "major_road",
  "minor_road",
  "highway",
  "rail",
  "ferry",
]);

/** Which layers survive in a tile. `z` is accepted for the call sites and the
 *  tests but no longer routes anything — the pack is ONE blob read at ONE level,
 *  and the two-constant threshold that used to sit here (`z >= BLOB_DETAIL_Z`
 *  vs a read level of `BLOB_DETAIL_LEVEL`) is the drift that silently dropped
 *  `pois` from every pack. Corridor packs stay roads-only. */
export function keepSetForZoom(_z: number, corridor: boolean): ReadonlySet<string> {
  if (corridor) return ROADS_ONLY;
  return PACK_KEEP;
}

/** Does a tile at zoom `z` count toward the ROADS BUDGET? The mid ring does not —
 *  see the note at the call site in readDisc. */
export function countsTowardBudget(z: number): boolean {
  // ⛔ DERIVED FROM THE LEVEL THE PACK READS. Never hard-code a zoom here.
  //
  // This said `z >= BLOB_DETAIL_Z || z === BUDGET_OUTER_Z` — z15 or z12 — while
  // `buildPack` reads every tile at `BLOB_DETAIL_LEVEL`, which moved to 13 for
  // build speed. 13 is neither, so the accumulator below never ran and
  // `roadsBytes` was 0 BY CONSTRUCTION.
  //
  // MEASURED on the LIVE Worker 2026-08-21 — Wyoming, Washington and Toronto
  // all returned `roadsBytes=0`; Toronto had read 10.5 MB out of R2 to get it.
  // The budget decides `dropPaths` and the pack's reach, so a constant 0 reads
  // as "sparse everywhere": paths never stripped, WIDE reach always shipped.
  //
  // ⚠️ THE IDENTICAL DRIFT ALREADY BIT THE KIND FILTER TWENTY LINES BELOW, and
  // its comment says so: "`BLOB_DETAIL_Z` is 15 but the read level moved to 13,
  // so `13 < 15` was ALWAYS true." That one was fixed; this one was left
  // pointing at the old constants. Comparing two constants that drift apart is
  // the silent-failure shape this file keeps producing — so the budget now
  // tracks the read level itself and cannot drift from it again.
  //
  // `BUDGET_OUTER_Z` stays: it is the shallow ring the 2 MB threshold and the
  // 9x MVT→GeoJSON ratio were calibrated against, and it is still emitted.
  return z >= BLOB_DETAIL_LEVEL || z === BUDGET_OUTER_Z;
}

// ── ROADS BUDGET — ONE rule, self-balancing reach ────────────────────────────
// Data usefulness is inverse to density: a sparse area needs to see FAR (you leave the
// highway from a long way out), a dense city needs only a TIGHT reach. So: DEFAULT to
// the wide 40 km. The budget is measured in DECODED-GeoJSON bytes — the SAME number
// the /files inspector shows for the "roads" row (which bundles roads + paths + power
// + everything in the roads source-layer). If 40 km decoded roads ≤ 2 MB → ship 40 km
// with paths. If > 2 MB → dense area: DROP ALL PATHS *and* shrink to 25 km (both at
// once). Roads of every other kind are always kept.
//
// We don't fully decode on the Worker (CPU). Instead we estimate decoded size from the
// MVT roads-layer bytes via a stable multiplier: MVT→GeoJSON for the roads layer
// inflates ~8.5–10× (measured across Saskatoon/Calgary/BC). 9× is the midpoint, so
// `decodedRoads ≈ mvtRoadsBytes × MVT_TO_GEOJSON`. The /files row is the ground truth.
export const ROAD_BUDGET_BYTES = 2_000_000; // 2 MB of DECODED roads (matches /files)
const MVT_TO_GEOJSON = 9; // MVT roads bytes → decoded-GeoJSON bytes, measured ratio

// How many tiles to read from R2 at once. R2-binding reads aren't subrequests, but the
// per-tile CPU (gunzip + PMTiles parse) is the bottleneck.
//
// ⛔ 8 WAS TOO SLOW AND IT BROKE THE PRODUCT. A cold 30 km blob is ~3,950 z15
// tiles; at 8-wide that measured `loopMs=56486` — 56 s of build. The client's
// fetch then timed out, backed off 60 s, and the blob arrived a minute later
// "out of nowhere", which read as random breakage. The fix is a FASTER BUILD,
// not only a longer client timeout.
//
// ⚠️ 100 in flight blew the 128 MB Worker limit (error 1102) on the world
// planet, which is why this is not simply "as high as possible". 32 is 4x the
// throughput at roughly a third of the concurrency that failed.
const PACK_POOL = 32;

// ── slippy-tile math ──────────────────────────────────────────────────────
function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
function tileToLng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tileToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function km(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLatKm = (bLat - aLat) * 111;
  const dLngKm = (bLng - aLng) * 111 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLatKm, dLngKm);
}

export interface DiscTile {
  z: number;
  x: number;
  y: number;
}

/** Every {z,x,y} at zoom `z` whose nearest point is within `radiusKm` — one jagged disc. */
export function tilesForRing(lng: number, lat: number, radiusKm: number, z: number): DiscTile[] {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const out: DiscTile[] = [];
  const x0 = lngToTileX(lng - dLng, z);
  const x1 = lngToTileX(lng + dLng, z);
  const y0 = latToTileY(lat + dLat, z);
  const y1 = latToTileY(lat - dLat, z);
  const max = 2 ** z - 1;
  for (let x = Math.max(0, x0); x <= Math.min(max, x1); x++) {
    for (let y = Math.max(0, y0); y <= Math.min(max, y1); y++) {
      const w = tileToLng(x, z);
      const e = tileToLng(x + 1, z);
      const n = tileToLat(y, z);
      const s = tileToLat(y + 1, z);
      const cx = Math.min(Math.max(lng, w), e);
      const cy = Math.min(Math.max(lat, s), n);
      if (km(lng, lat, cx, cy) > radiusKm) continue;
      out.push({ z, x, y });
    }
  }
  return out;
}

/**
 * Every source tile overlapping a CELL's box, at zoom `z`.
 *
 * The square counterpart of {@link tilesForRing}, and simpler for the same
 * reason the clip is gone: a box test is a rectangle overlap, with no distance
 * check per tile. Tiles are read whole — anything of a tile that falls outside
 * the cell belongs to the neighbouring cell's blob and is dropped at remap time
 * by the frame, not by a clip.
 */
export function tilesForBox(
  box: { w: number; s: number; e: number; n: number },
  z: number,
): DiscTile[] {
  const out: DiscTile[] = [];
  const max = 2 ** z - 1;
  const x0 = Math.max(0, lngToTileX(box.w, z));
  const x1 = Math.min(max, lngToTileX(box.e, z));
  const y0 = Math.max(0, latToTileY(box.n, z));
  const y1 = Math.min(max, latToTileY(box.s, z));
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  }
  return out;
}

/** Union of a ring-set — the corridor path passes CORRIDOR_RINGS; otherwise a custom set. */
function tilesForRings(
  lng: number,
  lat: number,
  rings: ReadonlyArray<{ km: number; z: number }>,
): DiscTile[] {
  return dedupeTiles(rings.flatMap((r) => tilesForRing(lng, lat, r.km, r.z)));
}

/** Dedupe a tile list by z/x/y, preserving first-seen order. */
function dedupeTiles(tiles: DiscTile[]): DiscTile[] {
  const seen = new Set<string>();
  const out: DiscTile[] = [];
  for (const t of tiles) {
    const k = `${t.z}/${t.x}/${t.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A filtered tile + its key, in disc order. */
interface PackedTile {
  k: string;
  data: ArrayBuffer;
}



/** Read + filter one disc of tiles from the archive (decompressed MVT), pooled. Returns
 *  the non-empty filtered tiles in input order, plus the summed roads + path bytes. */
/**
 * Clip ONE tile's features to the disc. 30 km means 30 km.
 *
 * Converts the disc centre + radius into this tile's local coordinate space,
 * then drops every feature whose bbox lies wholly outside it. Never decodes or
 * re-encodes geometry — survivors are copied byte-for-byte.
 */

async function readDisc(
  archive: PMTiles,
  disc: DiscTile[],
  dropPaths: boolean,
  corridor: boolean,
): Promise<{
  tiles: PackedTile[];
  empty: number;
  roadsBytes: number;
  pathBytes: number;
  failed: number;
}> {
  const results: Array<PackedTile | null> = new Array(disc.length).fill(null);
  let roadsBytes = 0;
  let pathBytes = 0;
  let failed = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < disc.length) {
      const i = next++;
      const { z, x, y } = disc[i];
      try {
        const t = await archive.getZxy(z, x, y);
        if (t?.data?.byteLength) {
          // Corridor → roads-only. Otherwise the contract's list (packLayers.ts):
          // roads + water + places + pois, each kind-filtered to what the phone
          // renders (mvtFilter's KIND_ALLOWLIST is derived from the same table).
          const keep = keepSetForZoom(z, corridor);
          // ⛔ NO KIND FILTER. "EVERYTHING" MEANS EVERYTHING.
          //
          // This used to strip roads to MID_ROAD_KINDS (major_road, minor_road,
          // highway, rail, ferry) whenever `z < BLOB_DETAIL_Z`. The reasoning was
          // sound for a PYRAMID — at a shallow zoom a side street is sub-pixel,
          // so it was 85% of the road bytes for nothing.
          //
          // It is wrong for ONE BLOB. The blob is drawn at EVERY zoom from its
          // stored level all the way in, so a track dropped "because it is
          // sub-pixel when zoomed out" is also missing when zoomed right in —
          // which is where the user actually needs it.
          //
          // ⚠️ AND THE TEST HAD SILENTLY INVERTED. `BLOB_DETAIL_Z` is 15 but the
          // read level moved to 13 for build speed, so `13 < 15` was ALWAYS true
          // and the filter applied to every tile in every blob. The user saw it:
          // "there's some sort of intermediate sized roads that got missed."
          //
          // A threshold comparing two constants that drifted apart is exactly the
          // silent-failure shape this file keeps producing. There is no threshold
          // now: nothing is dropped by kind.
          const r = filterMvtToLayers(t.data, keep, { dropPaths });
          // THE BUDGET MEASURES THE RINGS IT ALWAYS MEASURED — inner z15 + outer z12.
          //
          // The 2 MB threshold and the 9× MVT→GeoJSON ratio were both calibrated
          // against that two-ring sum across real cities. The z13 mid ring is NEW
          // bytes for the same ground, so folding it in would shift the scale under a
          // threshold nobody re-derived: it roughly DOUBLES the sum, tipping ordinary
          // areas over the line and stripping paths + cutting reach continent-wide.
          // Scoping the count to the outer ring alone is equally wrong in the other
          // direction (MEASURED: outer is ~86% of a sparse disc but only ~20% of a
          // dense one, so Vancouver would read as sparse and ship the WIDE reach).
          // Excluding just the new ring leaves the calibrated comparison intact.
          if (countsTowardBudget(z)) {
            roadsBytes += r.roadsBytes;
            pathBytes += r.pathBytes;
          }
          // A tile the archive HAS can still filter down to NOTHING — every layer it
          // carried was stripped (paths dropped, landcover/landuse gone, pois/places
          // kind-filtered out). `filterMvtToLayers` builds its output from scratch, so
          // that case yields a 0-byte buffer. Shipping it is the bug that put 7k
          // zero-byte tiles in every device's `rt-tiles-v3`: the phone stored them as
          // real entries, and Mapbox's worker died parsing each one ("Unimplemented
          // type: 4") on every render pass. A filtered-to-nothing tile is
          // INDISTINGUISHABLE from an ocean/void tile — so treat it as one: leave
          // `results[i]` null and let it count as `empty` below.
          // ── CLIP TO THE CIRCLE — 30 km means 30 km ──────────────────
          //
          // ⛔ NO PER-TILE DISC CLIP. Deleted with the disc itself.
          //
          // It existed because tile SELECTION ("does this square touch the
          // circle") is not the same as shipping a circle: a z9 tile is 55 km
          // wide, so one kept by a grazing corner dragged roads up to 78 km past
          // the rim — the user measured 80 km on screen. The answer was to cut
          // every tile to the circle, per tile, on every build.
          //
          // The square grid removes the QUESTION. A cell is a box snapped to the
          // world, source tiles are boxes, and the single edge trim happens once
          // in oneBlob.ts against the cell frame — where both neighbours cut on
          // the SAME line, so the pieces meet instead of leaving a seam.
          const clipped = { bytes: new Uint8Array(r.data), kept: 1, dropped: 0 };
          if (clipped.bytes.byteLength > 0) {
            results[i] = { k: `${z}/${x}/${y}`, data: clipped.bytes.buffer as ArrayBuffer };
          }
        }
      } catch {
        // A read FAILED (cold directory race, transient R2 error) — distinct from a
        // void/ocean tile (which returns no data, no throw). Count it: a build with
        // failures has an UNDER-counted roadsBytes, so the budget can't be trusted.
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: PACK_POOL }, () => worker()));
  let empty = 0;
  const tiles: PackedTile[] = [];
  for (const r of results) {
    if (r) tiles.push(r);
    else empty++;
  }
  return { tiles, empty, roadsBytes, pathBytes, failed };
}

// ⛔ `selectDisc` IS DELETED. It chose a disc radius, applied a roads budget and
// read one cell's tiles. `buildPack` now reads the UNION of every cell the pin
// needs, once, and cuts each cell out of that single read — so there is no
// per-cell selection step left to own.

/** Serialise packed tiles into the wire format the phone unpacks:
 *    [uint32 LE manifestByteLen][manifest JSON utf8][tile bytes, concatenated]
 *  manifest = { total, empty, tiles: [{ k:"z/x/y", n: byteLen }, ...] } */
function serializePack(
  packed: PackedTile[],
  totalDisc: number,
  empty: number,
  /**
   * THE BOX THE BLOB'S GEOMETRY WAS DRAWN INTO — [w, s, e, n] degrees.
   *
   * ⛔ THIS MUST TRAVEL WITH THE PACK. MVT coordinates are relative to a box,
   * and the renderer has to use the SAME one or the data lands somewhere else.
   *
   * MEASURED at Timbuktu when it did not: the blob was framed to the pin's box
   * but the client assumed the z8 TILE's box, so 30 km of roads was stretched
   * across a 150 km tile — drawn 89 km from the pin, and only 19 km from the
   * TILE centre, which is what gave the bug away.
   */
  box?: { w: number; s: number; e: number; n: number },
): ArrayBuffer {
  // INVARIANT: a manifest entry with n:0 is not a tile — it is a landmine. The phone
  // slices it into a 0-byte ArrayBuffer, persists it as a real tile, and Mapbox throws
  // "Unimplemented type: 4" parsing it on every render pass, forever. `readDisc`
  // already drops these at the source; this is the wall no future caller can walk past.
  // ONE filtered list drives BOTH the manifest and the body, so they can never desync.
  const kept = packed.filter((t) => t.data.byteLength > 0);
  const tiles: Array<{ k: string; n: number }> = [];
  let bodyBytes = 0;
  for (const t of kept) {
    tiles.push({ k: t.k, n: t.data.byteLength });
    bodyBytes += t.data.byteLength;
  }
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({ total: totalDisc, empty, tiles, box }),
  );
  const out = new Uint8Array(4 + manifestBytes.byteLength + bodyBytes);
  new DataView(out.buffer).setUint32(0, manifestBytes.byteLength, true);
  out.set(manifestBytes, 4);
  let off = 4 + manifestBytes.byteLength;
  for (const t of kept) {
    out.set(new Uint8Array(t.data), off);
    off += t.data.byteLength;
  }
  return out.buffer;
}

/**
 * THE PACK FORMAT VERSION AT WHICH TILE KEYS BECAME PIN-KEYED.
 *
 * The client sends `pv=<PACK_FORMAT_VERSION>` on every /pack request and always
 * has. Below this number a phone looks tiles up by the bare slippy address
 * `${z}/${x}/${y}`; at or above it, by `pin/<lng>,<lat>/<z>/<x>/<y>`.
 *
 * 33 is where the square-grid rewrite landed on the client (see the child's
 * packDownload.ts changelog: "33 = THE SQUARE GRID"). The App Store build in
 * the field is pv 15, so it takes the cell-keyed branch.
 *
 * A REQUEST WITH NO `pv` IS TREATED AS CURRENT, not as legacy: every shipped
 * client sends one, so a missing value means a hand-made probe or a curl, and
 * defaulting those to the modern shape keeps the debug surface honest.
 */
export const PIN_KEYED_FROM_PV = 33;

/** Build one area's pack: pick the disc by the roads budget, read+filter its tiles,
 *  and serialise. `archive` is a PMTiles reader wired to R2 by the caller (index.ts).
 *  `diag`, if given, is filled with outerKm / pathStripped / discTiles for the X-Diag
 *  header. R2 read counts (reads/bytes/timings) are added by the caller. */
export async function buildPack(
  archive: PMTiles,
  lng: number,
  lat: number,
  corridor = false,
  diag?: Record<string, number>,
  packFormatVersion = PIN_KEYED_FROM_PV,
): Promise<ArrayBuffer> {
  // ── READ THE SOURCE TILES OVERLAPPING THE PIN'S RADIUS ──────────────────
  //
  // `radiusBox` is the pin's own GPS box — the ONLY geometry in this function.
  // There is no cell, no tile grid and no address to reconcile: the box says
  // what to read, and (below) the same box says where the picture goes.
  const box = radiusBox(lng, lat);
  const union = tilesForBox(box, BLOB_DETAIL_LEVEL);

  let read = await readDisc(archive, union, false, corridor);
  // Cold-cache guard: the FIRST build of an area can hit a PMTiles directory
  // race where many parallel reads throw. If any failed the directory is warm
  // now → read once more, so the picture is built on the true tile set.
  if (read.failed > 0) read = await readDisc(archive, union, false, corridor);

  // ══ ROADS TRAVEL AS VECTOR TILES ════════════════════════════════════════
  //
  // ⛔ REVERTED FROM `roads-as-image` (2026-08-20), ON THE USER'S CALL, AFTER
  // SEEING BOTH RENDERINGS ON ONE SCREEN.
  //
  // The PNG experiment tried to fix a CENTRING bug by changing the TRANSPORT.
  // It did centre — MEASURED 0.000 km — and was still worse in every way that
  // matters on a phone:
  //
  //   • a raster cannot restyle (no dark mode, no width-by-zoom, no filtering)
  //   • it blurs as soon as you zoom past the resolution it was rendered at
  //   • one flat picture per pin replaces a tiled map that already worked
  //
  // The user, with vector roads and the PNG side by side: "if that's the PNG,
  // it's pretty shitty... earlier today the vector was working really nice."
  // The phone's vector renderer was never removed — only the server stopped
  // feeding it. So this is a revert, not a rewrite.
  //
  // ⚠️ CENTRING IS A COVERAGE QUESTION, NOT A FRAMING ONE — the distinction
  // that cost a day. A vector tile's geometry spans the box it was REQUESTED
  // at, so each cell MUST be framed to its OWN box (`boxFrame(cellBox(c))`).
  // Framing a cell to the pin's box re-anchors the geometry and draws it in
  // the wrong place; that shipped twice. The pin's real GPS point decides
  // WHICH cells are built (`cellsFor`), never how they are framed.
  const cells = cellsFor(lng, lat);

  // ⛔ NO CLIP. WHOLE TILES, DELIBERATELY (2026-08-20).
  //
  // A clip to the pin's 30 km box shipped for one build and was REMOVED. It did
  // centre the coverage, and it also cut every road crossing the boundary into
  // an arc — which is not a bug in the clip, it is what clipping means.
  //
  // ⚠️ THE RULE, from how Mapbox/MapLibre actually do offline: the DOWNLOADED
  // region and the DISPLAYED region are different things. A tile region is
  // defined by a geometry, and the SDK downloads every tile INTERSECTING it —
  // "which may include many tiles outside the visible area". The request is
  // point-centred; the DATA never is. Whole tiles, always a superset.
  //
  // Centring is the CAMERA's job (`setCenter(pin)` on the phone), and a hard
  // edge, if ever wanted, is a client-side mask — never a cut in the geometry.
  //
  // What this deletes: the arcs, and the whole class of bug where the server
  // tries to make tile-shaped data behave like point-shaped data.
  const out: PackedTile[] = [];
  let features = 0;
  let emptyCells = 0;
  for (const c of cells) {
    const blob = buildBlobTile(
      read.tiles.map((t) => {
        const [z, x, y] = t.k.split("/").map(Number);
        return { tile: { z, x, y }, data: new Uint8Array(t.data) };
      }),
      boxFrame(cellBox(c)),
    );
    features += blob.features;
    // A blob that filtered down to nothing is NOT stored — a zero-byte tile is
    // parsed on every render pass and throws ("Unimplemented type: 4").
    if (blob.bytes.byteLength > 0) {
      // ⛔ KEYED BY THE PIN, NOT BY THE CELL. THIS IS THE 50 km BUG (2026-08-20).
      //
      // `cellTileKey(c)` is a GRID ADDRESS — `8/49/93` — and two different pins
      // can land in the same square. So one pin's roads were written under a key
      // another pin also asks for, and the phone happily served the neighbour's
      // tiles. MEASURED, the user's Yellowstone pin:
      //     pin        -110.7470, 44.6629
      //     roads box   nw -111.1016,44.3334  se -110.3509,44.0859
      //     -> the box was 36.6 km SOUTH of the pin, and its north edge was
      //        BYTE-IDENTICAL to the previous (Moran) pin's box.
      // The pin was not inside its own roads at all.
      //
      // ⚠️ THE SATELLITE NEVER HAD THIS BUG, and its key is the reason:
      //     satImageKey  = `${lng},${lat}`     ← the pin. Never shared.
      //     cellTileKey  = `${z}/${ix}/${iy}`  ← a square. Shared by neighbours.
      // Same map, same pins, 5 m vs 50 km. The user: "I make the pin first, so
      // we have the GPS point. You just get the satellite image and then the
      // roads blob and you put them both in the same spot."
      //
      // So roads now travel under the PIN'S OWN ADDRESS, exactly like the photo.
      // The cell survives only as the tile's DRAWING FRAME (MapLibre needs a
      // slippy box to paint into); it is no longer the identity of the data.
      //
      // ⛔ BACKWARDS COMPATIBILITY — DO NOT COLLAPSE THIS BRANCH.
      //
      // The pin-keyed fix above shipped to the Worker on 2026-08-20. Phones
      // built BEFORE it (App Store iOS 1.0.93, PACK_FORMAT_VERSION 15) store
      // whatever key we send, then look tiles up by their OWN computed
      // `${z}/${x}/${y}`. Send them a `pin/...` key and the lookup misses
      // every single time: the tiles sit in IndexedDB, unreachable, and the
      // map draws NO ROADS. Silent, total, and roads-only — the satellite is
      // on its own key and is unaffected, which is exactly how it presents in
      // the field ("the satellite came, but the roads didn't").
      //
      // The client has always sent `pv=<PACK_FORMAT_VERSION>`; the Worker
      // simply never read it. It does now, so one deploy serves both fleets:
      // an old phone gets the cell key it can find, a current one gets the
      // pin key that fixes the 50 km bug. Delete this branch only when no
      // installed build below pv 33 is left in the wild.
      out.push({
        k:
          packFormatVersion >= PIN_KEYED_FROM_PV
            ? pinTileKey(lng, lat, c)
            : cellTileKey(c),
        data: blob.bytes.buffer as ArrayBuffer,
      });
    } else {
      emptyCells++;
    }
  }

  if (diag) {
    diag.discTiles = union.length;
    diag.outerKm = GRID_RADIUS_KM;
    diag.pathStripped = 0;
    diag.roadsBytes = read.roadsBytes;
    diag.blobFeatures = features;
    diag.blobBytes = out.reduce((n, t) => n + t.data.byteLength, 0);
    diag.cells = cells.length;
  }

  // The PIN'S OWN BOX rides along in the manifest. The tiles are addressed by
  // cell, but the box records the point this pack was built for — so the phone
  // can always check where these roads belong without re-deriving it.
  return serializePack(out, union.length, emptyCells, box);
}
