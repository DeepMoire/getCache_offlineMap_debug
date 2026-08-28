<script lang="ts">
/**
 * /offline — the URL. The page is ../../lib/OfflineMapPage.svelte.
 *
 * A route file is a mount, nothing more: SvelteKit needs a file under routes/
 * to answer a URL, and the engine is a component every tier imports. Keep the
 * logic in the component; two copies of the wiring drift the first time
 * either is touched.
 *
 * DEV CHROME GOES TO THE SAME SURFACES ON EVERY TIER. The tier pill and the
 * `debug` toggle go in the shared EphemeralCard; the two instrument rails go
 * in an EphemeralDock each. Both live in `$parent/retreeved/…` — ReTreever
 * owns them, syncRetreeved.sh carries them here — and both render only in
 * `vite dev`, so nothing here reaches a build. ReTreever's /offline mounts
 * exactly this, plus `framed={false}` because it already has a phone.
 */
import OfflineMapPage from "../../lib/OfflineMapPage.svelte";
import EphemeralCard from "$parent/retreeved/sharedComponents/effemeralCard/EphemeralCard.svelte";
import EphemeralDock from "$parent/retreeved/sharedComponents/effemeralCard/EphemeralDock.svelte";

let debugHost = $state<HTMLElement>();
let railLeftHost = $state<HTMLElement>();
let railRightHost = $state<HTMLElement>();
</script>

<OfflineMapPage {debugHost} {railLeftHost} {railRightHost} />
<EphemeralCard title="offline map" bind:host={debugHost} />
<EphemeralDock side="left" top="150px" bind:host={railLeftHost} />
<EphemeralDock side="right" bind:host={railRightHost} />
