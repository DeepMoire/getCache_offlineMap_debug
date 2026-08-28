/**
 * THE PILL BELONGS TO THE DESKTOP PAGE, NOT TO THE PHONE.
 *
 * It is a DEVELOPER control that names which TIER is feeding the page —
 * a fact about the whole build. Rendered inside the simulated phone it reads
 * as app UI, sitting on top of the map art.
 *
 * `position: fixed` does not achieve that on its own, and this is the trap:
 * `.mobile-preview-frame` (app.css) sets BOTH `contain: layout` and
 * `container-type: inline-size`, and either one makes it a containing block
 * for fixed descendants. So a fixed child of the frame is fixed *to the
 * frame*. That is deliberate and load-bearing elsewhere — TrackingIndicator
 * and SandboxIndicator rely on it to line up with the phone edges — so it
 * cannot be removed. The pill wants the opposite, and CSS has no way to say
 * "escape my containing block".
 *
 * The only escape is to stop being a descendant: the component appends its
 * own node to <body> on mount. This test fails if that portal is deleted,
 * because deleting it looks harmless — the pill still renders, still in a
 * bottom-right corner, just the WRONG one, and only on routes that draw the
 * phone frame.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TWO FILES NOW, and the split is the point.
 *
 * DOCK — src/lib/core/map/HostPillDock.svelte. ReTreever's mount: the portal out
 * of the phone frame, `position: fixed`, and the tier facts passed as PROPS.
 *
 * SHARED — retreeved/sharedComponents/ParentPill/ParentPill.svelte.
 * The pill
 * itself, rendered by BOTH tiers from one file that ReTreever owns and the sync
 * atomically replaces into rapper. It names no tier: it is told two labels.
 *
 * So the portal assertions below read the WRAPPER, and the tier-name assertion
 * reads where the names actually are — the call site. Reading the wrapper for
 * ">rapper<" failed on 25 Aug 2026 for the right reason: the markup had
 * correctly moved out, and the test was still looking in the old place.
 */
const PILL = readFileSync(
	fileURLToPath(new URL("./HostPillDock.svelte", import.meta.url)),
	"utf8",
);
/**
 * ParentPill.svelte lives in the PARENT (retreeved/, ReTreever-owned). This
 * test moved into the child on 28 Aug 2026, and a child may not climb out of
 * itself or name a parent (noParentNames.test.ts), so the assertion that reads
 * the shared file is `it.skip` below. It belongs to the parent's own suite.
 */
const SHARED_PILL: string | null = null;

describe("HostPill escapes the phone frame", () => {
	it("portals itself to <body>", () => {
		expect(
			/document\.body\.appendChild/.test(PILL),
			"HostPill no longer appends itself to <body>.\n\n" +
				"Without that it is a descendant of .mobile-preview-frame on every\n" +
				"route that draws the phone, and `position: fixed` resolves to the\n" +
				"FRAME (it sets contain:layout + container-type) — so the pill paints\n" +
				"inside the phone, over the map, looking like app UI.\n\n" +
				"No CSS fixes this. Restore the portal effect.",
		).toBe(true);
	});

	it("removes the portalled node on teardown", () => {
		expect(
			/\.remove\(\)/.test(PILL),
			"The portal appends to <body> but never cleans up. A node parented to\n" +
				"<body> is NOT removed by Svelte when the component unmounts, so every\n" +
				"navigation leaves another pill behind.",
		).toBe(true);
	});

	it("still says `fixed`, since the portal is what makes it mean the viewport", () => {
		expect(/position:\s*fixed/.test(PILL)).toBe(true);
	});

	/**
	 * The tiers are NAMED AT THE CALL SITE, and nowhere else.
	 *
	 * "harness" is the dead pre-24-Aug-2026 name for what is now rapper, so a
	 * pill still saying it shows a name matching no folder on disk.
	 *
	 * The names live in the wrapper's props now, not in the shared pill's
	 * markup — and the SHARED file must stay free of them, because rapper
	 * renders that same file and a child carrying a tier name is the defect
	 * noParentNames.test.ts exists to catch.
	 */
	it("names NO tier itself — the names arrive through ports.tier", () => {
		// The dock moved into the child on 28 Aug 2026. The names now live in
		// the HOST's wiring (retreeverMapPorts.ts); this file must stay free of
		// them, or noParentNames.test.ts fails.
		expect(PILL).toContain("ports.tier");
		expect(/"(re){1}treever"/.test(PILL)).toBe(false);
		expect(/"rap{2}er"/.test(PILL)).toBe(false);
		expect(
			/harness/.test(PILL),
			"The pill still says `harness`. That tier is called RAPPER — the folder " +
				"was renamed on 23 Aug 2026 and moved out to a sibling repo on 24 Aug.",
		).toBe(false);
	});

	// SKIPPED 28 Aug 2026: ParentPill.svelte is a parent file the child cannot
	// read without climbing out. The parent suite owns this assertion.
	it.skip("the SHARED pill names no tier — it is told, not hardcoded", () => {
		expect(
			/["'`](retreever|rapper|harness)["'`]/.test(
				(SHARED_PILL as unknown as string).replace(/\/\*[\s\S]*?\*\//g, ""),
			),
			"The shared pill hardcodes a tier name. Both tiers render this ONE " +
				"file, so a name baked in here is wrong under the other one — and it " +
				"ships inside the open repo. Pass it as a prop.",
		).toBe(false);
	});
});
