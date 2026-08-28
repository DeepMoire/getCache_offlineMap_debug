/**
 * THE TIER PILL MUST NOT SHIP.
 *
 * It is a developer control that links to localhost:5174. In production it is
 * at best confusing and at worst a dead link on a customer's screen.
 *
 * MEASURED 27 Aug 2026: HostPillDock had no gate of its own and relied on each
 * of its FIVE mount sites writing `{#if dev}`. Three had not — /offline,
 * /offline/debug and /where/debug — so the control was one `vite build` away
 * from production on those pages.
 *
 * That is the opt-OUT shape src/routes/routeGroups.test.ts exists to delete:
 * a rule every new mount must remember, failing silently when one forgets.
 * The gate now lives in the COMPONENT, so a careless mount is still correct,
 * and this test fails if anyone moves it back out.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCK = new URL("./HostPillDock.svelte", import.meta.url).pathname;
/**
 * SharedNav.svelte lives in the PARENT (retreeved/, ReTreever-owned). This
 * test moved into the child on 28 Aug 2026, and a child may not climb out
 * of itself or name a parent (noParentNames.test.ts), so the assertions that
 * read the shared file are `it.skip` here. They belong to the parent's own
 * suite, beside the file they read.
 */
const PILL: string | null = null;

/** Assert on CODE, never on the prose explaining it — this file's own comments
 *  name `{#if dev}` at length, and so do the components'. */
const strip = (t: string): string =>
	t
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");

describe("the tier pill is dev-only by construction", () => {
	it("HostPillDock gates ITSELF, not its mount sites", () => {
		const src = strip(readFileSync(DOCK, "utf8"));
		// The compile-time constant — the only form Vite strips from a build.
		expect(src).toMatch(/const dev = import\.meta\.env\.DEV/);
		expect(src).toMatch(/\{#if dev/);
	});

	it("the dev gate WRAPS the markup, not just some of it", () => {
		const src = strip(readFileSync(DOCK, "utf8"));
		const gate = src.search(/\{#if dev/);
		const dock = src.indexOf('class="host-pill-dock"');
		expect(gate).toBeGreaterThan(-1);
		expect(dock).toBeGreaterThan(gate);
	});

	/**
	 * MARKUP IS NOT ENOUGH — the STYLES have to go too.
	 *
	 * `{#if dev}` removes markup, and Svelte emits a component's stylesheet
	 * whenever the component is IMPORTED. MEASURED 27 Aug 2026 on a real
	 * `vite build`: HostPillDock.xAf8Xd83.css shipped four .host-pill-dock
	 * rules to every page, and SharedNav's bundle carried four .host-pill
	 * rules, for a control that can never render in production.
	 *
	 * Two things fix that and both are asserted here: the dock carries NO
	 * style block at all (its positioning is inline, inside the dev branch),
	 * and the pill is a DYNAMIC import that an unreachable branch drops.
	 */
	it("the dock emits no stylesheet, so none can leak", () => {
		const src = readFileSync(DOCK, "utf8");
		expect(src).not.toMatch(/<style[\s>]/);
	});

	it("imports the pill DYNAMICALLY, so its stylesheet is dropped too", () => {
		// PILL (SharedNav.svelte) is a parent file — only the DOCK is read here.
		for (const f of [DOCK]) {
			const src = strip(readFileSync(f, "utf8"));
			expect(src).toMatch(/if \(import\.meta\.env\.DEV\)/);
			expect(src).toMatch(/import\(\s*["'][^"']*ParentPill\.svelte["']/);
			// A static import would re-emit the stylesheet regardless of the gate.
			expect(src).not.toMatch(/^import ParentPill from/m);
		}
	});

	/**
	 * THE DEV ORIGINS ARE STRINGS, and a top-level `const` is evaluated whether
	 * or not the markup using it renders. MEASURED 27 Aug 2026: both origins sat
	 * in the production client bundle (chunks/BAvWnliA.js) after the markup had
	 * been correctly stripped.
	 */
	it("keeps the dev origins inside the compile-time branch", () => {
		const src = strip(readFileSync(DOCK, "utf8"));
		for (const line of src.split("\n")) {
			if (!line.includes("localhost:517")) continue;
			expect(line).toMatch(/import\.meta\.env\.DEV/);
		}
	});

	// SKIPPED 28 Aug 2026: SharedNav.svelte lives in the parent (retreeved/);
	// the child cannot read it without climbing out. Parent suite owns this.
	it.skip("SharedNav gates itself the same way", () => {
		const src = strip(readFileSync(PILL as unknown as string, "utf8"));
		expect(src).toMatch(/const dev = import\.meta\.env\.DEV/);
		expect(src).toMatch(/\{#if dev\}/);
	});

	/**
	 * `dev` must be the COMPILE-TIME constant. SvelteKit's runtime `dev` (from
	 * its app-environment module) is a
	 * runtime import — true in a `vite preview` of a production build — so it
	 * would leave the markup, the styles and both localhost origins in the
	 * bundle even where it renders nothing.
	 */
	it("uses the compile-time constant, not the runtime one", () => {
		// PILL (SharedNav.svelte) is a parent file — only the DOCK is read here.
		for (const f of [DOCK]) {
			const src = strip(readFileSync(f, "utf8"));
			// `\$ap{2}` spells the SvelteKit alias without writing it literally —
			// the child's boundary grep must find NO `$`-alias text in this folder.
			expect(src).not.toMatch(/import\s*\{[^}]*\bdev\b[^}]*\}\s*from\s*["']\$ap{2}\/environment["']/);
		}
	});
});
