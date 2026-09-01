import type { PMTiles } from "pmtiles";
import { filterMvtToLayers } from "./mvtFilter";
import { BLOB_DETAIL_LEVEL } from "./blob";
import { PACK_LAYER_NAMES } from "./packLayers";
import { boxFrame, buildBlobTile } from "./oneBlob";
import { GRID_RADIUS_KM, cellBox, cellsFor, pinTileKey, radiusBox } from "./grid";

// The measured bugs behind this file's invariants (the 50 km key bug, the
// deleted roads budget and ring pyramid, the clip and PNG detours) are written
// up in workers/PACK_HISTORY.md. Inline comments carry only what a reader
// needs at the line.

// ── the layer keep-set ───────────────────────────────────────────────────────
// ONE list, owned by `lib/contract/packLayers.ts` — the Worker filters by it
// and the phone's debug report reads the same table. Corridor packs (a LINE
// feature's thin route ribbon) ship roads only.
const ROADS_ONLY = new Set(["roads"]);
const PACK_KEEP: ReadonlySet<string> = new Set(PACK_LAYER_NAMES);

export function keepSet(corridor: boolean): ReadonlySet<string> {
  return corridor ? ROADS_ONLY : PACK_KEEP;
}

// How many tiles to read from R2 at once. 8-wide measured a 56 s cold build
// (the client timed out and the blob arrived a minute later "out of nowhere");
// 100 in flight blew the 128 MB Worker limit (error 1102). 32 holds both walls.
const PACK_POOL = 32;

// ── slippy-tile math ─────────────────────────────────────────────────────────
function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export interface DiscTile {
  z: number;
  x: number;
  y: number;
}

/** Every source tile overlapping `box` at zoom `z`. Tiles are read whole —
 *  what falls outside a cell belongs to the neighbouring cell's blob and is
 *  dropped at remap time by the frame, not by a clip. */
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

/** A filtered tile + its key, in disc order. */
interface PackedTile {
  k: string;
  data: ArrayBuffer;
}

/** Read + filter one set of tiles from the archive (decompressed MVT), pooled. */
async function readDisc(
  archive: PMTiles,
  disc: DiscTile[],
  corridor: boolean,
): Promise<{ tiles: PackedTile[]; empty: number; failed: number }> {
  const results: Array<PackedTile | null> = new Array(disc.length).fill(null);
  let failed = 0;
  let next = 0;
  const keep = keepSet(corridor);
  async function worker(): Promise<void> {
    while (next < disc.length) {
      const i = next++;
      const { z, x, y } = disc[i];
      try {
        const t = await archive.getZxy(z, x, y);
        if (t?.data?.byteLength) {
          // A tile the archive HAS can still filter down to NOTHING. A 0-byte
          // tile must never ship — the phone persists it and Mapbox throws
          // "Unimplemented type: 4" parsing it on every render pass — so treat
          // it as void/ocean and let it count as `empty`.
          const data = filterMvtToLayers(t.data, keep);
          if (data.byteLength > 0) results[i] = { k: `${z}/${x}/${y}`, data };
        }
      } catch {
        // A read FAILED (cold directory race, transient R2 error) — distinct
        // from a void tile, which returns no data without throwing. Counted so
        // the caller can retry against a warm directory.
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
  return { tiles, empty, failed };
}

/** Serialise packed tiles into the wire format the phone unpacks:
 *    [uint32 LE manifestByteLen][manifest JSON utf8][tile bytes, concatenated]
 *  manifest = { total, empty, tiles: [{ k:"…", n: byteLen }, ...], box }
 *
 *  `box` is the box the blob's geometry was drawn into — [w,s,e,n] degrees.
 *  It MUST travel with the pack: MVT coordinates are relative to a box, and the
 *  renderer has to use the SAME one or the data lands somewhere else (measured
 *  89 km off at Timbuktu when the client assumed the tile's box instead). */
function serializePack(
  packed: PackedTile[],
  totalDisc: number,
  empty: number,
  box?: { w: number; s: number; e: number; n: number },
): ArrayBuffer {
  // INVARIANT: a manifest entry with n:0 is the "Unimplemented type: 4"
  // landmine (see readDisc). ONE filtered list drives BOTH the manifest and
  // the body, so they can never desync.
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

/** Build one pin's pack: read the source tiles overlapping its radius, cut one
 *  blob per grid cell, serialise. `archive` is a PMTiles reader wired to R2 by
 *  the caller (index.ts). `diag`, if given, is filled for the X-Diag header;
 *  R2 read counts are added by the caller. */
export async function buildPack(
  archive: PMTiles,
  lng: number,
  lat: number,
  corridor = false,
  diag?: Record<string, number>,
): Promise<ArrayBuffer> {
  // The pin's own GPS box is the ONLY geometry here: it says what to read, and
  // the same box rides in the manifest to say where the picture goes.
  const box = radiusBox(lng, lat);
  const union = tilesForBox(box, BLOB_DETAIL_LEVEL);

  let read = await readDisc(archive, union, corridor);
  // Cold-cache guard: the FIRST build of an area can hit a PMTiles directory
  // race where many parallel reads throw. The directory is warm now, so one
  // retry builds on the true tile set.
  if (read.failed > 0) read = await readDisc(archive, union, corridor);

  // Whole tiles, deliberately: the downloaded region is a SUPERSET of the
  // displayed one (exactly how Mapbox offline regions work). Centring is the
  // camera's job; clipping geometry to the radius cuts boundary roads into
  // arcs and was deleted. Each cell is framed to ITS OWN box — framing a cell
  // to the pin's box re-anchors the geometry and draws it in the wrong place.
  const cells = cellsFor(lng, lat);
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
    if (blob.bytes.byteLength > 0) {
      // ⛔ KEYED BY THE PIN, NEVER THE CELL. A cell key (`8/49/93`) is shared
      // by neighbouring pins, so one pin's roads answered another pin's lookup
      // 50 km away. The pin's address — like the satellite image's key — is
      // never shared. The cell survives only as the tile's drawing frame.
      out.push({ k: pinTileKey(lng, lat, c), data: blob.bytes.buffer as ArrayBuffer });
    } else {
      emptyCells++; // a zero-byte blob must not ship — see readDisc
    }
  }

  if (diag) {
    diag.discTiles = union.length;
    diag.outerKm = GRID_RADIUS_KM;
    diag.blobFeatures = features;
    diag.blobBytes = out.reduce((n, t) => n + t.data.byteLength, 0);
    diag.cells = cells.length;
  }

  return serializePack(out, union.length, emptyCells, box);
}
