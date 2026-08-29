import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DEV_HOST } from "./local_dev/tilesHost";

/** ⛔ the three tiers have three names — prod (tiles-prod.getcache.org), dev (tiles-dev.getcache.org), local (tiles-local.getcache.org, → 127.0.0.1 until the record exists). A test enforces it, not a doc: seven spellings were live at once and every one read as authoritative. [[no-silent-fallbacks]] */

const ALLOWED = [
	"tiles-prod.getcache.org",
	"tiles-dev.getcache.org",
	"tiles-local.getcache.org",
];

/** Anything that LOOKS like one of our tile hostnames. */
const TILE_HOST = /tiles[a-z-]*\.(?:getcache|retreever)\.(?:org|com|io|app)/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === "node_modules" || e === ".svelte-kit" || e.startsWith(".")) continue;
		const full = join(dir, e);
		if (statSync(full).isDirectory()) sourceFiles(full, acc);
		else if (/\.(ts|svelte|js)$/.test(e)) acc.push(full);
	}
	return acc;
}

const CHILD_ROOT = join(__dirname, "..", "..");

describe("tile hostnames — dev, prod, local and nothing else", () => {
	it("no file in the child spells a tile host any other way", () => {
		const offenders: string[] = [];
		for (const f of sourceFiles(CHILD_ROOT)) {
			if (f.endsWith("tierNaming.test.ts")) continue; // ALLOWED lives here
			const text = readFileSync(f, "utf8");
			for (const m of text.match(TILE_HOST) ?? []) {
				if (!ALLOWED.includes(m)) {
					offenders.push(`${f.replace(CHILD_ROOT, ".")}: ${m}`);
				}
			}
		}
		expect(
			offenders,
			`Off-convention tile hostname(s). The three tiers are:\n  ${ALLOWED.join("\n  ")}\n` +
				`Found:\n  ${offenders.join("\n  ")}`,
		).toEqual([]);
	});

	it("the child bakes in NO production hostname at all", () => {
		// ⛔ the child cannot name our infrastructure — prod arrives via VITE_TILES_HOST at boot; there's no PRODUCTION_HOST export to assert on, and that absence IS the guarantee. [[child-names-no-parent]]
		const src = readFileSync(join(__dirname, "local_dev", "tilesHost.ts"), "utf8");
		const code = src
			.split("\n")
			.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
			.join("\n");
		expect(code).not.toMatch(/tiles-(prod|dev)\.getcache\.org/);
	});

	it("the local tier is loopback or the local NAME — never a cloud host", () => {
		// loopback while the DNS record is missing, tiles-local.getcache.org once it exists — anything else means local silently became remote and bills someone for a "free" tier
		expect(LOCAL_DEV_HOST).toMatch(
			/^https?:\/\/(127\.0\.0\.1|localhost|tiles-local\.getcache\.org):8787$/,
		);
	});
});
