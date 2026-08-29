import * as Sentry from "@sentry/sveltekit";

// Attach at CONSTRUCTION time (onMapCreated), not onMapReady — a style that never finishes loading never fires onMapReady, so it would go unreported.
// Lives on the ReTreever side — open-core rule, no Sentry imports in the harness.
// Dedupe: each distinct URL is captured at most once per session; repeats become breadcrumbs.

const sentKeys = new Set<string>();

// Mapbox's ErrorEvent isn't exported typed; AJAXError adds status + url, source errors add sourceId.
type MapErrorEvent = {
	error?: Error & { status?: number; url?: string };
	sourceId?: string;
};

// The slice of a map this file needs: one error listener.
// Structural, not mapboxgl.Map | maplibregl.Map — that union fails to typecheck (on() is overloaded in both, TS can't reconcile the signatures).
type ErrorEmittingMap = {
	on(type: "error", listener: (e: unknown) => void): unknown;
};

export function attachMapErrorCapture(map: ErrorEmittingMap, page: string): void {
	map.on("error", (e) => {
		const ev = e as MapErrorEvent;
		const err = ev.error;
		// Attaching an "error" listener suppresses mapbox's built-in console.error — re-log so console behavior stays the same.
		console.error(`[${page}] map error:`, err ?? e);
		if (!err) return;
		// Strips the query string — mapbox URLs carry the access token in it, and Sentry doesn't need it.
		const url = (err.url ?? "").split("?")[0];
		// data: URL errors are the offline air-gap (v4TransformRequest) working as designed, not a real failure — skip them.
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
		// Self-authored message, not err.message — the init's ignoreErrors filter deliberately drops literal "Failed to fetch", which would otherwise vanish silently.
		// Fingerprint groups every resource failure on a page into ONE Sentry issue; each event carries its own URL.
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
