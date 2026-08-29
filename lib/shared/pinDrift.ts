// pinDrift.ts — dev-only detector: a pin's lngLat must NEVER change because the camera moved.
// CRUISING = the pin's lngLat changes while the camera moves (something is rewriting coords).
// BORN-WRONG = the pin's lngLat is constant but wrong from the start (bad data, not animation).
// Never auto-runs — DEV only, opt-in via window.__pinDrift.start().

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

// Patches both libraries' Marker.setLngLat. Idempotent.
// Patches the PROTOTYPE, not call sites — a call-site wrapper only catches writers you already suspect, which is how past rounds of this bug were missed.
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
	// NO DATA IS NOT A PASS — reporting "CLEAN" when nothing was recorded would be a false all-clear.
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

// Wire up the detector from a map route in DEV; exposes window.__pinDrift with start/stop/report.
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
