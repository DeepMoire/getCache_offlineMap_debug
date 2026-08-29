import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(
	join(__dirname, "..", "..", "OfflineMapPage.svelte"),
	"utf8",
);

/** The import block for rawWallProtocol, names only. */
const RAW_WALL_IMPORT = (() => {
	const start = PAGE.indexOf("import {");
	const end = PAGE.indexOf('} from "../../lib/onPhone/roads/rawWallProtocol"');
	return PAGE.slice(start, end);
})();

describe("blind-tile self-heal is wired end to end", () => {
	it("the route arms the handler", () => {
		expect(PAGE).toContain("setRawWallBlindHandler(");
	});

	it("every rawWallProtocol name the route USES is also IMPORTED", () => {
		// The actual guard — a name used but not imported is invisible to a build, fatal at runtime.
		for (const name of ["setRawWallBlindHandler", "refreshRawTiles"]) {
			expect(
				RAW_WALL_IMPORT,
				`${name} is used but missing from the rawWallProtocol import`,
			).toContain(name);
		}
	});

	it("refreshRawTiles is actually exported by rawWallProtocol", () => {
		const proto = readFileSync(join(__dirname, "rawWallProtocol.ts"), "utf8");
		expect(proto).toMatch(/export function refreshRawTiles/);
	});
});
