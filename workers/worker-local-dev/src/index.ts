// ⚠️ geometry in ./packBuilder.ts + lib/contract/grid.ts MUST stay in lockstep with the phone's probe (ReTreever's v4CloudflareTiles.ts `areaTilesPresent`) — both sides must agree on which tiles an area holds.

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
} from "../../../lib/worker/firesWorker"; // beside fireFetch.ts, same repo
import { buildPack } from "./packBuilder";

/** Bump whenever the PACK CONTENTS change. Part of the edge cache key, so a
 *  new build can never be masked by a year-old immutable cache entry. */
const PACK_BUILD = "v33-oob-pin-guard";

interface Env {
  /** R2 bucket binding (see wrangler.toml [[r2_buckets]]). */
  TILES: R2Bucket;
  /** Object key(s) of the .pmtiles archive the /{z}/{x}/{y}.pbf tile route reads.
   *  Comma-separated list allowed — local dev serves several bbox samples
   *  (.dev.vars, written by setupLocalTiles.sh) where prod has one planet archive. */
  PMTILES_KEY: string;
  /** Object key(s) of the .pmtiles archive the /pack downloader route reads.
   *  Same comma-separated list rule as PMTILES_KEY. */
  PACK_PMTILES_KEY: string;
  /** NASA FIRMS Area API key for /fires. A Worker SECRET (`wrangler secret put
   *  FIRMS_MAP_KEY`), never a [vars] entry — it must never reach the app bundle. */
  FIRMS_MAP_KEY: string;
}

/**
 * A pmtiles `Source` backed by a single R2 object. `getBytes(offset, length)` becomes one
 * R2 ranged read. The PMTiles client issues a handful of these per tile (header, directory,
 * tile data) — the directory/header reads are memoized by `ResolvedValueCache`.
 */
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
      // R2 object etag — lets the PMTiles client detect a swapped archive mid-flight.
      etag: object.etag,
    };
  }
}

/**
 * gzip decompress via fflate's SYNCHRONOUS gunzipSync. PMTiles calls this for both its
 * internal directories (must be decompressed to find a tile) and the tile bytes — so
 * getZxy() returns DECOMPRESSED protobuf, which we serve raw.
 *
 * Why fflate, not the native DecompressionStream: the /pack route gunzips ~1000 tiny
 * tiles per request, and spinning up a DecompressionStream + Response per tile has heavy
 * fixed per-call overhead that dominated the cold build (~7s). gunzipSync has no stream
 * setup — it's a plain function call — which collapses that to ~1s. (Measured.)
 */
function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const out = gunzipSync(new Uint8Array(buf));
  return Promise.resolve(out.buffer as ArrayBuffer);
}

/** Gzip the /pack payload (fflate gzipSync, same no-stream-overhead reason as gunzip).
 *  The pack is decompressed MVT (very compressible, ~30% smaller gzipped); the client
 *  inflates this one explicit layer itself (NOT transport Content-Encoding — see the
 *  pack route). Big win on slow links (3G). */
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

// Header + directory cache. Workers cannot share promises across requests, so use
// ResolvedValueCache (values, not promises) — the variant pmtiles documents for Workers.
//
// BOUNDED to 64 entries (was unbounded/default 100). On the 127 GB WORLD planet a
// single leaf directory is huge, and locating a wide z13 ring's tiles touches many
// of them; an unbounded cache piled enough decompressed planet directories to blow
// the Worker's 128 MB limit (Cloudflare error 1102 "exceeded memory limit" — NOT a
// CPU timeout). 64 holds a whole ring's distinct leaf dirs without thrashing while
// staying well under the ceiling. (Regional archives never hit this — their whole
// directory tree is tiny.)
const cache = new ResolvedValueCache(64, undefined, decompress);


const TILE_PATH = /^\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.pbf$/;

const archiveKeys = (v: string): string[] =>
  v.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Edge-cache key version for /fires. See the long note at the cache-key build
 * site: bump this whenever a change alters what a CORRECT response looks like,
 * so a deploy invalidates the edge immediately instead of waiting out a TTL.
 *   v1 → the DAY_RANGE=1 era, which cached empty collections after UTC midnight.
 *   v2 → DAY_RANGE=2 (fires.ts). Real answers.
 *   v3 → adds the optional `px` (pixel footprint km) and `dn` (day/night)
 *        properties that feed the tap popup. Deploying alone was NOT enough:
 *        the edge kept serving perfectly-valid v2 answers that simply lacked
 *        the new keys, so the popup silently fell back to its defaults. Same
 *        lesson as v1→v2 — a TTL expires STALE data, never INCOMPLETE data.
 */
const FIRE_ANSWER_VERSION = 3;

/**
 * ⛔ EXPOSE-HEADERS IS NOT OPTIONAL — A CROSS-ORIGIN RESPONSE HIDES CUSTOM
 * HEADERS FROM JS BY DEFAULT.
 *
 * `Access-Control-Allow-Origin: *` lets the request through; it does NOT let
 * the page READ any header beyond the CORS-safelisted handful. Every `X-*`
 * header below is invisible to `res.headers.get()` unless it is named here —
 * and `get()` returns `null`, not an error, so the failure is completely
 * silent.
 *
 * MEASURED: the app's console printed `{"build":"","cache":"","diag":""}` for an
 * entire debugging session. Those are the Worker's build id and its own timing —
 * so while chasing "why is this so slow", the server-side timing that would have
 * answered it was being discarded by the browser, and every conclusion in that
 * session was drawn without it.
 *
 * ⚠️ Add EVERY new `X-*` response header to this list at the same time you add
 * it. A diagnostic the client cannot read is worse than no diagnostic: it looks
 * like it is working.
 */
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

    // ── /bench?n=&conc= — TEMP diagnostic: raw parallel R2 range reads ──
    // Isolates whether the R2 binding parallelizes reads (vs pmtiles serializing
    // them). Fires `n` reads of 32 KB at staggered offsets, `conc` at a time.
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

    // ── /fires?lng=&lat=&km= — NASA FIRMS hotspots for one area ──
    //
    // Shaped like /pack (validate → edge-cache probe → build → waitUntil put),
    // with ONE deliberate difference: freshness. Tiles are immutable and cache
    // for a year; hotspots are worthless at ~6 h, so this caches 1 hour and
    // stamps X-Fetched-At so the phone can render "as of Xh ago".
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
        // Fail LOUD. A missing key must never degrade to an empty collection —
        // "no fires near you" is the most dangerous lie this layer can tell.
        return new Response(
          "FIRMS_MAP_KEY is not configured on this Worker (wrangler secret put FIRMS_MAP_KEY)",
          { status: 500, headers: CORS_HEADERS },
        );
      }

      // Snap the centre to ~0.25° (~25 km) so nearby users share ONE cached
      // slice instead of each minting a unique object. The disc is 500 km, so a
      // 25 km centre shift is immaterial to what's on screen — but it turns a
      // crew of planters on the same block into a single upstream fetch.
      const snap = (n: number): string => (Math.round(n * 4) / 4).toFixed(2);
      const cacheUrl = new URL(url.toString());
      // FIRE_ANSWER_VERSION is in the KEY, not just the TTL.
      //
      // A TTL only expires data that has gone STALE; it does nothing about data
      // that was WRONG when it was written. When DAY_RANGE=1 was returning empty
      // collections (see fires.ts), deploying the fix changed NOTHING for hours:
      // every already-queried cell kept serving its cached empty answer, and the
      // zone's Browser Cache TTL rule (14400s) outranks the 3600 below, so the
      // real window was four hours per cell — over a burning province.
      //
      // Bumping this token mints a brand-new key space, so a deploy invalidates
      // instantly and deterministically instead of waiting out a TTL we don't
      // fully control. BUMP IT whenever a change alters what a correct response
      // looks like.
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
        // 502 (not an empty 200) so the phone KEEPS its last good cache and
        // shows honest stale data rather than a falsely-empty map.
        return new Response(`Fire fetch failed: ${message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }

      const fireHeaders = {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        // 1 hour — FIRMS itself refreshes hourly, so anything longer serves
        // data NASA has already superseded.
        "Cache-Control": "public, max-age=3600",
        "X-Fetched-At": String(fetchedAt),
        "X-Sources-Ok": String(sourcesOk),
        // Custom X-* headers are invisible to JS unless explicitly exposed
        // (the CORS expose-headers trap — reads as null otherwise).
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

    // ── /pack?lng=&lat= — the v4 downloader's one-shot endpoint ──
    if (url.pathname === "/pack") {
      const lng = Number(url.searchParams.get("lng"));
      const lat = Number(url.searchParams.get("lat"));
      // LINE corridor: thin roads-only ribbon (its own cache entry — see cacheKey).
      const corridor = url.searchParams.get("ring") === "corridor";
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return new Response("Bad Request — expected ?lng=<num>&lat=<num>", {
          status: 400,
          headers: CORS_HEADERS,
        });
      }

      // Edge cache: a given (lng,lat) → a deterministic disc of an immutable
      // archive, so a built pack is reusable across users (the shared demo centre
      // is built once globally, then served instantly). `*.workers.dev` doesn't
      // auto-cache, so we drive the Cache API explicitly. Keyed on the bare URL
      // (origin+path+query) so the cache hit doesn't depend on request headers.
      // THE BUILD IS PART OF THE KEY. Entries are stored `immutable` for a
      // year, so without this a code change that alters the pack is invisible:
      // the edge replays the old bytes and the deploy looks like a no-op.
      // MEASURED — the 30 km clip shipped and /pack returned a byte-identical
      // 3,471,606-byte response built by the previous code.
      const keyUrl = new URL(url.toString());
      keyUrl.searchParams.set("build", PACK_BUILD);
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
        // Wire the PMTiles reader to R2 here (index.ts owns R2); packBuilder is
        // pure logic over the reader. Time the header fetch + the build for X-Diag.
        const stats: ReadStats = { reads: 0, bytes: 0 };
        const tH = Date.now();
        // First archive whose own bounds contain the pin wins.
        // ⛔ a pin outside every archive's bounds must FAIL LOUD, never build an
        // empty pack — 200-OK-empty is indistinguishable from "no roads here" and
        // gets edge-cached immutable. Local dev serves bbox SAMPLES (see
        // setupLocalTiles.sh), so this is the guard that says "wrong sample", not
        // "no data". Second occurrence of this bug class: the Firenze seed, then
        // the northern-BC seed with every fixture pin outside it (31 Aug 2026).
        let archive: PMTiles | undefined;
        const coverages: string[] = [];
        for (const key of archiveKeys(env.PACK_PMTILES_KEY)) {
          const candidate = new PMTiles(
            new R2Source(env.TILES, key, stats),
            cache,
            decompress,
          );
          const header = await candidate.getHeader(); // surface a bad archive as a thrown error → 502
          if (
            lng >= header.minLon && lng <= header.maxLon &&
            lat >= header.minLat && lat <= header.maxLat
          ) {
            archive = candidate;
            break;
          }
          coverages.push(
            `${key} covers ${header.minLon},${header.minLat} → ${header.maxLon},${header.maxLat}`,
          );
        }
        if (archive === undefined) {
          return new Response(
            `Pin ${lng},${lat} is outside every archive's coverage:\n` +
              coverages.map((c) => `  ${c}`).join("\n") +
              `\nLocal dev serves sample extracts — add or widen a bbox in ` +
              `setupLocalTiles.sh and restart, or switch the CONFIG panel to a cloud tier.`,
            { status: 422, headers: CORS_HEADERS },
          );
        }
        const tLoop = Date.now();
        pack = await buildPack(archive, lng, lat, corridor, diag);
        diag.r2Reads = stats.reads;
        diag.r2Bytes = stats.bytes;
        diag.headerMs = tLoop - tH;
        diag.loopMs = Date.now() - tLoop;
        // Gzip the body ourselves, but DON'T set Content-Encoding: gzip. If we
        // advertise the encoding, Cloudflare's edge auto-compresses ON TOP (the
        // body arrives double-gzipped and the browser only inflates one layer →
        // garbage). Sending opaque gzipped octet-stream sidesteps all edge/Cache
        // auto-encoding; the client inflates this one explicit layer itself.
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
        // The body is gzip-compressed at the application layer (client gunzips it).
        // NOT a transport Content-Encoding — see the comment above.
        "X-Pack-Encoding": "gzip",
        // Which BUILD produced these bytes. Without this a cached pack is
        // indistinguishable from a freshly-built one, and a deploy that changes
        // the pack looks like it did nothing (measured: a 30 km clip shipped and
        // the response was byte-identical, because the edge replayed a year-old
        // immutable entry).
        "X-Pack-Build": PACK_BUILD,
        "X-Diag": `disc=${diag.discTiles} reads=${diag.r2Reads} rbytes=${diag.r2Bytes} headerMs=${diag.headerMs} loopMs=${diag.loopMs} outerKm=${diag.outerKm} cells=${diag.cells} features=${diag.blobFeatures} bytes=${diag.blobBytes}`,
        "X-Pack-Cache": "MISS",
        "Cache-Control": "public, max-age=31536000, immutable",
      };
      // Store the gzipped body under the cache key. waitUntil so the put doesn't
      // delay the response. Opaque bytes → a cache HIT replays them unchanged.
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

    // First archive that holds the tile wins (several bbox samples locally,
    // one planet archive in prod).
    let tile: RangeResponse | undefined;
    for (const key of archiveKeys(env.PMTILES_KEY)) {
      const archive = new PMTiles(new R2Source(env.TILES, key), cache, decompress);

      // Validate the archive is readable up front → a clear 502 instead of a confusing 204.
      try {
        await archive.getHeader();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Failed to read PMTiles archive ${key}: ${message}`, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }

      try {
        tile = await archive.getZxy(z, x, y);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`Tile lookup failed: ${message}`, {
          status: 500,
          headers: CORS_HEADERS,
        });
      }
      if (tile !== undefined) break;
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

