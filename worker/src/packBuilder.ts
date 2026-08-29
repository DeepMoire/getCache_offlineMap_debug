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

/** The second level the roads budget measures. Purely a budget calibration constant — not a ring, since the disc no longer has rings. */
const BUDGET_OUTER_Z = 12;

// Port of the client's tilesForRings().
export const RINGS: ReadonlyArray<{ km: number; z: number }> = [
  { km: 5, z: 15 },
  { km: 25, z: 13 },
  { km: 25, z: 12 },
];

// ⛔ Ring km must always derive from the caller's radius — hardcoding a km here shipped a second, popping-in-and-out shape on screen (tried 3 times).

// A LINE feature's anchors bake a thin roads-only ribbon: one small z15 disc per anchor (~2.5 km), overlapping into a continuous strip.
const CORRIDOR_RINGS: ReadonlyArray<{ km: number; z: number }> = [{ km: 2.5, z: 15 }];

// Must match the client decode's roads+water-below-DETAIL_INNER_Z rule (decodeBucketKind in v4Decode.ts).
const ROADS_ONLY = new Set(["roads"]); // corridor packs: a thin route ribbon, no base
// 25 km z12 OUTER ring: roads + places only — `earth` dropped (ugly at this zoom), `places` gives major-town labels.
const OUTER_RING = new Set(["roads", "places"]);
// ⛔ Roads + pois only — water/landuse removed for build speed (56s cold build timed the client out).
// ⚠️ If restoring water, measure first — the old 5 km-radius cost does not apply at the current 30 km.
const INNER_RING = new Set(["roads", "pois"]);
// 25 km z13 MID ring: the band the default camera sits in. Roads only.
// Don't add `places` here — the outer ring already draws them; this would double-render every label.
const MID_RING = new Set(["roads"]);
/** The road kinds the z13 MID ring keeps: everything EXCEPT `path`. */
// ⚠️ Don't drop minor_road too — it IS the road network in rural areas; dropping it left 46/193 z13 tiles with zero roads, including the pin's own tile.
export const MID_ROAD_KINDS = new Set([
  "major_road",
  "minor_road",
  "highway",
  "rail",
  "ferry",
]);

/** Which layers survive in a tile at zoom `z`. */
// ⛔ Exported for testability — an inline ternary routing here silently regressed before (z13 fell through to OUTER_RING and lost its water).
export function keepSetForZoom(z: number, corridor: boolean): ReadonlySet<string> {
  if (corridor) return ROADS_ONLY;
  // Detail level = full basemap; every shallower level = roads + places only. One threshold, no per-ring cases.
  // ⛔ Compare against BLOB_DETAIL_LEVEL, not BLOB_DETAIL_Z — mismatch here silently dropped `pois` (the whole hospitals feature) from every pack.
  if (z >= BLOB_DETAIL_LEVEL) return INNER_RING;
  return OUTER_RING;
}

/** Does a tile at zoom `z` count toward the roads budget? The mid ring does not. */
export function countsTowardBudget(z: number): boolean {
  // ⛔ Never hard-code a zoom here — must derive from the level the pack actually reads. A stale comparison against BLOB_DETAIL_Z left roadsBytes=0 for every pack (measured live: Wyoming, Washington, Toronto).
  // BUDGET_OUTER_Z (12) stays — the 2 MB threshold and 9x MVT→GeoJSON ratio were calibrated against it.
  return z >= BLOB_DETAIL_LEVEL || z === BUDGET_OUTER_Z;
}

// Self-balancing reach: ≤2 MB decoded roads → ship 40 km with paths; over budget → drop paths and shrink to 25 km.
export const ROAD_BUDGET_BYTES = 2_000_000; // 2 MB of DECODED roads (matches /files)
const MVT_TO_GEOJSON = 9; // MVT roads bytes → decoded-GeoJSON bytes, measured ratio

// How many tiles to read from R2 at once — per-tile CPU (gunzip + PMTiles parse) is the bottleneck, not subrequests.
// ⛔ Don't go below 32 — 8-wide measured 56s cold builds and timed the client out.
// ⚠️ Don't go above 32 either — 100 in flight blew the 128 MB Worker limit (error 1102).
const PACK_POOL = 32;

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

/** Every source tile overlapping a CELL's box, at zoom `z` — the square counterpart of tilesForRing. */
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

/** Read + filter one disc of tiles from the archive (decompressed MVT), pooled — returns the non-empty filtered tiles in input order plus the summed roads + path bytes. */
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
          // Corridor → roads only. Below detail level → roads + places. Detail level → full keep set (kind-filtered per mvtFilter).
          const keep = keepSetForZoom(z, corridor);
          // ⛔ No kind filter here — "everything" means everything. A blob is drawn at every zoom from its stored level, so kind-stripping for a shallow-zoom pyramid also removes detail when zoomed in.
          // ⚠️ A stale BLOB_DETAIL_Z vs BLOB_DETAIL_LEVEL comparison previously applied this filter to every tile in every blob, silently — watch for that drift pattern.
          const r = filterMvtToLayers(t.data, keep, { dropPaths });
          // Don't fold the z13 mid ring into the budget sum — it roughly doubles it against a threshold calibrated on inner+outer only, stripping paths and cutting reach continent-wide.
          if (countsTowardBudget(z)) {
            roadsBytes += r.roadsBytes;
            pathBytes += r.pathBytes;
          }
          // A tile that filters down to 0 bytes must NOT ship — it crashed Mapbox's worker ("Unimplemented type: 4") on every render pass; treat it as empty/void instead.
          // ⛔ No per-tile disc clip — the square grid removes the need; edge trim happens once in oneBlob.ts against the cell frame instead.
          const clipped = { bytes: new Uint8Array(r.data), kept: 1, dropped: 0 };
          if (clipped.bytes.byteLength > 0) {
            results[i] = { k: `${z}/${x}/${y}`, data: clipped.bytes.buffer as ArrayBuffer };
          }
        }
      } catch {
        // A read failure (cold directory race, transient R2 error) is distinct from a void tile — count it, since it under-counts roadsBytes and makes the budget untrustworthy.
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

/** Serialise packed tiles into the wire format the phone unpacks: [uint32 LE manifestByteLen][manifest JSON utf8][tile bytes, concatenated]; manifest = {total, empty, tiles:[{k,n}]}. */
function serializePack(
  packed: PackedTile[],
  totalDisc: number,
  empty: number,
  // ⛔ box MUST travel with the pack — MVT coords are relative to it; a mismatched box drew roads 89 km from the pin (measured, Timbuktu).
  box?: { w: number; s: number; e: number; n: number },
): ArrayBuffer {
  // INVARIANT: a manifest entry with n:0 is a landmine — the phone persists it and Mapbox throws parsing it, forever. readDisc already drops these; don't let one back in.
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

/** Pack format version at which tile keys became pin-keyed (33 = client's square-grid rewrite); below it, keys are bare slippy `${z}/${x}/${y}`, at/above, `pin/<lng>,<lat>/<z>/<x>/<y>`. */
// A request with no `pv` is treated as current, not legacy — every shipped client sends one, so a missing value means a hand-made probe.
export const PIN_KEYED_FROM_PV = 33;

/** Build one area's pack: read+filter the disc's tiles and serialise. `archive` is a PMTiles reader wired to R2 by the caller; `diag`, if given, is filled with outerKm/pathStripped/discTiles for the X-Diag header. */
export async function buildPack(
  archive: PMTiles,
  lng: number,
  lat: number,
  corridor = false,
  diag?: Record<string, number>,
  packFormatVersion = PIN_KEYED_FROM_PV,
): Promise<ArrayBuffer> {
  // radiusBox is the pin's own GPS box — the only geometry in this function; it drives both what is read and where the picture goes.
  const box = radiusBox(lng, lat);
  const union = tilesForBox(box, BLOB_DETAIL_LEVEL);

  let read = await readDisc(archive, union, false, corridor);
  // Cold-cache guard: the first build can hit a PMTiles directory race where reads throw — retry once now that the directory is warm.
  if (read.failed > 0) read = await readDisc(archive, union, false, corridor);

  // ⛔ Roads travel as vector tiles, not a raster image — reverted from a PNG experiment that centred correctly but couldn't restyle, blurred on zoom, and lost the tiled map.
  // ⚠️ Each cell MUST be framed to its OWN box (boxFrame(cellBox(c))) — framing to the pin's box re-anchors the geometry and draws it in the wrong place; that shipped twice.
  const cells = cellsFor(lng, lat);

  // ⛔ No clip — whole tiles, deliberately. A prior clip to the pin's box centred coverage but cut roads crossing the boundary into arcs.
  // ⚠️ Downloaded region ≠ displayed region: ship whole tiles intersecting the area (a superset); centring is the camera's job, never a geometry cut.
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
    // A blob that filters down to nothing is NOT stored — a zero-byte tile is parsed on every render pass and throws ("Unimplemented type: 4").
    if (blob.bytes.byteLength > 0) {
      // ⛔ Keyed by the PIN, not the cell — cellTileKey is a shared grid address, so two pins in the same square overwrote each other's roads (measured: Yellowstone pin got the previous pin's box, 36.6 km off).
      // ⚠️ The satellite never had this bug — its key is always `${lng},${lat}` (the pin), never a shared grid square.
      // ⛔ BACKWARDS COMPAT — DO NOT COLLAPSE THIS BRANCH. Phones built before pv 33 look tiles up by their own `${z}/${x}/${y}`; sending them a pin key makes every lookup silently miss (no roads, ever). Delete only when no installed build below pv 33 remains.
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

  // The pin's own box rides along in the manifest so the phone can check where these roads belong without re-deriving it.
  return serializePack(out, union.length, emptyCells, box);
}
