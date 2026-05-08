import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// DISC-1565: when the static-discovery file write fails, init must
// surface the failure via a non-zero exit code so CI / scripts wrapping
// `glasstrace init` see it without parsing stderr. Before this fix the
// failure was warned-and-ignored: init exited 0 and the dispatcher
// printed "Glasstrace initialized successfully!" while the browser
// extension's discovery file was missing.
//
// Mock writeDiscoveryFile to return action=failed so the test does not
// depend on filesystem permission games (which root bypasses on CI).
vi.mock("../../../../packages/sdk/src/cli/discovery-file.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../packages/sdk/src/cli/discovery-file.js")
  >("../../../../packages/sdk/src/cli/discovery-file.js");
  return {
    ...actual,
    writeDiscoveryFile: vi.fn(() => ({
      action: "failed",
      filePath: "/tmp/test/public/.well-known/glasstrace.json",
      layout: "public" as const,
      error: "simulated write failure (DISC-1565 test fixture)",
    })),
  };
});

import { runInit } from "../../../../packages/sdk/src/cli/init.js";
import { _setTransportForTesting, _resetConfigForTesting } from "../../../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../../../packages/sdk/src/init-client.js";

const tempDirs: string[] = [];

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-disc1565-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  fs.writeFileSync(path.join(dir, "next.config.ts"), "export default {};\n");
  return dir;
}

const SUCCESS_RESPONSE = {
  config: {
    requestBodies: false,
    queryParamValues: false,
    envVarValues: false,
    fullConsoleOutput: false,
    importGraph: false,
    consoleErrors: false,
    errorResponseBodies: false,
  },
  subscriptionStatus: "anonymous",
  minimumSdkVersion: "0.0.0",
  apiVersion: "v1",
  tierLimits: {
    tracesPerMinute: 100,
    storageTtlHours: 48,
    maxTraceSizeBytes: 512000,
    maxConcurrentSessions: 1,
  },
};

describe("runInit — DISC-1565 partial-success exit code", () => {
  beforeEach(() => {
    _resetConfigForTesting();
    // VITEST=true is the default during vitest runs; that path skips
    // the anon-key verification network call so the test focuses on
    // the discovery-file-failure exit-code contract specifically.
    process.env["VITEST"] = "true";
    _setTransportForTesting(
      vi.fn(async (): Promise<HttpsPostJsonResult> => ({
        status: 200,
        body: SUCCESS_RESPONSE,
        raw: "",
      })) as never,
    );
  });

  afterEach(() => {
    _setTransportForTesting(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exitCode 1 when the static-discovery file write fails", async () => {
    const dir = createTmpProject();

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
      force: false,
    });

    // Primary contract: non-zero exit so the dispatcher does not print
    // "Glasstrace initialized successfully!" and CI/scripts see the
    // failure via exit code.
    expect(result.exitCode).toBe(1);

    // Failure surfaced as a warning (not error) — preserves the prior
    // wording so users still see actionable repair steps. The exit
    // code is what conveys the partial-success state.
    const matchingWarning = result.warnings.find((w) =>
      w.includes("simulated write failure (DISC-1565 test fixture)"),
    );
    expect(matchingWarning).toBeDefined();

    // No corresponding error pushed: the discovery-file failure is a
    // partial-success, not a hard error. Other init steps may still
    // emit errors independently.
    const matchingError = result.errors.find((e) =>
      e.includes("simulated write failure"),
    );
    expect(matchingError).toBeUndefined();
  });
});
