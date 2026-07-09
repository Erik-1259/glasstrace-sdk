import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createSpanDiagnostics,
  SpanDiagnosticsProcessor,
} from "../../../../packages/sdk/src/diagnostics/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "../../../../packages/sdk/package.json");

interface PkgExports {
  exports: Record<
    string,
    { types?: string; node?: { import: string; require: string }; default?: unknown }
  >;
}

describe("@glasstrace/sdk/diagnostics subpath wiring", () => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgExports;
  const entry = pkg.exports["./diagnostics"];

  it("is declared as a Node-only export with default:null (mirrors ./node)", () => {
    expect(entry).toBeDefined();
    expect(entry.types).toBe("./dist/diagnostics/index.d.ts");
    expect(entry.node).toEqual({
      import: "./dist/diagnostics/index.js",
      require: "./dist/diagnostics/index.cjs",
    });
    // `default: null` is the load-bearing guard that makes the subpath resolve
    // to nothing (not a crash) off the Node condition.
    expect(entry.default).toBeNull();
    expect("import" in entry).toBe(false); // no top-level import/require alongside node
    expect("require" in entry).toBe(false);
  });

  it("exposes the runtime exports the verify-subpath gate requires", () => {
    expect(typeof createSpanDiagnostics).toBe("function");
    expect(typeof SpanDiagnosticsProcessor).toBe("function");
  });
});
