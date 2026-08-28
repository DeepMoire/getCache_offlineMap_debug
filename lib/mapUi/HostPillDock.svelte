<script lang="ts">
/**
 * ParentPill (ReTreever's mount) — THE PILL ITSELF IS NOT HERE.
 *
 * The component lives at the parent's retreeved/sharedComponents/ParentPill/ParentPill.svelte, one file above
 * both repos, and rapper renders the SAME file. This is only the wrapper that
 * supplies ReTreever's half of the facts and positions it.
 *
 * WHY. There used to be two full copies of the pill — this one and one inside
 * the child — and they drifted the moment they existed: padding 0.35/0.8 vs
 * 0.25/0.7, font-size 0.75 vs 0.8rem, and for a while the two halves rendered
 * in opposite orders, so the control moved under the cursor when you switched
 * servers. Every fix had to be made twice, and "make them the same" kept
 * meaning "copy the newer one over again". A copy cannot be held identical by
 * discipline, so there is now exactly one.
 *
 * WHAT STAYS HERE, AND WHY IT CANNOT MOVE
 *   - the two dev origins and the route translation: facts about THIS tier
 *   - the portal to <body> and `position: fixed`: see below
 * The shared component knows none of it and is told all of it, which is what
 * lets the same file serve a tier that has never heard of ReTreever.
 *
 * WHY IT PORTALS ITSELF TO <body> — the one thing to not "simplify".
 *
 * This is a DEVELOPER control. It answers "which tier is feeding this page",
 * a question about the whole build, so it belongs to the DESKTOP PAGE, not to
 * the simulated phone. It used to render inside the phone frame on /map — a
 * button sitting on top of the map art, looking like app UI.
 *
 * `position: fixed` alone cannot fix that. `.mobile-preview-frame` (app.css)
 * declares `contain: layout` AND `container-type: inline-size`, and either one
 * makes it a containing block for fixed descendants. So a fixed child of the
 * frame resolves against the FRAME, not the viewport — deliberately, since
 * TrackingIndicator and SandboxIndicator rely on exactly that to line up with
 * the phone edges. The pill wants the opposite, and no CSS expresses "escape
 * my containing block".
 *
 * The only escape is to not be a descendant. This appends the node to <body>
 * on mount, so it is a sibling of the frame and its `fixed` finally means the
 * viewport. Do not delete the portal effect and "just use position: fixed" —
 * that is the bug, and it looks fixed until you open a page that renders the
 * phone frame.
 */
/**
 * DYNAMIC, so the pill's CSS cannot reach a production bundle.
 *
 * `{#if dev}` below removes the MARKUP, and that is not the same as removing
 * the component: Svelte emits a component's style block whenever imported,
 * so a top-level import shipped four `.host-pill` rules into the client bundle
 * of a real `vite build` — MEASURED 27 Aug 2026. The gate was inside the
 * component; the only thing that removes it entirely is not importing it.
 *
 * `import.meta.env.DEV` is compile-time, so this branch is unreachable in a
 * production build and Vite drops the whole module — markup and stylesheet.
 *
 * The pill claims "this same page is running on the other tier". That is only
 * true on a machine running both dev servers; on Vercel there is no rapper to
 * jump to, so the control would be a link to nowhere.
 */
let ParentPill = $state<any>(null);
if (import.meta.env.DEV) {
	import("$parent/retreeved/sharedComponents/ParentPill/ParentPill.svelte").then(
		(m) => {
			ParentPill = m.default;
		},
	);
}
/**
 * THE ROUTE TRANSLATION — shared with the SharedNav dev bar, not copied.
 *
 * This file used to hold its own `RAPPER_MOUNTS` object doing exactly what
 * `otherTierPath` does, against a table that was a second copy of the one the
 * search page passes to SharedNav. Two tables, one fact: when the search
 * page's pill was fixed to follow the live URL, these five map pages silently
 * kept the old behaviour, because the fix went to the other copy.
 */
import {
	otherTierPath,
	probeOtherSide,
	servesOtherSide,
	type OtherSideStatus,
} from "$parent/retreeved/sharedComponents/sharedNav/tierRoutes";
// The host's tier route table now comes in as ports.tier through mapHostPorts
// (28 Aug 2026). OPTIONAL: a host with no tier table renders no dock at all.
import type { MapHostPorts } from "../shared/mapHostPorts";

let { ports }: { ports: MapHostPorts } = $props();
const RETREEVER_LANDING = ports.tier?.landing ?? "/";
const RETREEVER_TIER_ROUTES = ports.tier?.routes ?? [];

/**
 * The two parents, by ORIGIN. Only the host changes — the path is translated
 * below, so the pill lands you on the same page under the other parent rather
 * than dumping you at a home page you did not ask for.
 *
 * ReTreever uses a named host (retreever.localhost) because its hooks branch
 * on hostname to pick a site; rapper serves one child and needs no name.
 * Ports come from each repo's `dev` script — 5173 and 5174 — chosen so both
 * can run at the same time, which is the entire mechanism.
 */
/**
 * INSIDE THE DEV BRANCH, so the strings themselves cannot ship.
 *
 * These were plain top-level consts. The markup that used them was gated, but
 * a `const` at module scope is evaluated regardless and survives tree-shaking:
 * MEASURED 27 Aug 2026, both origins sat in the production client bundle
 * (chunks/BAvWnliA.js) of a real `vite build`. A dev-only control that leaves
 * its dev-only addresses in a shipped file has only half vanished — the same
 * failure rapper's `define` block was moved for.
 *
 * `import.meta.env.DEV` is a compile-time constant, so in a production build
 * this whole branch is unreachable and the strings go with it.
 */
// The origins, names and "which one is serving" now come from the HOST through
// ports.tier (28 Aug 2026): this file lives in a child, and a child may not
// name a parent. The host keeps the strings inside its own DEV branch.
const LEFT_ORIGIN = ports.tier?.left.origin ?? "";
const RIGHT_ORIGIN = ports.tier?.right.origin ?? "";


/** The two halves, in FIXED order. rapper passes the same pair, so the
 *  control is identical on both servers and only the highlight moves. */
const LEFT = ports.tier?.left.name ?? "";
const RIGHT = ports.tier?.right.name ?? "";

/**
 * Which parent is serving THIS page — read, not guessed.
 *
 * The port in the address bar IS the answer, and it cannot be wrong: it names
 * the server that actually responded. Nothing here decides anything; it only
 * reports what already happened.
 */
const onRapper = $derived(ports.tier?.onRight ?? false);

/**
 * Same page, other parent.
 *
 * The translation itself is `otherTierPath` against RETREEVER_TIER_ROUTES —
 * the one table this tier has. Nothing about which route maps where is written
 * in this file any more; see tierRouteTable.ts for why the two spellings of a
 * page cannot be derived and must be declared.
 *
 * `search` is carried over verbatim — a query is page state that means the
 * same thing under either parent. Only the PATH needs translating.
 *
 * Guarded for SSR, where `location` does not exist; the href is then just the
 * other parent's root, and hydration corrects it.
 */
const target = $derived.by(() => {
	const base = onRapper ? LEFT_ORIGIN : RIGHT_ORIGIN;
	if (typeof location === "undefined") return base;
	const here = location.pathname.replace(/\/+$/, "") || "/";
	// Leaving rapper: its child mirrors ReTreever's paths one-for-one now, so
	// the same pathname is the answer. RETREEVER_LANDING covers a rapper route
	// ReTreever has no counterpart for.
	if (onRapper) {
		const mirrored = here === "/" ? RETREEVER_LANDING : here;
		return `${base}${mirrored}${location.search}`;
	}
	return base + otherTierPath(here, RETREEVER_TIER_ROUTES) + location.search;
});

/**
 * NOTHING TO SWITCH TO — grey the pill instead of quietly substituting.
 *
 * These map pages are exactly the case: a who_what rapper install serves no
 * /where, /map or /offline, so the pill used to land you on its search page
 * without ever saying it had swapped your destination. Leaving rapper is never
 * unavailable — ReTreever serves every route rapper's child mirrors.
 */
const declaredUnavailable = $derived.by(() => {
	if (onRapper || typeof location === "undefined") return false;
	const here = location.pathname.replace(/\/+$/, "") || "/";
	return !servesOtherSide(here, RETREEVER_TIER_ROUTES);
});

/**
 * WHAT THE RAPPER ON :5174 ACTUALLY ANSWERS — the table cannot know this.
 *
 * A rapper install carries exactly ONE child. The table above describes every
 * route that COULD map across, so it lists /map, /offline and their debug
 * views — but a who_what install answers all four with a 404. MEASURED
 * 27 Aug 2026: the pill was a live link to `:5174/map/debug` on a server that
 * has no such route, which is the "it's just hard-coded" complaint in its
 * final form. The destination was declared rather than checked.
 *
 * So the running server is asked (probeOtherSide). It is the only thing that
 * knows which child it mounted, and asking it cannot drift the way a second
 * hand-maintained table would when somebody swaps the child.
 *
 * Starts UNKNOWN and stays live while the answer is in flight: greying a
 * working link for the few ms of a HEAD request is a worse lie than the one
 * being fixed. Only a definite "missing" greys it out.
 */
let probed = $state<OtherSideStatus>("unknown");

$effect(() => {
	// Re-probed per destination, so swapping rapper's child updates the pill on
	// the next navigation without a ReTreever restart.
	const dest = target;
	if (onRapper || declaredUnavailable) return;
	let live = true;
	probed = "unknown";
	const url = new URL(dest);
	probeOtherSide(url.origin, url.pathname).then((r) => {
		if (live) probed = r;
	});
	return () => {
		live = false;
	};
});

/**
 * Grey when EITHER source says no: the table (this tier declares no
 * counterpart) or the live server (it declares one, but nothing is there).
 * They answer different questions and both can independently be right.
 */
const unavailable = $derived(declaredUnavailable || probed === "missing");

/**
 * DEV ONLY, ENFORCED HERE — not at the five places that mount this.
 *
 * MEASURED 27 Aug 2026: of the five mount sites, THREE had no `{#if dev}` —
 * /offline, /offline/debug and /where/debug. This developer control would have
 * shipped to production on those pages, with a live link to localhost:5174.
 *
 * That is the opt-OUT shape the route groups exist to delete: a rule every new
 * mount must remember, which fails silently when one forgets, and looks fine
 * until it is in front of a user. `import.meta.env.DEV` is a compile-time
 * constant, so the `{#if}` below is not emitted into a production build at all
 * — the markup, the styles and the two localhost origins all vanish from the
 * bundle. A mount site may now be careless and still be correct.
 */
const dev = import.meta.env.DEV;

/**
 * WHICH LAYOUT IS THIS — the phone frame, or a full-width debug page?
 *
 * The (getcache) layout publishes its own decision as a body class, so this is
 * read rather than re-derived; testing the route again here would be a second
 * copy of a rule that already exists and could drift from it.
 *
 * Framed: the top-right corner is empty backdrop, so the pill floats there.
 * Unframed: the rails and both nav bars own every corner, so the pill sits in
 * the navbar's centre gap — the one strip nothing else claims.
 */
let framed = $state(true);
$effect(() => {
	if (typeof document === "undefined") return;
	const read = () => {
		framed = document.body.classList.contains("mobile-app-framed");
	};
	read();
	/**
	 * WATCHED, not read once. The layout sets this class in its own $effect, and
	 * on a full page load that runs AFTER this one — MEASURED 27 Aug 2026:
	 * /offline reported framed=true while the pill still sat at the unframed
	 * coordinates, because the first read happened before the class existed.
	 * Client-side navigation between /offline and /offline/debug flips it again
	 * with no remount, so a single read is wrong twice over.
	 */
	const mo = new MutationObserver(read);
	mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
	return () => mo.disconnect();
});

/** The rendered node, portalled out of the phone frame on mount. */
let pillEl = $state<HTMLElement | null>(null);

$effect(() => {
	const el = pillEl;
	if (!el || typeof document === "undefined") return;
	// Already a direct child of <body> on a route with no frame; re-appending
	// is a no-op there, so this needs no "is it framed?" branch.
	document.body.appendChild(el);
	return () => el.remove();
});
</script>

<!-- The positioning wrapper is ReTreever's, the pill inside it is shared.
     ReTreever has a real navbar of its own, so a dev bar above product chrome
     would be worse than a floating control — it floats, but top-right where
     you look first. rapper has no such navbar and puts the same pill inline in
     its dev bar. -->
{#if dev && ports.tier && ParentPill}
<div
	bind:this={pillEl}
	class="host-pill-dock"
	style={framed
		? "position:fixed;top:50px;right:50px;z-index:2147483000;display:inline-flex"
		: "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;display:inline-flex;pointer-events:none"}
>
	<div style={framed ? "" : "pointer-events:auto"}>
	<ParentPill
		leftLabel={LEFT}
		rightLabel={RIGHT}
		current={onRapper ? RIGHT : LEFT}
		{unavailable}
		href={unavailable ? undefined : target}
	/>
	</div>
</div>
{/if}

<!--
	NO STYLE BLOCK — DELIBERATELY. Read this before adding one back.

	Svelte emits a component's stylesheet whenever the component is imported,
	and five route files import this one unconditionally. `{#if dev}` removes
	the markup, not the stylesheet: MEASURED 27 Aug 2026 on a real `vite build`,
	.svelte-kit/output/client/.../HostPillDock.xAf8Xd83.css shipped four
	.host-pill-dock rules to every page a user loads, for a control that can
	never render there.

	So the positioning moved INLINE, onto the element itself, inside the branch
	that only exists in dev. No stylesheet is emitted, nothing to leak, and the
	rules live exactly where the element does.

	The two layouts are still distinguished — see the frame comment above — by
	reading the body class rather than by a CSS selector.
-->
