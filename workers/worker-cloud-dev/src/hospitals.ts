// /hospitals — pure logic only; index.ts wires the route.
//
// Source: hospitalsWorld.v*.bin BUNDLED WITH THE WORKER (a wrangler Data
// module — see `rules` in wrangler.toml), baked by workers/bakeHospitals.mjs
// from OSM amenity=hospital — the same OpenStreetMap data the planet archive
// is built from. The R2 bucket holds roads ONLY; hospitals deliberately don't
// live there. Nor are they read out of planet.pmtiles at request time:
// hospitals only fully materialize in its z15 tiles (a 200 km disc there is
// ~200k reads), and the pois layer drops the emergency tag.

export const HOSPITAL_RADIUS_KM = 200;

/** Pack format — same header dialect as /pack (packBuilder.ts serializePack):
 *  [uint32 LE indexLen][index JSON][cell JSON blobs, concatenated].
 *  Cell offsets are relative to the first byte AFTER the index. A cell blob is
 *  a JSON array of [lng, lat, name] or [lng, lat, name, emergency]. */
export interface HospitalsIndex {
  v: number;
  /** Grid cell size in degrees (5 → 72×36 world grid, keys "cy_cx"). */
  cellDeg: number;
  count: number;
  generated: string;
  cells: Record<string, [number, number]>;
}

export type HospitalEntry =
  | [number, number, string]
  | [number, number, string, string];

/** Parse the bundled pack once (call at first request, cache the result —
 *  module scope survives across requests within an isolate). Throws on a
 *  malformed pack rather than answering empty: "no hospitals near you" must
 *  never be a packaging bug's lie. */
export function parseHospitalsPack(pack: ArrayBuffer): {
  index: HospitalsIndex;
  dataOrigin: number;
} {
  const indexLen = new DataView(pack).getUint32(0, true);
  const index = JSON.parse(
    new TextDecoder().decode(new Uint8Array(pack, 4, indexLen)),
  ) as HospitalsIndex;
  if (!index.cellDeg || !index.cells) {
    throw new Error("hospitals pack: malformed index");
  }
  return { index, dataOrigin: 4 + indexLen };
}

/** One cell's entries out of the bundled pack. */
export function readCellEntries(
  pack: ArrayBuffer,
  dataOrigin: number,
  span: [number, number],
): HospitalEntry[] {
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(pack, dataOrigin + span[0], span[1])),
  ) as HospitalEntry[];
}

/** Grid keys ("cy_cx") whose cells can intersect the disc. Wraps the
 *  antimeridian; near the poles the lng span caps at the full circle. */
export function cellKeysForDisc(
  lng: number,
  lat: number,
  cellDeg: number,
  radiusKm: number,
): string[] {
  const latDeg = radiusKm / 111.32;
  const s = Math.max(-90, lat - latDeg);
  const n = Math.min(90, lat + latDeg);
  // The disc's widest parallel decides the lng span — using the centre's
  // latitude under-covers on the poleward side.
  const cosMin = Math.min(
    Math.cos((s * Math.PI) / 180),
    Math.cos((n * Math.PI) / 180),
  );
  const lngDeg = cosMin > 1e-6 ? Math.min(180, radiusKm / (111.32 * cosMin)) : 180;
  const cols = Math.ceil(360 / cellDeg);
  const maxCy = Math.ceil(180 / cellDeg) - 1;
  const cy0 = Math.max(0, Math.floor((s + 90) / cellDeg));
  const cy1 = Math.min(maxCy, Math.floor((n + 90) / cellDeg));
  const cx0 = Math.floor((lng - lngDeg + 180) / cellDeg);
  const cx1 = Math.floor((lng + lngDeg + 180) / cellDeg);
  const keys = new Set<string>();
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      keys.add(`${cy}_${((cx % cols) + cols) % cols}`);
    }
  }
  return [...keys];
}

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface HospitalFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { name: string; emergency?: string };
}

/** The response body: every hospital in `cellArrays` within the radius, as a
 *  FeatureCollection. `emergency` rides through raw (yes/no/…) ONLY when OSM
 *  tags it — absence means "unknown", so the UI may badge on it but the layer
 *  must never filter to ER-only. */
export function hospitalsCollection(
  cellArrays: HospitalEntry[][],
  lng: number,
  lat: number,
): { type: "FeatureCollection"; features: HospitalFeature[] } {
  const features: HospitalFeature[] = [];
  for (const entries of cellArrays) {
    for (const e of entries) {
      if (haversineKm(lat, lng, e[1], e[0]) > HOSPITAL_RADIUS_KM) continue;
      const properties: HospitalFeature["properties"] = { name: e[2] };
      if (e.length > 3 && typeof e[3] === "string") properties.emergency = e[3];
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [e[0], e[1]] },
        properties,
      });
    }
  }
  return { type: "FeatureCollection", features };
}
