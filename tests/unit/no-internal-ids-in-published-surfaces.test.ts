import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Public-surface guard, exercised as part of the standard `npm run test`
 * gate so the no-leak rule is enforced locally as well as in CI.
 *
 * Asserts that no internal tracking identifier reaches a surface that
 * ships to npm consumers: each workspace package's published README (this
 * monorepo ships a per-package README via each package's `files` list, so
 * the published READMEs are `packages/sdk/README.md` and
 * `packages/protocol/README.md`, not the repo-root `README.md`) or the
 * generated `.d.ts` / `.d.cts` declaration files. JSDoc on an exported
 * symbol propagates verbatim into those declarations and surfaces in
 * consumers' editor tooltips, so an internal identifier left in exported
 * JSDoc is a real public leak. The shared scanner lives in
 * `scripts/check-no-internal-ids.mjs`; this test imports it directly so
 * the test and the CI script can never drift.
 *
 * The declaration-file portion of the scan requires a built `dist/`. CI
 * runs Build before Test, so the guard is active there. When run locally
 * without a prior `npm run build`, the scanner reports the missing `dist/`
 * directories; this test treats that as a skip-condition for the
 * declaration-file assertions rather than a failure, while still always
 * asserting on the published package READMEs, which need no build step.
 */

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(
  thisFileDir,
  "../../scripts/check-no-internal-ids.mjs",
);

const { checkNoInternalIds } = (await import(
  pathToFileURL(scriptPath).href
)) as {
  checkNoInternalIds: () => {
    violations: { file: string; line: number; text: string; id: string }[];
    scannedFileCount: number;
    distMissing: string[];
  };
};

describe("published surfaces carry no internal tracking identifiers", () => {
  const { violations, distMissing } = checkNoInternalIds();

  it("published package READMEs and built declaration files are free of internal IDs", () => {
    // A readable failure message: list every offending location rather
    // than just asserting the array is empty.
    const report = violations
      .map((v) => `${v.file}:${v.line} (${v.id}) — ${v.text}`)
      .join("\n");
    expect(violations, report).toEqual([]);
  });

  it.runIf(distMissing.length === 0)(
    "scans the generated declaration files (requires a prior build)",
    () => {
      // When dist/ is present, the scan above already covered the
      // declaration files. This assertion documents the expectation that
      // CI (Build before Test) exercises the full surface.
      expect(distMissing).toEqual([]);
    },
  );
});
