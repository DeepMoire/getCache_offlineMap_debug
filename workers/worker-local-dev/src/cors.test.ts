// ⚠️ a header not listed in Access-Control-Expose-Headers is invisible cross-origin — res.headers.get() silently returns null, no error.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8",
);

describe("CORS expose-headers", () => {
  it("⛔ every X- header the Worker SETS is also EXPOSED", () => {
    const set = new Set(
      [...src.matchAll(/"(X-[A-Za-z-]+)"\s*:/g)].map((m) => m[1]),
    );
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
