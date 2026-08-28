/**
 * pinDrift.ts — THE CRUISING-PIN DETECTOR (DEV ONLY)
 *
 * ── THE BUG THIS EXISTS TO CATCH ─────────────────────────────────────────
 *
 * A pin is a fixed point on the earth. Its `lngLat` must NEVER change because
 * the camera moved. Zooming and panning change a pin's PIXEL position every
 * frame; they must not change its COORDINATE. Ever.
 *
 * When that invariant breaks, pins visibly "cruise" across the map as you
 * zoom — sliding over oceans and provinces — which is geographically absurd
 * and is the symptom this file detects.
 *
 * ── WHY A TOOL AND NOT A CONSOLE PASTE ───────────────────────────────────
 *
 * This bug has been fixed-then-regressed more than once, and each round was
 * lost to guessing at screenshots. Screenshots cannot separate the two
 * failure modes below, because a still frame has no time axis:
 *
 *   CRUISING  — the pin's lngLat CHANGES while the camera moves.
 *               Something is rewriting coordinates. The pin is animated.
 *
 *   BORN-WRONG — the pin's lngLat is CONSTANT but in the wrong place
 *               (e.g. a tidy column in the Pacific). Nothing is animating;
 *               the coordinate was already wrong when it arrived.
 *
 * They look similar in a screenshot and have completely different causes, so
 * telling them apart is the whole job. This watches coordinates over TIME,
 * which is the only way to do it.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────
 *
 * Patches `Marker.prototype.setLngLat` on BOTH gl libraries (the offline map
 * is MapLibre, the online map is Mapbox — see rendererOf.ts) and records each
 * write together with the camera state at that instant. A coordinate write
 * that lands while the camera is mid-move, and MOVES the pin, is the smoking
 * gun.
 *
 * Never auto-runs. DEV-only, opt-in via window.__pinDrift.start().
 */

type Sample = {
	t: number;
	lng: number;
	lat: number;
	/** Camera zoom at the moment of the write. */
	z: number;
	/** True when the map was mid-zoom/mid-pan as this write happened. */
	moving: boolean;
};

type Track = {
	label: string;
	samples: Sample[];
	/** Greatest distance (metres) between any two coords this pin was given. */
	spreadM: number;
	/** Of those moves, how many happened while the camera was moving. */
	movesWhileCameraMoving: number;
};

const tracks = new Map<HTMLElement | object, Track>();
let installed = false;
let recording = false;
let getCamera: (() => { z: number; moving: boolean }) | null = null;

/** Metres between two lng/lat pairs (haversine, earth = 6371 km). */
function metres(a: [number, number], b: [number, number]): number {
	const R = 6371000;
	const rad = Math.PI / 180;
	const dLat = (b[1] - a[1]) * rad;
	const dLng = (b[0] - a[0]) * rad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function labelOf(marker: { getElement?: () => HTMLElement }): string {
	try {
		const el = marker.getElement?.();
		if (!el) return "?";
		const cls = (el.className || "").toString().split(" ")[0] || "marker";
		const txt = (el.textContent || "").trim().slice(0, 10);
		return txt ? `${cls}:${txt}` : cls;
	} catch {
		return "?";
	}
}

function record(marker: object, lng: number, lat: number): void {
	if (!recording) return;
	const cam = getCamera?.() ?? { z: NaN, moving: false };
	let tr = tracks.get(marker);
	if (!tr) {
		tr = {
			label: labelOf(marker as { getElement?: () => HTMLElement }),
			samples: [],
			spreadM: 0,
			movesWhileCameraMoving: 0,
		};
		tracks.set(marker, tr);
	}
	const prev = tr.samples[tr.samples.length - 1];
	if (prev) {
		const d = metres([prev.lng, prev.lat], [lng, lat]);
		// A move of under a metre is float noise, not a cruise.
		if (d > 1) {
			tr.spreadM = Math.max(tr.spreadM, d);
			if (cam.moving) tr.movesWhileCameraMoving++;
		}
	}
	tr.samples.push({ t: Math.round(performance.now()), lng, lat, z: cam.z, moving: cam.moving });
}

/**
 * Patch both libraries' Marker.setLngLat. Idempotent.
 *
 * Patching the PROTOTYPE (rather than wrapping call sites) is deliberate: it
 * catches every writer, including ones we haven't thought of and any inside
 * the gl libraries themselves. A call-site wrapper would only see the writers
 * we already suspect — which is precisely the assumption that lost the last
 * few rounds of this bug.
 */
async function install(): Promise<void> {
	if (installed) return;
	installed = true;
	const libs = await Promise.all([
		import("mapbox-gl").then((m) => m.default).catch(() => null),
		import("maplibre-gl").then((m) => m.default).catch(() => null),
	]);
	for (const lib of libs) {
		const proto = (lib as unknown as { Marker?: { prototype?: Record<string, unknown> } })
			?.Marker?.prototype;
		if (!proto || typeof proto.setLngLat !== "function") continue;
		const original = proto.setLngLat as (p: unknown) => unknown;
		proto.setLngLat = function patched(this: object, p: unknown) {
			try {
				const c = p as { lng?: number; lat?: number } & [number, number];
				const lng = Array.isArray(c) ? c[0] : c?.lng;
				const lat = Array.isArray(c) ? c[1] : c?.lat;
				if (Number.isFinite(lng) && Number.isFinite(lat)) {
					record(this, lng as number, lat as number);
				}
			} catch {
				/* never let instrumentation break the map */
			}
			return original.call(this, p);
		} as typeof proto.setLngLat;
	}
}

export type DriftReport = {
	verdict: string;
	cruising: Array<{ label: string; movedM: number; writesWhileMoving: number }>;
	stationary: number;
	totalTracked: number;
};

/** Analyse what was recorded and say plainly which bug this is. */
function report(): DriftReport {
	const cruising: DriftReport["cruising"] = [];
	let stationary = 0;
	for (const tr of tracks.values()) {
		if (tr.spreadM > 1) {
			cruising.push({
				label: tr.label,
				movedM: Math.round(tr.spreadM),
				writesWhileMoving: tr.movesWhileCameraMoving,
			});
		} else {
			stationary++;
		}
	}
	cruising.sort((a, b) => b.movedM - a.movedM);
	const anyDuringMove = cruising.some((c) => c.writesWhileMoving > 0);
	// NO DATA IS NOT A PASS. If nothing was recorded the detector never saw a
	// pin — reporting "CLEAN" there would be a false all-clear, the single most
	// misleading thing this tool could say.
	const verdict = tracks.size === 0
		? `NO DATA — zero pin coordinate writes were seen. The detector did not ` +
			`observe anything, so this is NOT an all-clear. Either recording wasn't ` +
			`started before the pins rendered, or this map has no pins. Run ` +
			`__pinDrift.start() then RELOAD or pan so pins re-render, then zoom.`
		: cruising.length === 0
		? `CLEAN — ${stationary} pins tracked, none changed coordinates. ` +
			`Pins are NOT cruising. If they look wrong on screen, they were BORN wrong ` +
			`(bad data upstream), not moved by the camera.`
		: anyDuringMove
			? `CRUISING CONFIRMED — ${cruising.length} pin(s) had their coordinates ` +
				`REWRITTEN while the camera was moving. This is the bug: something ` +
				`recomputes pin coords from the camera. Worst: ${cruising[0].movedM} m.`
			: `MOVED, BUT NOT BY THE CAMERA — ${cruising.length} pin(s) changed coords, ` +
				`but never during a camera move. Likely a legitimate data edit or a ` +
				`re-seed, not a projection bug.`;
	return { verdict, cruising: cruising.slice(0, 20), stationary, totalTracked: tracks.size };
}

/**
 * Wire up the detector. Call from a map route in DEV.
 * Exposes window.__pinDrift with start/stop/report.
 */
export function installPinDrift(map: {
	getZoom: () => number;
	isMoving?: () => boolean;
	isZooming?: () => boolean;
}): void {
	if (!import.meta.env.DEV) return;
	getCamera = () => {
		let z = NaN;
		try {
			z = map.getZoom();
		} catch {
			/* degenerate camera — see the NaN-camera guard in pinMarkers.sync */
		}
		const moving = Boolean(map.isMoving?.() || map.isZooming?.());
		return { z, moving };
	};
	void install();
	const api = {
		async start() {
			await install();
			tracks.clear();
			recording = true;
			console.log(
				"%c[pinDrift] RECORDING — now zoom the map in and out a few times, " +
					"then run __pinDrift.report()",
				"color:#d4a017;font-weight:bold",
			);
		},
		stop() {
			recording = false;
			return api.report();
		},
		report() {
			const r = report();
			console.log(`%c[pinDrift] ${r.verdict}`, "color:#d4a017;font-weight:bold");
			if (r.cruising.length) console.table(r.cruising);
			return r;
		},
		/** Raw samples for one pin, if you want to eyeball the trail. */
		trail(labelStartsWith = "") {
			for (const tr of tracks.values()) {
				if (tr.label.startsWith(labelStartsWith)) return tr.samples;
			}
			return [];
		},
	};
	(window as unknown as { __pinDrift: typeof api }).__pinDrift = api;
}
