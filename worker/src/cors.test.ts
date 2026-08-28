/**
 * EVERY CUSTOM RESPONSE HEADER MUST BE READABLE BY THE APP.
 *
 * A cross-origin response hides `X-*` headers from JavaScript unless they are
 * named in `Access-Control-Expose-Headers`. `res.headers.get()` then returns
 * `null` — no error, no warning, nothing in the network panel to suggest a
 * problem. The header is simply gone.
 *
 * MEASURED: the app logged `{"build":"","cache":"","diag":""}` for a whole
 * session while the Worker was faithfully sending all three. The Worker's own
 * build time — the number that decides whether "slow" is the server or the
 * network — was being thrown away by the browser, unnoticed.
 *
 * So this test reads the SOURCE and asserts that every header the Worker sets
 * is exposed. It cannot be satisfied by remembering; it fails the moment
 * someone adds a header and forgets the list.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8",
);

describe("CORS expose-headers", () => {
  it("⛔ every X- header the Worker SETS is also EXPOSED", () => {
    // Header keys as they appear in the response-header object literals:
    //     "X-Pack-Build": PACK_BUILD,
    const set = new Set(
      [...src.matchAll(/"(X-[A-Za-z-]+)"\s*:/g)].map((m) => m[1]),
    );
    // The exposed list itself is written as string entries in an array; drop
    // those from the "set" side by reading the list separately.
    const listBlock = /const EXPOSED_HEADERS = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
    const exposed = new Set(
      [...listBlock.matchAll(/"(X-[A-Za-z-]+)"/g)].map((m) => m[1]),
    );
    expect(exposed.size).toBeGreaterThan(0);

    const missing = [...set].filter((h) => !exposed.has(h));
    expect(
      missing,
      `these headers are SET but not EXPOSED — the app will read null:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the CORS block actually carries the expose list", () => {
    expect(src).toContain('"Access-Control-Expose-Headers": EXPOSED_HEADERS');
  });
});
