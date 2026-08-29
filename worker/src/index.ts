// ⚠️ packBuilder ring geometry MUST stay in lockstep with tilesForRings() in ReTreever's v4CloudflareTiles.ts (phone's areaTilesPresent probe).

import { gunzipSync, gzipSync } from "fflate";
import {
  Compression,
  PMTiles,
  type RangeResponse,
  ResolvedValueCache,
  type Source,
} from "pmtiles";
import {
  DEFAULT_RADIUS_KM,
  fetchFires,
  MAX_RADIUS_KM,
} from "../../lib/r2Worker/firesWorker";
import { buildPack, PIN_KEYED_FROM_PV } from "./packBuilder";

/** Bump whenever pack contents change — else masked by a year-old immutable cache entry. */
const PACK_BUILD = "v30-pv-keyed-old-phone-roads";

interface Env {
  /** R2 bucket binding (see wrangler.toml [[r2_buckets]]). */
  TILES: R2Bucket;
  /** Object key of the .pmtiles archive the /{z}/{x}/{y}.pbf tile route reads. */
  PMTILES_KEY: string;
  /** Object key of the .pmtiles archive the /pack downloader route reads (the Ontario extract). */
  PACK_PMTILES_KEY: string;
  /** NASA FIRMS Area API key for /fires — Worker SECRET only, never [vars] (must never reach the app bundle). */
  FIRMS_MAP_KEY: string;
}

interface ReadStats {
  reads: number;
  bytes: number;
}
class R2Source implements Source {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly stats?: ReadStats,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
    });
    if (object === null) {
      throw new Error(`PMTiles archive not found in R2: ${this.key}`);
    }
    const data = await object.arrayBuffer();
    if (this.stats) {
      this.stats.reads++;
      this.stats.bytes += data.byteLength;
    }
    return {
      data,
      etag: object.etag,
    };
  }
}

// use gunzipSync (not DecompressionStream) — native version's per-call overhead made the cold build ~7s vs ~1s (measured).
function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const out = gunzipSync(new Uint8Array(buf));
  return Promise.resolve(out.buffer as ArrayBuffer);
}

/** Gzip /pack payload via fflate gzipSync (same reason as gunzip); client inflates this layer itself — NOT transport Content-Encoding. */
function gzipBuf(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const out = gzipSync(new Uint8Array(buf));
  return Promise.resolve(out.buffer as ArrayBuffer);
}
const decompress = (buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> => {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return Promise.resolve(buf);
  }
  if (compression === Compression.Gzip) return gunzip(buf);
  throw new Error(`unsupported PMTiles compression: ${compression}`);
};

// ResolvedValueCache BOUNDED to 64 — unbounded blew the Worker's 128MB limit (Cloudflare error 1102) on the 127GB planet archive.
const cache = new ResolvedValueCache(64, undefined, decompress);


const TILE_PATH = /^\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.pbf$/;

// Bump FIRE_ANSWER_VERSION whenever a response's correct shape changes — a TTL only expires STALE data, never INCOMPLETE data.
const FIRE_ANSWER_VERSION = 3;

// ⚠️ Add every new X-* response header to EXPOSED_HEADERS — CORS hides custom headers from JS by default; res.headers.get() silently returns null otherwise.
const EXPOSED_HEADERS = [
  "X-Pack-Build",
  "X-Pack-Cache",
  "X-Pack-Encoding",
  "X-Diag",
  "X-Fetched-At",
  "X-Sources-Ok",
].join(", ");

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": EXPOSED_HEADERS,
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/bench") {
      const n = Math.min(2000, Number(url.searchParams.get("n")) || 500);
      const conc = Math.min(256, Number(url.searchParams.get("conc")) || 100);
      const t0 = Date.now();
      let i = 0;
      let done = 0;
      const run = async (): Promise<void> => {
        while (i < n) {
          const k = i++;
          const obj = await env.TILES.get(env.PACK_PMTILES_KEY, {
            range: { offset: (k * 131072) % 2_000_000_000, length: 32768 },
          });
          if (obj) {
            await obj.arrayBuffer();
            done++;
          }
        }
      };
      await Promise.all(Array.from({ length: conc }, () => run()));
      const ms = Date.now() - t0;
      return new Response(
        `n=${n} conc=${conc} done=${done} totalMs=${ms} perRead=${(ms / n).toFixed(2)}ms`,
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "text/plain" } },
      );
    }

    if (url.pathname === "/fires") {
      const lng = Number(url.searchParams.get("lng"));
      const lat = Number(url.searchParams.get("lat"));
      const kmRaw = Number(url.searchParams.get("km"));
      const km = Math.min(
        MAX_RADIUS_KM,
        Number.isFinite(kmRaw) && kmRaw > 0 ? kmRaw : DEFAULT_RADIUS_KM,
      );
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return new Response("Bad Request — expected ?lng=<num>&lat=<num>", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }
      if (!env.FIRMS_MAP_KEY) {
        // Fail LOUD — a missing key must never degrade to an empty collection ("no fires near you" is the most dangerous lie this layer can tell).
        return new Response(
          "FIRMS_MAP_KEY is not configured on this Worker (wrangler secret put FIRMS_MAP_KEY)",
          { status: 500, headers: CORS_HEADERS },
        );
      }

      const snap = (n: number): string => (Math.round(n * 4) / 4).toFixed(2);
      const cacheUrl = new URL(url.toString());
      // FIRE_ANSWER_VERSION lives in the KEY, not just the TTL — a TTL only expires STALE data, never data that was WRONG when written.
      cacheUrl.search = `?v=${FIRE_ANSWER_VERSION}&lng=${snap(lng)}&lat=${snap(lat)}&km=${km}`;
      const fireCacheKey = new Request(cacheUrl.toString(), { method: "GET" });
      const fireEdge = caches.default;
      const fireHit = await fireEdge.match(fireCacheKey);
      if (fireHit) {
        return request.method === "HEAD"
          ? new Response(null, { status: 200, headers: fireHit.headers })
          : fireHit;
      }

      let body: string;
      let sourcesOk: number;
      let fetchedAt: number;
      try {
        const r = await fetchFires(env.FIRMS_MAP_KEY, lng, lat, km);
        body = JSON.stringify(r.collection);
        sourcesOk = r.sourcesOk;
        fetchedAt = r.fetchedAt;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 502 (not empty 200) so the phone keeps its last good cache instead of showing a falsely-empty map.
        return new Response(`Fire fetch failed: ${message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }

      const fireHeaders = {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        // 1 hour — FIRMS refreshes hourly, so anything longer serves superseded data.
        "Cache-Control": "public, max-age=3600",
        "X-Fetched-At": String(fetchedAt),
        "X-Sources-Ok": String(sourcesOk),
        // Custom X-* headers are invisible to JS unless explicitly exposed (CORS expose-headers trap — reads as null otherwise).
        "Access-Control-Expose-Headers": "X-Fetched-At, X-Sources-Ok",
      };
      ctx.waitUntil(
        fireEdge.put(fireCacheKey, new Response(body, { status: 200, headers: fireHeaders })),
      );
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: fireHeaders,
      });
    }

    if (url.pathname === "/pack") {
      const lng = Number(url.searchParams.get("lng"));
      const lat = Number(url.searchParams.get("lat"));
      // LINE corridor: thin roads-only ribbon (its own cache entry — see cacheKey).
      const corridor = url.searchParams.get("ring") === "corridor";
      // No pv param = probe → current shape; PIN_KEYED_FROM_PV — an old phone handed the new key renders no roads (see packBuilder.ts).
      const pvRaw = Number(url.searchParams.get("pv"));
      const packFormatVersion = Number.isFinite(pvRaw)
        ? pvRaw
        : PIN_KEYED_FROM_PV;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return new Response("Bad Request — expected ?lng=<num>&lat=<num>", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }

      // PACK_BUILD is part of the cache key — entries are immutable for a year, so without it a code change is invisible (measured: a 30km clip shipped and the response stayed byte-identical).
      const keyUrl = new URL(url.toString());
      keyUrl.searchParams.set("build", PACK_BUILD);
      // ⛔ keyShape is part of the cache key — without it the first caller of an area poisons the cache for the other fleet for a year (pin vs cell keying).
      keyUrl.searchParams.set(
        "keyShape",
        packFormatVersion >= PIN_KEYED_FROM_PV ? "pin" : "cell",
      );
      const cacheKey = new Request(keyUrl.toString(), { method: "GET" });
      const edge = caches.default;
      const cached = await edge.match(cacheKey);
      if (cached) {
        // Say so out loud. A silent hit is why a deploy can appear to do nothing.
        const hitHeaders = new Headers(cached.headers);
        hitHeaders.set("X-Pack-Cache", "HIT");
        return new Response(request.method === "HEAD" ? null : cached.body, {
          status: 200,
          headers: hitHeaders,
        });
      }

      const diag: Record<string, number> = {};
      let pack: ArrayBuffer;
      try {
        // index.ts owns R2 wiring; packBuilder is pure logic over the reader.
        const stats: ReadStats = { reads: 0, bytes: 0 };
        const source = new R2Source(env.TILES, env.PACK_PMTILES_KEY, stats);
        const archive = new PMTiles(source, cache, decompress);
        const tH = Date.now();
        await archive.getHeader(); // surface a bad archive as a thrown error → 502
        const tLoop = Date.now();
        pack = await buildPack(archive, lng, lat, corridor, diag, packFormatVersion);
        diag.r2Reads = stats.reads;
        diag.r2Bytes = stats.bytes;
        diag.headerMs = tLoop - tH;
        diag.loopMs = Date.now() - tLoop;
        // Gzip ourselves but DON'T set Content-Encoding: gzip — Cloudflare double-compresses on top and the browser only inflates one layer (garbage).
        pack = await gzipBuf(pack);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Pack build failed: ${message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
      const headers = {
        ...CORS_HEADERS,
        "Content-Type": "application/octet-stream",
        // Application-layer gzip (client gunzips it) — NOT a transport Content-Encoding.
        "X-Pack-Encoding": "gzip",
        // X-Pack-Build marks which build produced these bytes — without it a cached pack looks identical to a fresh one (measured: 30km clip shipped, response stayed byte-identical).
        "X-Pack-Build": PACK_BUILD,
        "X-Diag": `disc=${diag.discTiles} reads=${diag.r2Reads} rbytes=${diag.r2Bytes} headerMs=${diag.headerMs} loopMs=${diag.loopMs} outerKm=${diag.outerKm} pathStripped=${diag.pathStripped} roadsBytes=${diag.roadsBytes} pv=${packFormatVersion} keys=${packFormatVersion >= PIN_KEYED_FROM_PV ? "pin" : "cell"}`,
        "X-Pack-Cache": "MISS",
        "Cache-Control": "public, max-age=31536000, immutable",
      };
      // waitUntil so the cache put doesn't delay the response; opaque bytes replay unchanged on a HIT.
      ctx.waitUntil(edge.put(cacheKey, new Response(pack, { status: 200, headers })));
      return new Response(request.method === "HEAD" ? null : pack, {
        status: 200,
        headers,
      });
    }

    const match = TILE_PATH.exec(url.pathname);
    if (match === null) {
      return new Response("Not Found — expected /{z}/{x}/{y}.pbf, /pack?lng=&lat=, or /fires?lng=&lat=", {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);

    const source = new R2Source(env.TILES, env.PMTILES_KEY);
    const archive = new PMTiles(source, cache, decompress);

    // Validate the archive is readable up front → a clear 502 instead of a confusing 204.
    try {
      await archive.getHeader();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Failed to read PMTiles archive: ${message}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    let tile: RangeResponse | undefined;
    try {
      tile = await archive.getZxy(z, x, y);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`Tile lookup failed: ${message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }

    // Missing tile -> 204 so the map renderer overzooms cleanly instead of logging 404 noise.
    if (tile === undefined) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // tile.data is already decompressed (raw MVT protobuf) — serve as-is, no Content-Encoding.
    const responseHeaders: Record<string, string> = {
      ...CORS_HEADERS,
      "Content-Type": "application/x-protobuf",
      // Planet snapshot is immutable for a given upload — cache hard at every layer.
      "X-Pack-Cache": "MISS",
        "Cache-Control": "public, max-age=31536000, immutable",
    };

    const body = request.method === "HEAD" ? null : tile.data;
    return new Response(body, { status: 200, headers: responseHeaders });
  },
} satisfies ExportedHandler<Env>;
