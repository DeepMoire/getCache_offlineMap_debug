<script lang="ts">
/**
 * /offline — the URL; the page is ../../lib/OfflineMapPage.svelte.
 *
 * A route file is just a mount — keep the logic in the component; two copies of the wiring drift the first time either is touched.
 *
 * Dev chrome (tier pill, debug toggle, instrument rails) lives in `$rig/…` — rapper's shared tree, imported in place by both tiers — and renders only in `vite dev`, never a build.
 *
 * ⚠️ CORRECTED 28 Aug 2026 — ReTreever no longer has /offline (a2980549d deleted its map route trees) and RAPPER is the only tier that mounts this page now, but the components live in rapper/rig/ (since 29 Aug 2026; nothing is synced) — owning the shared tree and mounting a child are separate things.
 */
import OfflineMapPage from "../../lib/OfflineMapPage.svelte";
import EphemeralCard from "$rig/dev/EphemeralCard.svelte";
import ParentGuardLight from "../../lib/dev/ParentGuardLight.svelte";
import EphemeralDock from "$rig/dev/EphemeralDock.svelte";

let debugHost = $state<HTMLElement>();
let railLeftHost = $state<HTMLElement>();
let railRightHost = $state<HTMLElement>();
</script>

<OfflineMapPage {debugHost} {railLeftHost} {railRightHost} />
<EphemeralDock side="left" bind:host={railLeftHost}>
	<EphemeralCard title="offline map" bind:host={debugHost}><ParentGuardLight /></EphemeralCard>
</EphemeralDock>
<EphemeralDock side="right" bind:host={railRightHost} />
