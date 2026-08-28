/**
 * THE PARENT-GUARD LIGHT'S DATA SOURCE — a dev-only endpoint that RUNS the
 * real test rather than re-implementing it.
 *
 * Every child carries `lib/noParentNames.test.ts`: "a child may not name a
 * parent as a location". It is a vitest test, so the browser cannot run it and
 * the only way to know its colour was to remember to run `npm test`. This
 * runs it on request — once per child, in parallel — and reports pass / fail
 * plus the offending `file:line`s parsed straight from the assertion message.
 *
 * WHY RUN THE TEST INSTEAD OF SHARING ITS REGEX. The light must show the SAME
 * thing that goes red in CI. A second copy of the pattern drifts the day the
 * test is tightened (it was, twice, on 28 Aug 2026 — see the test's own
 * notes), and a light that is green while the test is red is worse than no
 * light. Slower, honest.
 *
 * WHERE THE CHILDREN ARE. Found by SHAPE, never by name: every folder beside
 * this one that carries the guard file IS a child. On a dev machine that is
 * all four; in a solo clone it is just this one. Names of parents appear
 * nowhere here, which is the rule this file reports on.
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
const THIS_CHILD = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WORKSPACE = resolve(THIS_CHILD, "..");

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
	return readdirSync(WORKSPACE, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => join(WORKSPACE, e.name))
		.filter((dir) => existsSync(join(dir, GUARD)))
		.sort();
}

/** `  lib/foo.ts:12  ../Parent/` — the shape the test's assertion prints. */
const OFFENDER = /^\s+((?:lib|routes)\/\S+):(\d+)\s+(.*)$/;

function runGuard(dir: string): Promise<ChildReport> {
	const repo = dir.slice(WORKSPACE.length + 1);
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
				// Red with no parsed offenders = the test could not even run
				// (missing vitest, timeout). Yellow, and say why, rather than a
				// red that points at nothing.
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
