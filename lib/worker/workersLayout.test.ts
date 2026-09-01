/**
 * THREE WORKER FOLDERS, NAMED LIKE THE THREE TIERS, SIDE BY SIDE.
 *
 * workers/worker-local-dev is the one that gets edited and run on the developer's
 * machine; workers/worker-cloud-dev and workers/worker-cloud-prod are the record of what each
 * cloud tier is running, overwritten by their own deploy scripts on every
 * deploy (Chris, 31 Aug 2026: "three directories called the three [tiers],
 * all lined up"). Same shape as the worker-local-dev/ + worker-cloud-prod/ client copies in
 * this folder, and the same failure mode guarded: a tier folder silently
 * going missing, or the old single worker/ coming back in a merge.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const at = (p: string) =>
	fileURLToPath(new URL(`../../workers/${p}`, import.meta.url));

describe("workers/ layout", () => {
	it("has all three tier folders, each with the worker source and config", () => {
		for (const tier of ["worker-local-dev", "worker-cloud-dev", "worker-cloud-prod"]) {
			for (const f of ["src/index.ts", "wrangler.toml", "package.json"]) {
				expect(existsSync(at(`${tier}/${f}`)), `workers/${tier}/${f}`).toBe(true);
			}
		}
	});

	it("keeps the local runner in worker-local-dev and a deploy script in each cloud tier", () => {
		expect(existsSync(at("worker-local-dev/setupLocalTiles.sh"))).toBe(true);
		expect(existsSync(at("worker-cloud-dev/deployDev.sh"))).toBe(true);
		expect(existsSync(at("worker-cloud-prod/deployProduction.sh"))).toBe(true);
	});

	it("never grows the old single worker/ folder back", () => {
		expect(
			existsSync(fileURLToPath(new URL("../../worker", import.meta.url))),
			"worker/ exists again — a merge resurrected the pre-split folder; its contents belong in workers/worker-local-dev",
		).toBe(false);
	});
});
