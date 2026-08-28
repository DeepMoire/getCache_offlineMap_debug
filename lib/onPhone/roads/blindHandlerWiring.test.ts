import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SELF-HEAL MUST ACTUALLY BE WIRED, AND ITS IMPORTS MUST BE COMPLETE.
 *
 * rawWallProtocol detects "MapLibre is asking for tiles and finding none" —
 * the cached-404 state a map cannot recover from on its own — and calls
 * onBlind. This has now been half-wired TWICE:
 *
 *   1. `setRawWallBlindHandler` had ZERO callers repo-wide. Its own comment
 *      said "Set by the route" and the route never did. The detector narrated
 *      and did nothing.
 *   2. The setter was then called but not IMPORTED, so the wall mount threw
 *      `setRawWallBlindHandler is not defined` on every load.
 *   3. The setter was imported; `refreshRawTiles`, the function handed TO it,
 *      was not. MEASURED 27 Aug 2026 in the browser:
 *      "refreshRawTiles is not defined (+page.svelte:405)". The error simply
 *      moved one frame later — the callback throws instead of the mount.
 *
 * Each round looked fixed and left the map blank. A runtime error inside a
 * callback that only fires on failure is invisible until the failure happens,
 * which is the worst possible place for one.
 */

const PAGE = readFileSync(
	join(__dirname, "..", "..", "..", "routes", "demo", "+page.svelte"),
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
		// The actual guard. Both previous failures were a name used but not
		// imported — invisible to a build, fatal at runtime.
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
