// ⛔ ALL THREE environments (worker-local-dev, worker-cloud-dev AND worker-cloud-prod) must exist — identical bytes on purpose; never delete one as a "duplicate", never edit this test to pass.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const R2_WORKER = fileURLToPath(new URL(".", import.meta.url));

const ENVIRONMENTS = ["worker-local-dev", "worker-cloud-dev", "worker-cloud-prod"] as const;

/** files each environment must contain — an empty dir is not an env */
const REQUIRED = ["tilesHost.ts", "roads/packDownload.ts", "fires/fireFetch.ts"];

describe("worker keeps ALL THREE environments", () => {
	for (const env of ENVIRONMENTS) {
		it(`${env}/ exists`, () => {
			const dir = join(R2_WORKER, env);
			expect(
				existsSync(dir) && statSync(dir).isDirectory(),
				`worker/${env}/ is MISSING.\n\n` +
					`You (or a tool) deleted an ENVIRONMENT, not a duplicate.\n` +
					`  worker-local-dev/ = the worker running on your machine (127.0.0.1:8787)\n` +
					`  worker-cloud-dev/    = the worker DEPLOYED to tiles-dev.getcache.org\n` +
					`  worker-cloud-prod/   = the worker DEPLOYED to tiles-prod.getcache.org, serving users\n\n` +
					`They hold identical bytes on purpose: the same code at two stages of\n` +
					`readiness. That is what lets you break dev all day without touching\n` +
					`what is live.\n\n` +
					`Restore it — git log will have it — and read README.md next to this\n` +
					`test before touching this folder again.`,
			).toBe(true);
		});

		it(`${env}/ still has its worker files`, () => {
			const missing = REQUIRED.filter(
				(f) => !existsSync(join(R2_WORKER, env, f)),
			);
			expect(
				missing,
				`worker/${env}/ exists but has been gutted. Missing:\n` +
					missing.map((m) => `  ${m}`).join("\n") +
					`\n\nAn environment that cannot serve tiles is not an environment.`,
			).toEqual([]);
		});
	}

	// ⛔ if this fails the environments have diverged — relax the test deliberately, never delete a folder to fix it.
	it("every environment carries the same file names (identical is CORRECT)", () => {
		const names = ENVIRONMENTS.map((env) => {
			const walk = (d: string, prefix = ""): string[] =>
				readdirSync(d, { withFileTypes: true })
					.filter((e) => !e.name.startsWith("."))
					.flatMap((e) =>
						e.isDirectory()
							? walk(join(d, e.name), `${prefix}${e.name}/`)
							: [`${prefix}${e.name}`],
					);
			return walk(join(R2_WORKER, env)).sort();
		});

		for (let i = 1; i < names.length; i++) {
			expect(
				names[0],
				`${ENVIRONMENTS[0]}/ and ${ENVIRONMENTS[i]}/ no longer hold the same file names.\n` +
					`That is not automatically wrong — but it is a DECISION. If they have\n` +
					`deliberately diverged, update this test and README.md to say how.\n` +
					`Never resolve it by deleting one side.`,
			).toEqual(names[i]);
		}
	});
});
