import { configureTilesHost, configureTilesDevHost } from "./tilesHost";

export function configureTilesFromEnv(): void {
	const host = import.meta.env.VITE_TILES_HOST;
	if (typeof host === "string" && host.trim() !== "") {
		configureTilesHost(host);
	} else if (import.meta.env.DEV) {
		// ⛔ console.warn, not .info, and it must name the file to edit — a silent repeat costs a day.
		console.warn(
			"[tiles] ⛔ VITE_TILES_HOST is not set — NOTHING will download " +
				"(no /pack request is sent at all; the satellite layer still draws, " +
				"so this looks like 'roads are broken'). Put it in the .env beside " +
				"vite's root — the wrapper folder, not the project root:\n" +
				// ⛔ placeholder only — noParentNames.test.ts forbids a real origin here.
				"    VITE_TILES_HOST=https://<your-tiles-worker>",
		);
	}

	// ⛔ without this the worker-cloud-dev toggle stays permanently grey — no other caller does it for a bare parent.
	const devHost = import.meta.env.VITE_TILES_DEV_HOST;
	if (typeof devHost === "string" && devHost.trim() !== "") {
		configureTilesDevHost(devHost);
	}
}
