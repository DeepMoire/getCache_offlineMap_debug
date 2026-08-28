<script lang="ts">
/**
 * THE RAPPER SHELL — and it now lives INSIDE the child it wraps.
 *
 * It moved here on 24 Aug 2026. rapper's own `src/routes/` is deleted: this
 * child already carried a `routes/` so it could be lifted into its own repo
 * whole, so `svelte.config.js` points `kit.files.routes` straight at it. One
 * child, one route tree, and no forwarding pages that can drift out of sync
 * with what they forward to.
 *
 * The shell is still RAPPER's, not the child's, in everything but location —
 * see "WHY RAPPER OWNS THE BRANDING" below. When rapper leaves ReTreever and
 * children are published to npm, this file is what an installer overwrites.
 *
 * This is not a site. It does not deploy, has no privacy page, no auth. It is
 * a bare SvelteKit project whose only job is to hold ONE child so it can be run
 * and debugged:
 *
 *   [logo]   OWNER — child   [view] [view]      [gh] rapper  [gh] child   [flag]
 *
 * ONE CHILD, NOT A MENU. This used to be a registry of every child with links
 * between them — correct when the harness carried all of them at once, wrong
 * now. A rapper install contains exactly one child, chosen at install time, so
 * there is nothing to switch BETWEEN. The installer writes CHILD below; a
 * second child means a second install, in a second folder.
 *
 * WHY RAPPER OWNS THE BRANDING. A child never knows whose it is. A child that
 * imported a logo would carry its owner's identity into a repo meant to be
 * handed to a contractor. CHILD is the only place that mapping lives.
 *
 * WHY THE WHOLE BAR IS DEV-ONLY. `import.meta.env.DEV` is a compile-time
 * constant, so `{#if dev}` is never emitted into a production build.
 */
import { page } from "$app/state";

/**
 * BRANDING ART — IMPORTED AT BUILD TIME, FROM THE SHARED FOLDER.
 *
 * These three were leading-slash URLs ("/mobileAssets/..."), which the BROWSER
 * resolves against whatever server answered. That found the files under a host
 * whose static folder happens to hold them and 404'd under every other one — a
 * shell with holes where its logo and its backdrop should be. An import is
 * resolved by the bundler at BUILD time, so the bytes are copied into whatever
 * app builds this, and the shell brings its own artwork wherever it is run.
 * That reasoning is unchanged and is why these are imports, not URLs.
 *
 * WHAT CHANGED IS WHERE THE BYTES LIVE. They were copies inside this child, at
 * lib/assets/mobileAssets/, and that copy was measurably NOT SAFE: fetch's
 * .gitignore carries `*.png` for pasted chat screenshots, so github-logo.png
 * was never committed and this import resolved to a file that does not exist
 * in the repo. It built on the machine that made it and nowhere else — the
 * same failure as the leading-slash URLs, one layer down.
 *
 * `$parent/retreeved/sharedAssets` is the seam each parent fills for itself, exactly like
 * `$parent/retreeved/app.css`: ReTreever points it at retreeved/assets/ and rapper at its
 * synced copy of the same folder. One file per mark, replaced atomically on
 * every dev start, instead of the same .webp drifting in three places. The
 * child names no parent, so noParentNames.test.ts still passes.
 *
 * This keeps the branding OUT of the child, which is what
 * CONTRIBUTING.md asks for: "Branding is RAPPER's job, never the child's."
 * CHILD below is still the one and only place that says whose logo this is.
 */
import logoUrl from "$parent/retreeved/sharedAssets/GC_fly_logo_transparent.webp";
import ghIconUrl from "$parent/retreeved/sharedAssets/github-logo.png";
import SharedNav from "$parent/retreeved/sharedComponents/sharedNav/SharedNav.svelte";
import type { TierRoute } from "$parent/retreeved/sharedComponents/sharedNav/tierRoutes";
import backdropUrl from "$parent/retreeved/sharedAssets/getcache_DT_bg.webp";
import { configureTilesHost, configureTilesDevHost } from "../lib/r2Worker/local_dev/tilesHost";

const dev = import.meta.env.DEV;

/**
 * WHERE THE TILES COME FROM WHEN THIS CHILD IS RUN ON ITS OWN.
 *
 * tilesHost.ts ships NO production origin: packUrl() and firesUrl() answer null
 * until an app configures one, so a stranger installing this package cannot
 * fetch from the maintainer's bucket by accident. Something has to answer, and
 * under a plain wrapper THIS shell is the only thing that runs.
 *
 * ⛔ WHY HERE AND NOT IN THE WRAPPER. It was in the wrapper first, and that was
 * wrong: a wrapper mounts exactly ONE child, so a boot file there importing
 * THIS child by name fails to resolve for every other child. MEASURED 27 Aug
 * 2026 — three of four children stopped building with "Could not load
 * .../getCache_OfflineMap/lib/r2Worker/local_dev/tilesHost (imported by
 * src/hooks.client.ts)". A wrapper must name no child; a child may configure
 * itself.
 *
 * ⛔ NO DEFAULT, AND NO NAME. An unset variable leaves the map unconfigured —
 * tile fetches then fail with a message naming configureTilesHost, which is the
 * honest outcome for someone who has not said whose Worker to use. Naming a
 * real origin here would just move the leak from one file to another.
 *
 *     VITE_TILES_HOST=https://tiles.example.org npm run dev
 *
 * A host that embeds this child in its own app configures it at ITS boot and
 * never reaches this shell, so the two cannot fight.
 */
const envTilesHost = import.meta.env.VITE_TILES_HOST;
if (typeof envTilesHost === "string" && envTilesHost.trim() !== "") {
	configureTilesHost(envTilesHost);
} else if (dev) {
	// ⛔ console.warn, NOT .info, AND IT NAMES THE FILE TO EDIT. MEASURED
	// 27 Aug 2026: this printed twelve identical times during one boot while a
	// correct .env sat one directory above vite's root. As an .info it was
	// filtered out of the default console view, and it never said WHERE the
	// file belongs — so "no blobs" cost a day. A log that repeats identically
	// is a bug in the log; this one now says what to do about it.
	console.warn(
		"[tiles] ⛔ VITE_TILES_HOST is not set — NOTHING will download " +
			"(no /pack request is sent at all; the satellite layer still draws, " +
			"so this looks like 'roads are broken'). Put it in the .env beside " +
			"vite's root — the wrapper folder, not the project root:\n" +
			// ⛔ A PLACEHOLDER, NOT OUR HOSTNAME. noParentNames.test.ts fails on a
			// real one: this child ships on its own and must name no parent and no
			// origin of ours, or a stranger's install points at our bill.
			"    VITE_TILES_HOST=https://<your-tiles-worker>",
	);
}

/**
 * THE r2_dev TIER — CONFIGURED HERE FOR THE SAME REASON production IS.
 *
 * ⛔ WITHOUT THIS THE r2_dev TOGGLE CAN NEVER BE ANYTHING BUT GREY. probeTarget
 * asks hostFor("r2Dev"), which returns configuredDevHost, which stays null
 * until somebody calls configureTilesDevHost. Nobody did — MEASURED 27 Aug
 * 2026: the only caller in the whole workspace was ReTreever's
 * src/hooks.client.ts:45. So under ReTreever the switch worked and under rapper
 * the row greyed itself out permanently, and the CONFIG panel's own hint
 * ("a DEPLOYED sandbox worker") described something the user could never reach.
 *
 * A dead control is worse than an absent one: it says "this exists and is
 * broken" when the truth was "nobody told me where it lives".
 *
 * Same injection rule as production — no origin is baked in, so a stranger
 * still cannot reach our sandbox by accident. Unset simply leaves the row grey,
 * which is then TRUE rather than an artefact.
 */
const envTilesDevHost = import.meta.env.VITE_TILES_DEV_HOST;
if (typeof envTilesDevHost === "string" && envTilesDevHost.trim() !== "") {
	configureTilesDevHost(envTilesDevHost);
}

/**
 * THE PARENT FACTS — INJECTED BY WHOEVER MOUNTED THIS CHILD.
 *
 * Ported from the who_what child, which had them and this one did not — which
 * is precisely why no tier pill rendered here (MEASURED 27 Aug 2026: the bar
 * on /offline showed the flag toggle and no switcher at all).
 *
 * `import.meta.env`, never a bare `define`d global: an absent key reads as
 * undefined instead of throwing, so a child cloned with no parent degrades to
 * "no pill" rather than a ReferenceError. Both other shapes were measured
 * failing on 25 Aug 2026 — see the same block in ReTreever_who_what.
 */
const ENV = import.meta.env as Record<string, string | undefined>;

// NO FALLBACK NAME. A literal here would be this child naming one of its two
// possible parents — the exact thing noParentNames.test.ts forbids, and it
// caught this line the moment it was ported in from the other child. Undefined
// in a solo clone is the honest answer: there is no mounting tier to name.
/**
 * Empty when no second tier is injected — an npm install, where rapper has no
 * sibling parent. Passed to SharedNav as `undefined` rather than "", so the
 * component's own default (its repo name) applies: the self-link points at a
 * repo that exists either way and must not go dark with the tier facts.
 */
const THIS_TIER = ENV.VITE_RAPPER_TIER ?? "";
const OTHER_TIER = ENV.VITE_OTHER_TIER ?? "";
const OTHER_ORIGIN = ENV.VITE_OTHER_ORIGIN;
const OTHER_HOME = ENV.VITE_OTHER_HOME;

/** Malformed table = a typo in a dev tool; a dev tool must never white-screen
 *  the app it exists to help you look at. */
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

/**
 * THE MOUNTED CHILD — name and repo only.
 *
 * `views` and the 200 lines of hand-copied <header> that consumed them are
 * DELETED, replaced by SharedNav — the same component the who_what child
 * mounts. The copy had already drifted: its own markup, its own styles, its
 * own GH constant, and no tier pill at all, because the pill was added to
 * SharedNav and this file could not receive it.
 *
 * SharedNav resolves the per-view name, repo and GitHub url from
 * childRegistry.ts by PATHNAME, so these two fields are only the solo-clone
 * fallback for a checkout with no registry entry reachable.
 */
const CHILD = {
	name: "offlineMap",
	owner: "Get Cache",
	// Casing matters — this becomes a GitHub URL. It read "offlineMap"
	// (lowercase o) while the repo and the folder are both "OfflineMap",
	// so the link 404'd.
	repo: "getCache_OfflineMap",
};

const GH_ICON = ghIconUrl;

// The child is whatever this rapper was installed with — always mounted,
// never "found". A path outside its views is a 404, not a different child.
const child = CHILD;

/**
 * THE DECOR — rapper lends the child its full-dress backdrop and hand.
 *
 * A child is a trailer. Hitched to a parent it gets the artwork; standing
 * alone it must still RUN, plainer. rapper is the SURROGATE PARENT, so it
 * supplies the decor itself — a surrogate stands in, or it is not one.
 *
 * THIS USED TO BE A RUNTIME TOGGLE (`hitched`), driving a pill in the corner
 * that looked identical to the nav's tier switcher. It was deleted 28 Aug 2026
 * because it could not do what it claimed: hitching is IMPORT RESOLUTION,
 * settled at BUILD time, so by the time a button exists the imports either
 * compiled or they did not. A runtime switch for a build-time fact is a
 * costume. The honest control is the tier switcher, which changes SERVER —
 * `getcache.localhost:5173` really is ReTreever, `localhost:5174` really is
 * rapper. Do not reintroduce a local toggle here.
 */

let { children } = $props();
</script>

<svelte:head>
	<!-- IDENTITY FOLLOWS THE CHILD. rapper is a surrogate parent: it has no
	     brand of its own, so the tab shows whichever product the mounted child
	     belongs to. This used to be the harness's favicon in app.html, which put a
	     harness mark on a Get Cache page. -->
	<title>{`${CHILD.owner} — ${CHILD.name}`}</title>
	<link rel="icon" href={logoUrl} />
	{#if dev}
		<!-- FEATURE FLAG ON — HITCHED. rapper stands in for the parent and
		     lends the child its full-dress version: the child reads --host-decor
		     and puts back its backdrop and hand, and the artwork then provides
		     the phone's edge, so the plain gold bezel steps aside.

		     Gated on `dev` alone now. It was `dev && featureOn`, where
		     featureOn was a corner toggle — deleted, see above. The assets
		     here are RAPPER's own —
		     imported at the top of this file, not fetched from ReTreever — and a
		     surrogate supplies its own, or it is not a surrogate. -->
		<!-- WHY THE URL IS INTERPOLATED AND NOT WRITTEN OUT.
		     A <style> in <svelte:head> is not a component <style>: Svelte hands
		     its text to the head at runtime, so Vite's CSS pipeline never walks
		     it, and a url("…") written literally here is NOT rewritten to a built
		     asset — it stays a raw path for the browser to resolve, which is the
		     very hole being closed. So the import above supplies the built URL
		     and it is spliced into the declaration as text. Same shape as every
		     other value here: the shell states a custom property, the child reads
		     it and never learns a path.

		     The alternative — setting the property from JS on mount — was not
		     taken. It would be the only decor value in this file that arrives
		     after paint, and it would land AFTER the child has read --host-decor
		     in its own onMount, so the backdrop could show up a frame late or
		     not at all. Declared markup keeps all three applied together. -->
		<!-- ⛔ NOT A <style> TAG. MEASURED 27 Aug 2026: the version above this
		     one was
		         <style>:root { --demo-backdrop: url("{backdropUrl}"); }</style>
		     and the server logged, on every load,
		         [404] GET /offline/%7BbackdropUrl%7D
		     — `%7B...%7D` being `{backdropUrl}` url-encoded. Svelte does NOT
		     interpolate inside a <style> element: its contents are raw CSS
		     text, so the braces reached the browser verbatim and it fetched a
		     file literally named "{backdropUrl}". The backdrop never loaded.

		     The comment that used to sit here argued the value must be
		     interpolated rather than written literally — correct, and it is
		     exactly what a <style> tag cannot do. `svelte:element` with an
		     inline style attribute IS interpolated, keeps the value a built
		     asset URL, and still applies declaratively at paint time, which
		     was the whole reason a JS-on-mount version was rejected. -->
		<svelte:element
			this={"style"}
			>{`:root { --host-decor: 1; --demo-backdrop: url("${backdropUrl}"); --demo-bezel: none; }`}</svelte:element
		>
	{/if}
</svelte:head>

{#if dev}
	<!-- THE SHARED BAR, not a copy of it.
	     This file used to carry its own 40-line <header> plus ~90 lines of
	     matching CSS — a second implementation of SharedNav that drifted the
	     moment it existed. It had no tier pill at all, because the pill was
	     added to the shared component and a copy cannot receive an edit.
	     The feature-flag toggle below is genuinely this child's own: it flips
	     the surrogate-parent decor, which no other child has. -->
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
	/* The child's OWN dev shell, standalone (port 5174 / this checkout's
	   `npm run dev`). It has to be a real, positioned, SIZED box because the
	   stage inside it is `position: absolute; inset: 0` — absolute needs a
	   positioned ancestor to resolve against, and `min-height` alone gives it
	   no height to fill. This is the standalone mirror of ReTreever's
	   `.mobile-content`: same job, same shape, so the same child rule is
	   correct in both tiers.
	   `--host-chrome` is gone from here — the bar above is a real element in
	   the flow, so its height is already subtracted by the flex column rather
	   than guessed at by a hand-copied 67px that silently rotted whenever the
	   real navbar changed. */
	:global(body) {
		margin: 0;
		height: 100dvh;
		overflow: hidden;
		/* The dev bar and <main> are direct body children, so BODY is the flex
		   column. No wrapper div: adding one here would be a second box in the
		   height chain for no gain. */
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
