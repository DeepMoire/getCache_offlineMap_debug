#!/usr/bin/env node
/**
 * bakeHospitals.mjs — one-time bake of the WORLD hospital pack the tiles
 * Worker's /hospitals route serves (see workers/<tier>/src/hospitals.ts).
 *
 * Source: OSM `amenity=hospital` via Overpass — the same OpenStreetMap data
 * `planet.pmtiles` is built from. The archive itself cannot be the extraction
 * source: hospitals only fully materialize in its z15 tiles (min_zoom runs
 * 13–16, features appear at min_zoom−1 — measured on sampleOttawa 1 Sep 2026:
 * z12 holds 13 of 30), and no local copy of the 127 GB archive exists to walk.
 * Overpass also carries `emergency=*`, which Protomaps' pois layer drops.
 *
 * Output: hospitals-world.v1.pack —
 *   [uint32 LE indexLen][index JSON][cell JSON blobs, concatenated]
 *   index = { v, cellDeg, count, generated, cells: { "cy_cx": [offset, len] } }
 *   offsets are relative to the first byte AFTER the index. Each cell blob is
 *   a JSON array of [lng, lat, name] or [lng, lat, name, emergency].
 * Same header shape as the /pack wire format (packBuilder.ts serializePack),
 * so both sides of the bucket speak one dialect.
 *
 * Run:      node bakeHospitals.mjs
 * Then:     npx wrangler r2 object put offline-tiles/hospitals-world.v1.pack \
 *             --file hospitals-world.v1.pack --remote        (from any worker dir)
 * Local:    setupLocalTiles.sh loads the pack into the local R2 simulator
 *           automatically when this file sits beside it.
 *
 * A re-bake (OSM moves on) ships under a NEW filename (v2, …) + a
 * HOSPITALS_KEY bump in the wrangler.tomls — the responses are edge-cached
 * immutable, so the key IS the cache buster.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ⚠️ boxes are (S, W, N, E), sized for what Overpass will answer in one query.
// They overlap on purpose — dedupe below makes overlap free, gaps are the bug.
const REGIONS = [
	["north-america", 5, -170, 84, -50],
	["greenland", 58, -75, 84, -10],
	["iceland-n-atlantic", 55, -35, 68, -10],
	["south-america", -60, -90, 15, -30],
	["europe", 35, -25, 72, 45],
	["africa", -35, -20, 38, 55],
	["middle-east", 12, 25, 45, 65],
	["central-asia", 35, 45, 55, 90],
	["north-asia", 50, 45, 82, 180],
	["south-asia", 5, 60, 40, 100],
	["east-asia", 18, 73, 55, 150],
	["southeast-asia", -15, 90, 30, 155],
	["oceania", -50, 100, 0, 180],
	["west-pacific", -20, 150, 25, 180],
	["southern-ocean-w", -90, -180, -50, 0],
	["southern-ocean-e1", -90, 0, -50, 90],
	["southern-ocean-e2", -90, 90, -50, 180],
];

const ENDPOINTS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
];

const CELL_DEG = 5;
const OUT = new URL("./hospitals-world.v1.pack", import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRegion(name, s, w, n, e) {
	const bbox = `${s},${w},${n},${e}`;
	const query =
		`[out:json][timeout:300];` +
		`(node["amenity"="hospital"](${bbox});` +
		`way["amenity"="hospital"](${bbox});` +
		`relation["amenity"="hospital"](${bbox}););` +
		`out center;`;
	for (let attempt = 0; attempt < 6; attempt++) {
		const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				body: `data=${encodeURIComponent(query)}`,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					// overpass-api.de's front server 406es Node's default UA — identify
					// per the OSM API usage policy instead.
					"User-Agent": "getcache-hospitals-bake/1.0 (https://getcache.org)",
				},
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			return json.elements ?? [];
		} catch (err) {
			console.warn(`[${name}] attempt ${attempt + 1} failed (${endpoint}): ${err.message}`);
			await sleep(10_000 * (attempt + 1));
		}
	}
	throw new Error(`[${name}] all attempts failed — a gap here would silently drop a continent`);
}

// Per-region cache in .bake-cache/ — Overpass drops regions under load, and a
// resumable run must not re-download a continent to retry an island.
const CACHE_DIR = new URL("./.bake-cache/", import.meta.url).pathname;
mkdirSync(CACHE_DIR, { recursive: true });

const byCoord = new Map(); // "lat,lng" @5dp → entry; dedupes region overlap
for (const [name, s, w, n, e] of REGIONS) {
	const cacheFile = `${CACHE_DIR}${name}.json`;
	let elements;
	if (existsSync(cacheFile)) {
		elements = JSON.parse(readFileSync(cacheFile, "utf8"));
		console.log(`[${name}] cached (${elements.length})`);
	} else {
		elements = await fetchRegion(name, s, w, n, e);
		writeFileSync(cacheFile, JSON.stringify(elements));
		await sleep(5000); // be nice to the free servers
	}
	let kept = 0;
	for (const el of elements) {
		const lat = el.lat ?? el.center?.lat;
		const lon = el.lon ?? el.center?.lon;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
		if (byCoord.has(key)) continue;
		const entry = [
			Number(lon.toFixed(5)),
			Number(lat.toFixed(5)),
			el.tags?.name ?? "Hospital",
		];
		// emergency=* carried through raw when tagged (yes/no/…) — coverage is
		// patchy, so absence means "unknown", never "no ER".
		if (typeof el.tags?.emergency === "string") entry.push(el.tags.emergency);
		byCoord.set(key, entry);
		kept++;
	}
	console.log(`[${name}] fetched ${elements.length}, new after dedupe ${kept} (total ${byCoord.size})`);
}

if (byCoord.size < 50_000) {
	// OSM holds ~190k hospitals; far fewer means a region silently came back thin.
	throw new Error(`only ${byCoord.size} hospitals — refusing to bake a hollow world`);
}

// ── bucket into 5° cells and serialize ──────────────────────────────────────
const cells = new Map(); // "cy_cx" → entries[]
for (const entry of byCoord.values()) {
	const [lng, lat] = entry;
	const cy = Math.min(35, Math.max(0, Math.floor((lat + 90) / CELL_DEG)));
	const cx = Math.min(71, Math.max(0, Math.floor((lng + 180) / CELL_DEG)));
	const k = `${cy}_${cx}`;
	if (!cells.has(k)) cells.set(k, []);
	cells.get(k).push(entry);
}

const enc = new TextEncoder();
const blobs = [];
const index = {
	v: 1,
	cellDeg: CELL_DEG,
	count: byCoord.size,
	generated: new Date().toISOString().slice(0, 10),
	cells: {},
};
let offset = 0;
for (const [k, entries] of [...cells.entries()].sort()) {
	const bytes = enc.encode(JSON.stringify(entries));
	index.cells[k] = [offset, bytes.byteLength];
	blobs.push(bytes);
	offset += bytes.byteLength;
}
const indexBytes = enc.encode(JSON.stringify(index));
const out = new Uint8Array(4 + indexBytes.byteLength + offset);
new DataView(out.buffer).setUint32(0, indexBytes.byteLength, true);
out.set(indexBytes, 4);
let pos = 4 + indexBytes.byteLength;
for (const b of blobs) {
	out.set(b, pos);
	pos += b.byteLength;
}
writeFileSync(OUT, out);
console.log(
	`\n✅ ${OUT}\n   ${index.count} hospitals, ${cells.size} cells, ${(out.byteLength / 1e6).toFixed(1)} MB`,
);
console.log(
	"\nUpload:  npx wrangler r2 object put offline-tiles/hospitals-world.v1.pack --file hospitals-world.v1.pack --remote",
);
