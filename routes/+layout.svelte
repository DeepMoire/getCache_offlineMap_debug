<script lang="ts">
import { page } from "$app/state";

import logoUrl from "$parent/retreeved/sharedAssets/GC_fly_logo_transparent.webp";
import ghIconUrl from "$parent/retreeved/sharedAssets/github-logo.png";
import SharedNav from "$parent/retreeved/sharedComponents/sharedNav/SharedNav.svelte";
import type { TierRoute } from "$parent/retreeved/sharedComponents/sharedNav/tierRoutes";
import backdropUrl from "$parent/retreeved/sharedAssets/getcache_DT_bg.webp";
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

// use import.meta.env, never a bare defined global — an absent key reads undefined instead of throwing.
const ENV = import.meta.env as Record<string, string | undefined>;

// NO fallback name — hardcoding a parent here is exactly what noParentNames.test.ts forbids; undefined is correct with no parent.
const THIS_TIER = ENV.VITE_RAPPER_TIER ?? "";
const OTHER_TIER = ENV.VITE_OTHER_TIER ?? "";
const OTHER_ORIGIN = ENV.VITE_OTHER_ORIGIN;
const OTHER_HOME = ENV.VITE_OTHER_HOME;

/** malformed table = a typo; a dev tool must never white-screen the app it exists to help you look at. */
function readRoutes(raw: string | undefined): TierRoute[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
const TIER_ROUTES = readRoutes(ENV.VITE_TIER_ROUTES);
const THIS_SLOT = (ENV.VITE_TIER_SLOT ?? "right") as "left" | "right";

const CHILD = {
	name: "offlineMap",
	owner: "Get Cache",
	// Casing matters — this becomes a GitHub URL; must match the repo/folder exactly or the link 404s.
	repo: "getCache_OfflineMap",
};

const GH_ICON = ghIconUrl;

// always mounted, never "found" — a path outside its views is a 404, not a different child.
const child = CHILD;

// Do not reintroduce a local runtime toggle for decor — hitching is import resolution, settled at build time, not a runtime fact.

let { children } = $props();
</script>

<svelte:head>
	<title>{`${CHILD.owner} — ${CHILD.name}`}</title>
	<link rel="icon" href={logoUrl} />
	{#if dev}
		<!-- ⛔ not a <style> tag — Svelte doesn't interpolate inside <style>, so "{backdropUrl}" would ship literally and 404; use svelte:element instead. -->
		<svelte:element
			this={"style"}
			>{`:root { --host-decor: 1; --demo-backdrop: url("${backdropUrl}"); --demo-bezel: none; --ephemeral-top: 72px; }`}</svelte:element
		>
	{/if}
</svelte:head>

{#if dev}
	<SharedNav
		owner={CHILD.owner}
		name={CHILD.name}
		logo={logoUrl}
		repo={CHILD.repo}
		views={[]}
		ghIcon={GH_ICON}
		pathname={page.url.pathname}
		search={page.url.search}
		tier={THIS_TIER}
		otherTier={OTHER_TIER}
		tierSlot={THIS_SLOT}
		otherHost={OTHER_ORIGIN}
		otherHome={OTHER_HOME}
		routes={TIER_ROUTES}
		selfRepo={THIS_TIER || undefined}
	/>
{/if}

<main>
	{@render children()}
</main>

<style>
	/* must stay a real, positioned, SIZED box — the child inside uses position: absolute; inset: 0 and needs an ancestor to fill. */
	:global(body) {
		margin: 0;
		height: 100dvh;
		overflow: hidden;
		/* body IS the flex column — don't add a wrapper div, it'd be a redundant box in the height chain. */
		display: flex;
		flex-direction: column;
	}
	main {
		flex: 1;
		min-height: 0;
		position: relative;
		overflow: hidden;
	}
</style>
