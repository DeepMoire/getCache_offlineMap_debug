// Memoized, lazy installer for the Mapbox NaN prototype guards.
// ⚠️ must be installed before the first `new mapboxgl.Map(...)` — dt-web awaits ensureMapboxGuards() first; hooks.client.ts also fires it (fire-and-forget) at boot for mobile/native screens.
// ⚠️ don't install synchronously at boot again — that forced the whole ~1.8MB mapbox-gl bundle into every route, map-less pages included.
// Guards are idempotent (Symbol.for-gated), so calling this from several map sites in one session is safe.

let installed: Promise<void> | undefined;

export function ensureMapboxGuards(): Promise<void> {
	if (!installed) {
		installed = import("$parent/siblings/getCache_OnlineMap/lib/safeMarker").then(
			({ installMapboxNanGuards }) => installMapboxNanGuards(),
		);
	}
	return installed;
}
