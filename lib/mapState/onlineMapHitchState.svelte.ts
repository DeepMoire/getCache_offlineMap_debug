/**
 * onlineMapHitchState.svelte.ts — THE PILL's single source of truth for /map.
 *
 * One shared boolean, read by MobMapPage.svelte (real /map, and /map/debug
 * which mounts the same component) to decide "real mapStore-derived data or
 * nothing". Same pattern as offline's hitchState.svelte.ts.
 *
 * Narrower than offline's: MobMapPage.svelte owns exactly ONE real-data read
 * of its own — hospitalAnchorNow(), via mapStore.allMaps. MapDrawControls
 * (pins, drawn features) reads mapStore directly and is NOT gated by this
 * flag — it has no HostPorts-style injection seam, unhitching it would mean
 * rewriting MapDrawControls, and it behaves identically on /map and
 * /map/debug today. See three_tier_architecture.md, "The DATA pill".
 *
 * PROPRIETARY: lives in ReTreever's src/lib/mobile, not in rapper.
 */
export const onlineMapHitchState = $state({ hitched: true });
