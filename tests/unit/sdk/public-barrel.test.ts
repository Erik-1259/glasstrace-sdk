import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as rootBarrel from "../../../packages/sdk/src/index.js";

/**
 * SDK-029 public-barrel snapshot gate.
 *
 * Pins the exact set of runtime exports surfaced by `@glasstrace/sdk`'s
 * root specifier. Any change to `packages/sdk/src/index.ts` that adds
 * or removes a runtime export must also update the committed fixture at
 * `public-barrel.snapshot.json`. This catches accidental re-addition of
 * Node-only symbols (the SDK-029 removals) and accidental leaks of new
 * implementation-detail exports into the public surface.
 *
 * The test imports TypeScript source, not `dist/`, so a stray `export`
 * fails the test instantly instead of waiting for a rebuild. Type-only
 * exports are not visible at runtime and are not part of this snapshot;
 * they are guarded by the TypeScript compilation of consumers (any
 * consumer referencing a type that was removed fails `tsc` with TS2307).
 */
describe("public-barrel snapshot (SDK-029)", () => {
  it("matches the committed fixture", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = resolve(here, "public-barrel.snapshot.json");
    const fixture: string[] = JSON.parse(readFileSync(fixturePath, "utf8"));
    const actual = Object.keys(rootBarrel).sort();

    expect(actual).toEqual(fixture);
  });
});
