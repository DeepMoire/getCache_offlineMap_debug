/**
 * THE GRID MUST BE THE SAME FILE ON BOTH SIDES — byte for byte.
 *
 * The Worker decides which cell it BUILT; the phone decides which cell to ASK
 * FOR and where to draw it. If those two disagree by so much as a rounding
 * rule, the phone requests a cell the Worker never built and the map is blank —
 * silently, with no error anywhere, which is the failure mode this whole
 * subsystem keeps producing.
 *
 * The old guard SCRAPED the Worker's source for `BLOB_KM = 30` with a regex.
 * That could only ever check a constant, and the cell math — the row-banded
 * longitude step, the neighbour resolution — is where the real disagreement
 * would live. So this compares the FILES, not a number in them.
 *
 * ⚠️ If this fails, do not "fix" it by editing one copy. Copy the Worker's file
 * over the client's (or vice versa) so they are one definition again:
 *
 *     cp ReTreever/workers/offline-tiles/src/grid.ts getCache_OfflineMap/lib/contract/grid.ts
 *
 * They are two files only because the Worker and the app are separate build
 * roots with no shared package — not because they are allowed to differ.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOB_TILE_Z, GRID_RADIUS_KM, cellOf, cellsFor } from "./grid";

const workerGrid = fileURLToPath(
	// The Worker's grid lives in ReTreever; this child holds the client's.
	// The climb is COUNTED from this file's own depth, not hand-written:
	// the hand-written version said "7 levels" and described a folder
	// layout that has moved twice since, so it pointed at nothing while
	// the suite stayed green.
	//
	// It is still a raw path naming a parent, which a portable child may
	// not do — so the test SKIPS when ReTreever is absent (a standalone
	// clone) rather than failing. There is genuinely nothing to compare
	// against there; the lockstep only means something with both halves.
	// 28 Aug 2026: the Worker moved INTO this child (worker/src/), so the path
	// names no parent any more and the skip below is only ever hit by a
	// checkout that dropped worker/ on purpose. Its grid.ts is now a one-line
	// re-export of THIS file — one definition, not two copies held in step.
	new URL("../../workers/local_dev/src/grid.ts", import.meta.url),
);
const clientGrid = fileURLToPath(new URL("./grid.ts", import.meta.url));

/**
 * THE SKIP THE COMMENT ABOVE PROMISED, NOW ACTUALLY IMPLEMENTED.
 *
 * The note at the path said this test "SKIPS when ReTreever is absent (a
 * standalone clone)". It did not: readFileSync ran unguarded, so a solo clone
 * got ENOENT — a crash dressed as a failing contract, blaming the one thing
 * the child is built to support. A comment is not a control flow statement.
 */
const haveWorker = existsSync(workerGrid);

describe("the grid is ONE definition", () => {
	it.skipIf(!haveWorker)("⛔ the Worker's grid.ts and the client's are IDENTICAL", () => {
		const worker = readFileSync(workerGrid, "utf8");
		// Either a byte-identical copy, or a re-export that resolves to this file.
		const reexport = /export \* from ["']([^"']+)["']/.exec(worker)?.[1];
		if (reexport) {
			expect(resolve(dirname(workerGrid), `${reexport}.ts`)).toBe(clientGrid);
		} else {
			expect(readFileSync(clientGrid, "utf8")).toBe(worker);
		}
	});

	it("the cell zoom and the radius are both real numbers", () => {
		// A sanity anchor so a future edit that guts one is caught here rather
		// than on a phone in the bush.
		expect(BLOB_TILE_Z).toBeGreaterThanOrEqual(8);
		expect(GRID_RADIUS_KM).toBeGreaterThan(0);
	});

	it("a real anchor resolves to a cell and a small cell list", () => {
		// The user's own test anchor. Not a property test — a smoke check that the
		// module is wired up and returns something sane at a real place.
		const cells = cellsFor(-111.5, 46.6);
		expect(cells.length).toBeGreaterThanOrEqual(1);
		expect(cells.length).toBeLessThanOrEqual(25);
		expect(cells[0]).toEqual(cellOf(-111.5, 46.6));
	});
});
