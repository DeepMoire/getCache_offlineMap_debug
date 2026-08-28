import * as Sentry from "@sentry/sveltekit";

// Map "error" listener → Sentry. Style / sprite / glyph / tile / source load
// failures (mapbox AJAXError and friends) fire on the map's own `error`
// event, which nothing captured — a style fetch hanging or 4xx-ing in the
// field left ZERO trail (the July-6 lie-fi failure class). Attach at
// CONSTRUCTION time (onMapCreated) so a style that never finishes loading is
// still reported — onMapReady never fires in exactly that case.
//
// Lives on the ReTreever side: open-core rule, no Sentry imports in the harness.
//
// DEDUPE: a dead-signal pan can fail hundreds of resources; each distinct
// URL is captured at most once per session (module-level, shared across map
// pages), later failures become breadcrumbs.

const sentKeys = new Set<string>();

// Mapbox's ErrorEvent isn't exported with these fields typed; AJAXError adds
// status + url, source errors add sourceId.
type MapErrorEvent = {
	error?: Error & { status?: number; url?: string };
	sourceId?: string;
};

/**
 * The slice of a map this file needs: ONE error listener.
 *
 * Structural, not `mapboxgl.Map`, because BOTH renderers are live — the online
 * map is Mapbox, the offline map (/mobile/offlinev4) is MapLibre — and their
 * `Map` classes are nominally distinct even where the API is identical. A
 * `MapboxMap | MaplibreMap` union would NOT work here: TypeScript resolves a
 * call against a union by requiring one signature compatible with every member,
 * and `on` is heavily overloaded in both, so it reports "none of those
 * signatures are compatible with each other". A minimal structural type sidesteps
 * that and documents the real dependency, which is one method.
 */
type ErrorEmittingMap = {
	on(type: "error", listener: (e: unknown) => void): unknown;
};

export function attachMapErrorCapture(map: ErrorEmittingMap, page: string): void {
	map.on("error", (e) => {
		const ev = e as MapErrorEvent;
		const err = ev.error;
		// Attaching ANY "error" listener suppresses mapbox's built-in
		// console.error fallback — re-log so console behaviour stays as-is.
		console.error(`[${page}] map error:`, err ?? e);
		if (!err) return;
		// Query string stripped: mapbox URLs carry the access token, and the
		// path alone identifies the failing resource.
		const url = (err.url ?? "").split("?")[0];
		// The offline map's air-gap (v4TransformRequest) rewrites every
		// blocked remote request to a data: png — any error on a data: URL is
		// LAW 0 working as designed, not a field failure.
		if (url.startsWith("data:")) return;
		const key = url || `${page}:${err.message}`;
		if (sentKeys.has(key)) {
			Sentry.addBreadcrumb({
				category: "mapbox",
				level: "warning",
				message: `[${page}] map resource failed: ${url || err.message}`,
				data: { status: err.status, sourceId: ev.sourceId },
			});
			return;
		}
		sentKeys.add(key);
		// Self-authored message — the raw err.message is often literally
		// "Failed to fetch", which the init's ignoreErrors filter
		// (deliberately) drops; it rides along in `extra` instead. The
		// fingerprint groups every resource failure on a page into ONE
		// Sentry issue, with each event carrying its own failing URL.
		Sentry.captureMessage(
			`[mapbox] resource failed on ${page}: ${url || err.name}`,
			{
				level: "error",
				tags: { area: "mapbox", page },
				fingerprint: ["mapbox-resource-error", page],
				extra: {
					url,
					status: err.status,
					sourceId: ev.sourceId,
					message: err.message,
				},
			},
		);
	});
}
