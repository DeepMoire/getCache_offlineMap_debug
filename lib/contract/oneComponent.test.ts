/**
 * TWO PARENTS, ONE CHILD, ONE COMPONENT.
 *
 * Every route in every tier that shows the offline map must render the SAME
 * FILE. Not a copy of it, not a fork of it, not a second implementation that
 * looks the same — one file on disk, reached by import.
 *
 * WHY THIS TEST EXISTS
 * On 28 Aug 2026 this was argued for roughly twelve hours. A duplicate offline
 * map kept reappearing in ReTreever; it was deleted four times and recreated
 * four times. Every non-mechanical guard was tried and every one failed:
 *
 *   - Comments saying "do not duplicate this"  -> written, then ignored.
 *   - An agent stating it understood           -> stated repeatedly, then not.
 *   - Deleting the duplicate by hand           -> held until it was recreated.
 *   - kit.files.routes pointing at the child   -> WORST. That option REPLACES
 *     a repo's whole route tree, so making ReTreever share the component
 *     deleted the rest of Get Cache: /menu /cache /inbox /account /quality704
 *     all 404'd at once.
 *
 * Prose cannot fail a build. This can. If a second copy appears, this test
 * names the file and goes red, in CI and locally, without anyone having to
 * notice or remember.
 *
 * WHAT "SHARING" MEANS HERE, AND WHAT IT DOES NOT
 * Sharing happens at the IMPORT layer: a small route file in each tier imports
 * the one component. That ADDS a route without touching the others. It does
 * not happen at the ROUTE-TREE layer: `kit.files.routes` takes exactly one
 * path and does not merge, so pointing a parent at the child's routes replaces
 * everything that parent had. rapper may do it (it has no routes of its own to
 * lose); ReTreever may not (it has thirty). See the assertion at the bottom.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(HERE, "../..");
const FETCH = resolve(CHILD, "..");
const RETREEVER = join(FETCH, "ReTreever");
const RAPPER = join(FETCH, "rapper");

/** The one file every tier must land on. */
const COMPONENT = join(CHILD, "lib/OfflineMapPage.svelte");

/**
 * Resolve an import specifier the way the bundler does, so the test proves the
 * real thing rather than a string match. `$parent/siblings/<child>` is the
 * alias both parents declare; from a parent it means `../<child>`.
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
	let path: string;
	if (spec.startsWith("$parent/siblings/")) {
		path = join(FETCH, spec.slice("$parent/siblings/".length));
	} else if (spec.startsWith(".")) {
		path = resolve(dirname(fromFile), spec);
	} else {
		return null; // bare package import — not our business
	}
	for (const candidate of [path, `${path}.svelte`, `${path}.ts`, join(path, "+page.svelte")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
	}
	return null;
}

/** Every *.svelte file under a directory, skipping node_modules and build output. */
function svelteFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".svelte")) out.push(full);
		}
	};
	walk(root);
	return out;
}

/** Files that import the offline map component, with what they resolve to. */
function importersOfComponent(searchRoots: string[]) {
	const hits: { file: string; spec: string; resolved: string | null }[] = [];
	for (const root of searchRoots) {
		for (const file of svelteFiles(root)) {
			if (realpathSync(file) === realpathSync(COMPONENT)) continue; // the component itself
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/import\s+\w+\s+from\s+["']([^"']+\+page\.svelte)["']/g)) {
				const spec = m[1];
				const resolved = resolveSpecifier(spec, file);
				if (resolved === realpathSync(COMPONENT)) hits.push({ file, spec, resolved });
			}
		}
	}
	return hits;
}

describe("two parents, one child, one component", () => {
	it("the one component exists", () => {
		expect(existsSync(COMPONENT), `the offline map component is missing: ${COMPONENT}`).toBe(true);
	});

	/**
	 * THE CORE ASSERTION. Every route that renders the offline map resolves to
	 * the same inode. A second copy anywhere makes this fail and names it.
	 */
	it("every importer of the offline map resolves to the SAME file", () => {
		const importers = importersOfComponent([
			join(CHILD, "routes"),
			join(RETREEVER, "src/routes"),
			join(RAPPER, "src"),
		]);
		const targets = new Set(importers.map((h) => h.resolved));
		expect(
			targets.size <= 1,
			`Routes render DIFFERENT files. Every one must import ${COMPONENT}.\n` +
				importers.map((h) => `  ${h.file}\n    -> ${h.resolved}`).join("\n"),
		).toBe(true);
	});

	/**
	 * NO SECOND IMPLEMENTATION. A copy does not have to be imported to do
	 * damage — the duplicate that cost 28 Aug 2026 was a standalone 1,702-line
	 * page in ReTreever that nothing imported. Detect it by SHAPE: any other
	 * route file carrying the map engine's own markers is a fork.
	 */
	it("no second offline-map implementation exists in either parent", () => {
		const FINGERPRINTS = ["class=\"stage\"", "class=\"rig\"", "mapContainer"];
		const forks: string[] = [];
		for (const root of [join(RETREEVER, "src/routes"), join(RAPPER, "src")]) {
			for (const file of svelteFiles(root)) {
				const src = readFileSync(file, "utf8");
				const score = FINGERPRINTS.filter((f) => src.includes(f)).length;
				// All three markers together means the engine was copied, not imported.
				if (score === FINGERPRINTS.length) forks.push(file);
			}
		}
		expect(
			forks.length,
			`A second copy of the offline map exists. Delete it and import ${COMPONENT} instead:\n` +
				forks.map((f) => `  ${f}`).join("\n"),
		).toBe(0);
	});

	/**
	 * RETREEVER MUST KEEP ITS OWN ROUTE TREE.
	 *
	 * `kit.files.routes` takes ONE path and does not merge. Setting it in
	 * ReTreever replaces all thirty-odd Get Cache routes with the child's two.
	 * Measured 28 Aug 2026: /menu /cache /map /inbox /account /quality704 all
	 * 404'd simultaneously and the child's dev nav rendered on ReTreever's host.
	 * Sharing belongs at the import layer, which adds instead of replacing.
	 */
	it("ReTreever does not hand its route tree to the child", () => {
		const config = join(RETREEVER, "svelte.config.js");
		if (!existsSync(config)) return; // ReTreever not checked out beside us
		const src = readFileSync(config, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(
			/routes\s*:\s*["'][^"']*getCache_OfflineMap/.test(src),
			"ReTreever/svelte.config.js sets kit.files.routes to the child. That REPLACES " +
				"ReTreever's whole route tree — every other Get Cache route 404s. " +
				"Import the component from a route file instead.",
		).toBe(false);
	});
});
