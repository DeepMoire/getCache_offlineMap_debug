// ⛔ Never point a parent's kit.files.routes at the child's route dir when that parent has its own routes (e.g. ReTreever) — it REPLACES the whole route tree rather than merging, so every other route 404s at once. Share at the import layer instead: a small route file per tier imports the one shared component.
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

/** A sibling's package name -> its folder, read from the manifests beside this child (never a table that drifts). */
const FOLDER_OF: Record<string, string> = Object.fromEntries(
	readdirSync(FETCH, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
		.filter((e) => existsSync(join(FETCH, e.name, "package.json")))
		.map((e) => [JSON.parse(readFileSync(join(FETCH, e.name, "package.json"), "utf8")).name, join(FETCH, e.name)]),
);

/** Resolves an import specifier the way the bundler does; `@ground-truth/<child>/...` is a sibling folder via the workspace symlink. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
	let path: string;
	const pkg = Object.keys(FOLDER_OF).find((n) => spec.startsWith(`${n}/`));
	if (pkg) {
		path = join(FOLDER_OF[pkg], spec.slice(pkg.length + 1)).replace(/\.js$/, "");
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

	/** THE CORE ASSERTION: every route that renders the offline map resolves to the same inode — a second copy anywhere makes this fail and names it. */
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

	/** NO SECOND IMPLEMENTATION — a copy doesn't have to be imported to do damage. Detected by SHAPE: any other route file carrying the map engine's own markers is a fork. */
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

	// ⛔ kit.files.routes takes ONE path and doesn't merge — setting it in ReTreever replaces all thirty-odd Get Cache routes with the child's two (measured 28 Aug 2026: /menu /cache /map /inbox /account /quality704 all 404'd at once). Share at the import layer instead.
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
