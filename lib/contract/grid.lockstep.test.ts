/** ⚠️ The grid must be byte-identical on both sides. If this fails, don't edit one copy — copy the Worker's file over the client's (or vice versa): cp ReTreever/workers/offline-tiles/src/grid.ts getCache_OfflineMap/lib/contract/grid.ts — they're separate build roots, not allowed to differ. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOB_TILE_Z, GRID_RADIUS_KM, cellOf, cellsFor } from "./grid";

const workerGrid = fileURLToPath(
	// The Worker's grid lives in ReTreever; this child holds the client's.
	new URL(
		"../../../ReTreever/workers/offline-tiles/src/grid.ts",
		import.meta.url,
	),
);
const clientGrid = fileURLToPath(new URL("./grid.ts", import.meta.url));

const haveWorker = existsSync(workerGrid);

describe("the grid is ONE definition", () => {
	it.skipIf(!haveWorker)("⛔ the Worker's grid.ts and the client's are IDENTICAL", () => {
		const worker = readFileSync(workerGrid, "utf8");
		const client = readFileSync(clientGrid, "utf8");
		expect(client).toBe(worker);
	});

	it("the cell zoom and the radius are both real numbers", () => {
		expect(BLOB_TILE_Z).toBeGreaterThanOrEqual(8);
		expect(GRID_RADIUS_KM).toBeGreaterThan(0);
	});

	it("a real anchor resolves to a cell and a small cell list", () => {
		const cells = cellsFor(-111.5, 46.6);
		expect(cells.length).toBeGreaterThanOrEqual(1);
		expect(cells.length).toBeLessThanOrEqual(25);
		expect(cells[0]).toEqual(cellOf(-111.5, 46.6));
	});
});
