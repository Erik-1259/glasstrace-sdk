/**
 * CLI init — verifyAnonKeyRegistration tests (DISC-493 Issue 3, DISC-494)
 *
 * These tests exercise the blocking init-verification step that runs at
 * the end of `runInit`. The goal is to prove that:
 *   1. When the init request succeeds, `runInit` reports success.
 *   2. When the server rejects the key, `runInit` exits non-zero with a
 *      message distinguishing "server rejected".
 *   3. When the transport fails, `runInit` exits non-zero with a message
 *      distinguishing "fetch failed".
 *   4. When the server returns a malformed response, `runInit` exits
 *      non-zero with a message distinguishing "malformed".
 *   5. The anonymous key never appears in any error message.
 *
 * Verification is gated by the VITEST env var so most other tests skip
 * it automatically — these tests explicitly un-set VITEST before calling
 * `runInit` and install a transport mock to drive the behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runInit, verifyAnonKeyRegistration } from "../../../../packages/sdk/src/cli/init.js";
import {
  _setTransportForTesting,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import {
  HttpsStatusError,
  HttpsTransportError,
  HttpsBodyParseError,
  type HttpsPostJsonResult,
} from "../../../../packages/sdk/src/https-transport.js";

const tempDirs: string[] = [];

function createTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-init-verify-"));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  // Next.js config required by the monorepo resolver.
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

describe("runInit — blocking anon key verification (DISC-493 Issue 3 / DISC-494)", () => {
  let originalVitest: string | undefined;
  let originalCI: string | undefined;
  let originalGhActions: string | undefined;

  beforeEach(() => {
    _resetConfigForTesting();
    originalVitest = process.env["VITEST"];
    originalCI = process.env["CI"];
    originalGhActions = process.env["GITHUB_ACTIONS"];
    // Un-set VITEST so the verification step runs. Un-set CI /
    // GITHUB_ACTIONS so we hit the interactive-path code branch — both
    // are set in GitHub Actions CI and would otherwise cause isCI=true
    // and skip verification.
    delete process.env["VITEST"];
    delete process.env["CI"];
    delete process.env["GITHUB_ACTIONS"];
  });

  afterEach(() => {
    if (originalVitest !== undefined) process.env["VITEST"] = originalVitest;
    if (originalCI !== undefined) process.env["CI"] = originalCI;
    if (originalGhActions !== undefined) process.env["GITHUB_ACTIONS"] = originalGhActions;
    _setTransportForTesting(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports success when the server registers the anon key", async () => {
    const dir = createTmpProject();
    _setTransportForTesting(
      vi.fn(async (): Promise<HttpsPostJsonResult> => ({
        status: 200,
        body: SUCCESS_RESPONSE,
        raw: "",
      })) as never,
    );

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.summary).toContain("Verified anon key registration with Glasstrace API");
  });

  it("fails loudly (exit code 2, 'server rejected') when the server returns 401", async () => {
    const dir = createTmpProject();
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsStatusError(401, "Unauthorized");
      }) as never,
    );

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("server rejected");
    expect(result.errors[0]).toContain("HTTP 401");
  });

  it("distinguishes transport failures with 'fetch failed'", async () => {
    const dir = createTmpProject();
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsTransportError("fetch failed: ECONNREFUSED");
      }) as never,
    );

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toContain("fetch failed");
  });

  it("distinguishes malformed responses with 'malformed response'", async () => {
    const dir = createTmpProject();
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsBodyParseError(200, new SyntaxError("Unexpected token"));
      }) as never,
    );

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toContain("malformed response");
  });

  it("never leaks the anon key in error messages (DISC-1202-style data leak guard)", async () => {
    const dir = createTmpProject();
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsStatusError(403, "Forbidden");
      }) as never,
    );

    const result = await runInit({
      projectRoot: dir,
      yes: true,
      coverageMap: false,
    });

    // Read the generated anon key so we can assert it's not leaked.
    const keyPath = path.join(dir, ".glasstrace", "anon_key");
    expect(fs.existsSync(keyPath)).toBe(true);
    const anonKey = fs.readFileSync(keyPath, "utf-8").trim();

    expect(result.errors.some((e) => e.includes(anonKey))).toBe(false);
    // Defense in depth — the prefix alone suffices to expose the key
    // shape is present; full key must not be in any warning either.
    expect(
      result.warnings.some((w) => w.includes(anonKey)),
    ).toBe(false);
  });

  it("skips verification when GLASSTRACE_SKIP_INIT_VERIFY=1 is set", async () => {
    const dir = createTmpProject();
    // Install a spy transport — if verification runs, this will be called.
    const transport = vi.fn(async (): Promise<HttpsPostJsonResult> => ({
      status: 200,
      body: SUCCESS_RESPONSE,
      raw: "",
    }));
    _setTransportForTesting(transport as never);

    process.env["GLASSTRACE_SKIP_INIT_VERIFY"] = "1";
    try {
      const result = await runInit({
        projectRoot: dir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(0);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      delete process.env["GLASSTRACE_SKIP_INIT_VERIFY"];
    }
  });

  it("skips verification in CI mode", async () => {
    const dir = createTmpProject();
    const transport = vi.fn(async (): Promise<HttpsPostJsonResult> => ({
      status: 200,
      body: SUCCESS_RESPONSE,
      raw: "",
    }));
    _setTransportForTesting(transport as never);

    process.env["CI"] = "true";
    try {
      const result = await runInit({
        projectRoot: dir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(0);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      delete process.env["CI"];
    }
  });

  it("skips verification when GITHUB_ACTIONS=true", async () => {
    const dir = createTmpProject();
    const transport = vi.fn(async (): Promise<HttpsPostJsonResult> => ({
      status: 200,
      body: SUCCESS_RESPONSE,
      raw: "",
    }));
    _setTransportForTesting(transport as never);

    process.env["GITHUB_ACTIONS"] = "true";
    try {
      const result = await runInit({
        projectRoot: dir,
        yes: true,
        coverageMap: false,
      });
      expect(result.exitCode).toBe(0);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      delete process.env["GITHUB_ACTIONS"];
    }
  });
});

describe("verifyAnonKeyRegistration — direct function tests", () => {
  let originalVitest: string | undefined;

  beforeEach(() => {
    _resetConfigForTesting();
    originalVitest = process.env["VITEST"];
  });

  afterEach(() => {
    if (originalVitest !== undefined) process.env["VITEST"] = originalVitest;
    _setTransportForTesting(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when there is no anon key on disk (no verification needed)", async () => {
    const dir = createTmpProject();
    // No .glasstrace/anon_key yet.
    const result = await verifyAnonKeyRegistration(dir);
    expect(result).toBeNull();
  });

  it("returns null on successful server verification", async () => {
    const dir = createTmpProject();
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(
      path.join(dir, ".glasstrace", "anon_key"),
      "gt_anon_" + "f".repeat(48),
    );

    _setTransportForTesting(
      vi.fn(async (): Promise<HttpsPostJsonResult> => ({
        status: 200,
        body: SUCCESS_RESPONSE,
        raw: "",
      })) as never,
    );

    const result = await verifyAnonKeyRegistration(dir);
    expect(result).toBeNull();
  });

  it("returns a 'server rejected' error on HTTP 4xx", async () => {
    const dir = createTmpProject();
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(
      path.join(dir, ".glasstrace", "anon_key"),
      "gt_anon_" + "f".repeat(48),
    );

    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsStatusError(401, "Unauthorized");
      }) as never,
    );

    const result = await verifyAnonKeyRegistration(dir);
    expect(result).not.toBeNull();
    expect(result).toContain("server rejected");
    expect(result).toContain("HTTP 401");
  });

  it("returns a 'fetch failed' error on transport failure", async () => {
    const dir = createTmpProject();
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(
      path.join(dir, ".glasstrace", "anon_key"),
      "gt_anon_" + "f".repeat(48),
    );

    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsTransportError("fetch failed: EHOSTUNREACH");
      }) as never,
    );

    const result = await verifyAnonKeyRegistration(dir);
    expect(result).not.toBeNull();
    expect(result).toContain("fetch failed");
  });

  it("returns a 'malformed response' error on HttpsBodyParseError", async () => {
    const dir = createTmpProject();
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(
      path.join(dir, ".glasstrace", "anon_key"),
      "gt_anon_" + "f".repeat(48),
    );

    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsBodyParseError(200, new SyntaxError("bad"));
      }) as never,
    );

    const result = await verifyAnonKeyRegistration(dir);
    expect(result).not.toBeNull();
    expect(result).toContain("malformed response");
  });

  it("surfaces the three error classes as distinct, user-actionable messages", async () => {
    const dir = createTmpProject();
    fs.mkdirSync(path.join(dir, ".glasstrace"));
    fs.writeFileSync(
      path.join(dir, ".glasstrace", "anon_key"),
      "gt_anon_" + "f".repeat(48),
    );

    // Class 1: transport
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsTransportError("fetch failed: ECONNRESET");
      }) as never,
    );
    const transport = await verifyAnonKeyRegistration(dir);
    expect(transport).toContain("fetch failed");

    // Class 2: status
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsStatusError(401, "Unauthorized");
      }) as never,
    );
    const rejected = await verifyAnonKeyRegistration(dir);
    expect(rejected).toContain("server rejected");

    // Class 3: parse
    _setTransportForTesting(
      vi.fn(async () => {
        throw new HttpsBodyParseError(200, new SyntaxError("bad"));
      }) as never,
    );
    const malformed = await verifyAnonKeyRegistration(dir);
    expect(malformed).toContain("malformed response");

    // All three distinguishable.
    expect(new Set([transport, rejected, malformed]).size).toBe(3);
  });
});
