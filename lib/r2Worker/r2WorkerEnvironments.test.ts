// ⛔ TWO ENVIRONMENTS MUST EXIST (local_dev AND r2_prod) — they hold byte-for-byte identical files on purpose (dev vs. deployed prod), so do NOT delete one as a "duplicate"; do not edit this test to make it pass — see README.md.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const R2_WORKER = fileURLToPath(new URL(".", import.meta.url));

/** The two environments, by folder name. Both are load-bearing. */
const ENVIRONMENTS = ["local_dev", "r2_prod"] as const;

/** Files each environment must actually contain — an empty dir is not an env. */
const REQUIRED = ["tilesHost.ts", "roads/packDownload.ts", "fires/fireFetch.ts"];

describe("r2Worker keeps BOTH environments", () => {
	for (const env of ENVIRONMENTS) {
		it(`${env}/ exists`, () => {
			const dir = join(R2_WORKER, env);
			expect(
				existsSync(dir) && statSync(dir).isDirectory(),
				`r2Worker/${env}/ is MISSING.\n\n` +
					`You (or a tool) deleted an ENVIRONMENT, not a duplicate.\n` +
					`  local_dev/ = the worker running on your machine (127.0.0.1:8787)\n` +
					`  r2_prod/   = the worker DEPLOYED to tiles-prod.getcache.org, serving users\n\n` +
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
				`r2Worker/${env}/ exists but has been gutted. Missing:\n` +
					missing.map((m) => `  ${m}`).join("\n") +
					`\n\nAn environment that cannot serve tiles is not an environment.`,
			).toEqual([]);
		});
	}

	// if this ever fails, the environments have genuinely diverged — relax this test deliberately, never remove a folder to fix it.
	it("both environments carry the same file names (identical is CORRECT)", () => {
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

		expect(
			names[0],
			`local_dev/ and r2_prod/ no longer hold the same file names.\n` +
				`That is not automatically wrong — but it is a DECISION. If they have\n` +
				`deliberately diverged, update this test and README.md to say how.\n` +
				`Never resolve it by deleting one side.`,
		).toEqual(names[1]);
	});
});
