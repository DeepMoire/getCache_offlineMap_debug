<script lang="ts">
import TierShell from "$parent/retreeved/sharedComponents/TierShell.svelte";
import logoUrl from "$parent/retreeved/sharedAssets/GC_fly_logo_transparent.webp";
import { configureTilesHost, configureTilesDevHost } from "../lib/r2Worker/local_dev/tilesHost";

const dev = import.meta.env.DEV;

const envTilesHost = import.meta.env.VITE_TILES_HOST;
if (typeof envTilesHost === "string" && envTilesHost.trim() !== "") {
	configureTilesHost(envTilesHost);
} else if (dev) {
	// ⛔ console.warn, not .info — must name the file to edit, or a silently repeating failure costs a day (MEASURED 27 Aug 2026).
	console.warn(
		"[tiles] ⛔ VITE_TILES_HOST is not set — NOTHING will download " +
			"(no /pack request is sent at all; the satellite layer still draws, " +
			"so this looks like 'roads are broken'). Put it in the .env beside " +
			"vite's root — the wrapper folder, not the project root:\n" +
			// ⛔ placeholder only, not our hostname — noParentNames.test.ts forbids a real origin here.
			"    VITE_TILES_HOST=https://<your-tiles-worker>",
	);
}

// ⛔ must call configureTilesDevHost here or the r2_dev toggle stays permanently grey — no other caller does it for rapper.
const envTilesDevHost = import.meta.env.VITE_TILES_DEV_HOST;
if (typeof envTilesDevHost === "string" && envTilesDevHost.trim() !== "") {
	configureTilesDevHost(envTilesDevHost);
}

const CHILD = {
	name: "offlineMap",
	owner: "Get Cache",
	// Casing matters — this becomes a GitHub URL; must match the repo/folder exactly or the link 404s.
	repo: "getCache_OfflineMap",
};

let { children } = $props();
</script>

<TierShell child={CHILD} logo={logoUrl}>
	{@render children()}
</TierShell>
