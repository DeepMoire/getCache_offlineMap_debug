<script lang="ts">
import Layout from "$rig/Layout.svelte";
import PhoneRig from "$gc/PhoneRig.svelte";
import logoUrl from "$gc/assets/GC_fly_logo_transparent.webp";
import { configureTilesFromEnv } from "../lib/r2Worker/local_dev/tilesFromEnv";

configureTilesFromEnv();

const CHILD = {
	name: "offlineMap",
	owner: "Get Cache",
	// Casing matters — this becomes a GitHub URL; must match the repo/folder exactly or the link 404s.
	repo: "getCache_OfflineMap",
};

let { children } = $props();
</script>

<Layout child={CHILD} logo={logoUrl}>
	<PhoneRig>{@render children()}</PhoneRig>
</Layout>
