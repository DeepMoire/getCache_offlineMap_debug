/**
 * THE PARENT-GUARD LIGHT'S DATA SOURCE — a dev-only endpoint that runs the real test rather than re-implementing it.
 *
 * Children are found by SHAPE, never by name — this file must not hardcode parent/child names itself.
 *
 * `.server.ts` so no page can import it by accident — it spawns processes.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "@sveltejs/kit";
import { dev } from "$app/environment";

const GUARD = "lib/noParentNames.test.ts";
// Lazy, not module-scope: the cap build compiles `import.meta.url` away to
// undefined, and a top-level `new URL("../..", undefined)` crashes SvelteKit's
// postbuild analysis. This endpoint only ever RUNS in dev, so resolve at call
// time, where a real import.meta.url exists.
const workspaceDir = () =>
	resolve(fileURLToPath(new URL("../..", import.meta.url)), "..");

export type GuardStatus = "green" | "red" | "yellow";
export interface Offender {
	rel: string;
	line: number;
	abs: string;
	text: string;
}
export interface ChildReport {
	repo: string;
	status: GuardStatus;
	offenders: Offender[];
	note?: string;
	ms: number;
}

function children(): string[] {
	const ws = workspaceDir();
	return readdirSync(ws, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => join(ws, e.name))
		.filter((dir) => existsSync(join(dir, GUARD)))
		.sort();
}

/** `  lib/foo.ts:12  ../Parent/` — the shape the test's assertion prints. */
const OFFENDER = /^\s+((?:lib|routes)\/\S+):(\d+)\s+(.*)$/;

function runGuard(dir: string): Promise<ChildReport> {
	const repo = dir.slice(workspaceDir().length + 1);
	const t0 = Date.now();
	return new Promise((done) => {
		execFile(
			"npx",
			["vitest", "run", GUARD],
			{ cwd: dir, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const out = `${stdout}\n${stderr}`;
				const ms = Date.now() - t0;
				if (!err) return done({ repo, status: "green", offenders: [], ms });
				const offenders: Offender[] = [];
				for (const line of out.split("\n")) {
					const m = OFFENDER.exec(line);
					if (m) {
						offenders.push({
							rel: m[1],
							line: Number(m[2]),
							abs: join(dir, m[1]),
							text: m[3].trim(),
						});
					}
				}
				// no parsed offenders = the test couldn't run (missing vitest, timeout) — report yellow, not a red pointing at nothing
				if (offenders.length === 0) {
					const note = /timed out|ETIMEDOUT/i.test(String(err))
						? "guard timed out"
						: (out.split("\n").find((l) => /Error|error/.test(l)) ?? String(err)).trim().slice(0, 200);
					return done({ repo, status: "yellow", offenders, note, ms });
				}
				done({ repo, status: "red", offenders, ms });
			},
		);
	});
}

/** One run in flight at a time; a second request while running joins it. */
let inFlight: Promise<ChildReport[]> | null = null;

export const GET = async () => {
	if (!dev) return new Response("Not found", { status: 404 });
	inFlight ??= Promise.all(children().map(runGuard)).finally(() => {
		inFlight = null;
	});
	const reports = await inFlight;
	return json({ at: new Date().toISOString(), guard: GUARD, children: reports });
};
