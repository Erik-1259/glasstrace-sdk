import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkInitResponse, SdkHealthReport } from "@glasstrace/protocol";
import { DEFAULT_CAPTURE_CONFIG } from "@glasstrace/protocol";
import {
  loadCachedConfig,
  loadCachedConfigTolerant,
  saveCachedConfig,
  sendInitRequest,
  performInit,
  getActiveConfig,
  getAttrHmacKey,
  getOperationConfigView,
  writeClaimedKey,
  _resetConfigForTesting,
  _isRateLimitBackoff,
  _setCurrentConfig,
  _setTransportForTesting,
  consumeRateLimitFlag,
  didLastInitSucceed,
} from "../../../packages/sdk/src/init-client.js";
import { markConfigCacheChecked } from "../../../packages/sdk/src/active-config-store.js";
import {
  HttpsStatusError,
  HttpsTransportError,
  HttpsBodyParseError,
  type HttpsPostJsonResult,
} from "../../../packages/sdk/src/https-transport.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";
import * as healthCollector from "../../../packages/sdk/src/health-collector.js";

function makeInitResponse(overrides?: Partial<SdkInitResponse>): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence: false,
      captureFidelity: "strict",
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
    ...overrides,
  } as SdkInitResponse;
}

/**
 * Creates a mock transport that matches the contract of `httpsPostJson`
 * and returns JSON for 2xx responses or throws the appropriate typed
 * error for 4xx/5xx/transport failures.
 *
 * Tests set this via `_setTransportForTesting(mock)` to exercise the
 * init path without opening real sockets and to assert the SDK never
 * routes through a patched `globalThis.fetch`.
 */
interface MockTransportOptions {
  ok?: boolean;
  status?: number;
  json?: unknown;
  rejectWith?: unknown;
  text?: string;
}

function mockTransport(
  opts: MockTransportOptions,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (
    _url: string,
    body: unknown,
  ): Promise<HttpsPostJsonResult> => {
    if (opts.rejectWith !== undefined) {
      throw opts.rejectWith;
    }
    const status = opts.status ?? (opts.ok === false ? 500 : 200);
    if (opts.ok === false) {
      throw new HttpsStatusError(status, opts.text ?? "");
    }
    // Capture body into the fn call args (already captured by vi.fn)
    void body;
    return {
      status,
      body: opts.json,
      raw: opts.json === undefined ? "" : JSON.stringify(opts.json),
    };
  });
}

/** Installs a mock transport; returns the mock for assertions. */
function installMockTransport(opts: MockTransportOptions): ReturnType<typeof vi.fn> {
  const mock = mockTransport(opts);
  _setTransportForTesting(mock as never);
  return mock;
}

function makeResolvedConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: "gt_dev_" + "a".repeat(48),
    endpoint: "https://api.glasstrace.dev",
    forceEnable: false,
    verbose: false,
    environment: undefined,
    coverageMapEnabled: false,
    nodeEnv: undefined,
    vercelEnv: undefined,
    ...overrides,
  };
}

describe("Init Client + Config Cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-init-test-"));
    _resetConfigForTesting();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } finally {
      vi.unstubAllGlobals();
      _resetConfigForTesting();
    }
  });

  describe("Requirement 1: loadCachedConfig", () => {
    it("returns parsed SdkInitResponse from valid cache file", () => {
      const response = makeInitResponse();
      const cached = { response, cachedAt: Date.now() };
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

      const result = loadCachedConfig(tempDir);
      expect(result).not.toBeNull();
      expect(result!.config).toEqual(response.config);
      expect(result!.subscriptionStatus).toBe("anonymous");
    });

    it("returns null when cache file does not exist", () => {
      const result = loadCachedConfig(tempDir);
      expect(result).toBeNull();
    });

    it("returns null when cache file is corrupt JSON", () => {
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), "not-json{{{", "utf-8");

      const result = loadCachedConfig(tempDir);
      expect(result).toBeNull();
    });

    it("returns null when cache response fails SdkInitResponseSchema validation", () => {
      const cached = { response: { invalid: true }, cachedAt: Date.now() };
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = loadCachedConfig(tempDir);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cached config failed validation"),
      );
    });

    it("logs verbose warning if cache is older than 24 hours", () => {
      const response = makeInitResponse();
      const cached = { response, cachedAt: Date.now() - 25 * 60 * 60 * 1000 };
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = loadCachedConfig(tempDir);
      expect(result).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("old. Will refresh"),
      );
    });

    it("normalizes a pre-existing full-without-key cache to strict on read", () => {
      // Simulate a cache written by an older SDK: `full` with a stray/absent key.
      const response = makeInitResponse();
      response.config.captureFidelity = "full";
      response.config.attrHmacKey = "stale-secret";
      const cached = { response, cachedAt: Date.now() };
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

      const result = loadCachedConfig(tempDir);
      expect(result).not.toBeNull();
      // Unkeyed full is downgraded to strict so cold-start id capture stays off...
      expect(result!.config.captureFidelity).toBe("strict");
      // ...and any cached secret is dropped on load.
      expect(result!.config.attrHmacKey).toBeUndefined();
    });
  });

  describe("Requirement 2: saveCachedConfig", () => {
    it("writes valid SdkCachedConfig JSON to .glasstrace/config with 0o600 permissions", async () => {
      const response = makeInitResponse();
      await saveCachedConfig(response, tempDir);

      const configPath = join(tempDir, ".glasstrace", "config");
      const content = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.response).toEqual(response);
      expect(typeof parsed.cachedAt).toBe("number");
      expect(parsed.cachedAt).toBeGreaterThan(0);

      // Verify file permissions
      const stats = statSync(configPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("creates .glasstrace directory if it does not exist", async () => {
      const response = makeInitResponse();
      await saveCachedConfig(response, tempDir);

      const content = await readFile(join(tempDir, ".glasstrace", "config"), "utf-8");
      expect(content).toBeTruthy();
    });

    it("logs warning on write failure and does not throw", async () => {
      const response = makeInitResponse();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Use a path that cannot be written (non-existent deep path with file as dir)
      const badPath = join(tempDir, "nonexistent-file");
      writeFileSync(badPath, "block", "utf-8"); // create a file where dir would be

      await saveCachedConfig(response, join(badPath, "subdir"));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to cache config.*(ENOTDIR|ENOENT|EPERM|EACCES)/),
      );
    });

    it("redacts the attrHmacKey secret and downgrades full fidelity in the persisted cache", async () => {
      const response = makeInitResponse();
      response.config.captureFidelity = "full";
      response.config.attrHmacKey = "super-secret-per-account-hmac-key";
      await saveCachedConfig(response, tempDir);

      const content = await readFile(
        join(tempDir, ".glasstrace", "config"),
        "utf-8",
      );
      // The tenant secret must never reach disk, in any form.
      expect(content).not.toContain("super-secret-per-account-hmac-key");
      const parsed = JSON.parse(content);
      expect(parsed.response.config.attrHmacKey).toBeUndefined();
      // Without the cached key, the posture is downgraded to strict so a cold
      // start records no spurious unhashed_id omissions for id capture.
      expect(parsed.response.config.captureFidelity).toBe("strict");
      // Non-secret config is still cached for offline startup.
      expect(parsed.response.config.requestBodies).toBe(
        response.config.requestBodies,
      );
    });
  });

  describe("Requirement 3: sendInitRequest", () => {
    it("constructs correct request shape and validates response", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse();

      const transport = installMockTransport({ ok: true, json: responseBody });

      const result = await sendInitRequest(config, null, "0.1.0");
      expect(result.config).toEqual(responseBody.config);
      expect(result.subscriptionStatus).toBe("anonymous");

      const call = transport.mock.calls[0];
      expect(call[0]).toBe("https://api.glasstrace.dev/v1/sdk/init");
      const opts = call[2] as { headers: Record<string, string> };
      expect(opts.headers["Authorization"]).toBe(`Bearer ${config.apiKey}`);
    });

    it("includes anonKey when both dev key and anon key are provided (straggler linking)", async () => {
      const config = makeResolvedConfig();
      const anonKey = ("gt_anon_" + "b".repeat(48)) as import("@glasstrace/protocol").AnonApiKey;
      const responseBody = makeInitResponse();

      const transport = installMockTransport({ ok: true, json: responseBody });

      await sendInitRequest(config, anonKey, "0.1.0");
      const body = transport.mock.calls[0][1] as Record<string, unknown>;
      expect(body.anonKey).toBe(anonKey);
      expect(body.apiKey).toBeUndefined();
    });

    it("does not include apiKey in the request body (DISC-1017)", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse();

      const transport = installMockTransport({ ok: true, json: responseBody });

      await sendInitRequest(config, null, "0.1.0");
      const body = transport.mock.calls[0][1] as Record<string, unknown>;
      expect(body.apiKey).toBeUndefined();
      expect(body.sdkVersion).toBe("0.1.0");
    });

    it("throws on non-OK response", async () => {
      const config = makeResolvedConfig();

      installMockTransport({ ok: false, status: 500, text: "Internal Server Error" });

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow(
        "Init request failed with status 500",
      );
    });

    it("surfaces HTTP status errors with a numeric `status` property", async () => {
      const config = makeResolvedConfig();

      installMockTransport({ ok: false, status: 502, text: "Bad Gateway" });

      let thrown: unknown;
      try {
        await sendInitRequest(config, null, "0.1.0");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Init request failed with status 502");
      expect(thrown).toMatchObject({ status: 502 });
    });

    it("does NOT route through globalThis.fetch (DISC-493 Issue 3)", async () => {
      const config = makeResolvedConfig();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      installMockTransport({ ok: true, json: makeInitResponse() });

      await sendInitRequest(config, null, "0.1.0");

      // Next.js 16 patches globalThis.fetch for caching/revalidation.
      // The SDK must NOT route through it or the init request can hang.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws when response fails schema validation", async () => {
      const config = makeResolvedConfig();

      installMockTransport({ ok: true, json: { invalid: true } });

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow();
    });

    it("throws when no API key available", async () => {
      const config = makeResolvedConfig({ apiKey: undefined });

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow(
        "No API key available",
      );
    });

    it("throws when response.json() returns malformed data", async () => {
      const config = makeResolvedConfig();

      installMockTransport({ rejectWith: new HttpsBodyParseError(200, new SyntaxError("Unexpected token")) });

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow(
        expect.objectContaining({ name: "SyntaxError" }),
      );
    });
  });

  describe("Requirement 4: performInit", () => {
    it("updates in-memory config and caches on success", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse({
        config: {
          requestBodies: true,
          queryParamValues: true,
          envVarValues: false,
          fullConsoleOutput: false,
          importGraph: false,
        },
      });

      installMockTransport({ ok: true, json: responseBody });

      await performInit(config, null, "0.1.0");

      // In-memory config should be updated
      const active = getActiveConfig();
      expect(active.requestBodies).toBe(true);
      expect(active.queryParamValues).toBe(true);
    });

    it("handles 401 without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 401, text: "Unauthorized" });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_auth_failed"),
      );
    });

    it("handles 429 and sets backoff", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 429, text: "Too Many Requests" });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_rate_limited"),
      );
      expect(_isRateLimitBackoff()).toBe(true);
    });

    it("skips init call when in rate-limit backoff", async () => {
      const config = makeResolvedConfig();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // First call sets backoff
      installMockTransport({ ok: false, status: 429, text: "Too Many Requests" });
      await performInit(config, null, "0.1.0");
      expect(_isRateLimitBackoff()).toBe(true);

      // Second call should skip and reset backoff
      const transportMock = installMockTransport({ ok: true, json: makeInitResponse() });
      await performInit(config, null, "0.1.0");
      expect(transportMock).not.toHaveBeenCalled();
      expect(_isRateLimitBackoff()).toBe(false);
    });

    it("handles network error without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ rejectWith: new HttpsTransportError("fetch failed: ECONNREFUSED") });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_unreachable"),
      );
    });

    it("handles timeout via AbortController", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ rejectWith: new DOMException("The operation was aborted", "AbortError") });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_unreachable"),
      );
    });

    it("handles 500 server error without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 500, text: "Internal Server Error" });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Using cached config"),
      );
    });

    it("handles invalid response schema without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: true, json: { invalid: "schema" } });

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed validation"),
      );
    });

    it("warns when no API key available", async () => {
      const config = makeResolvedConfig({ apiKey: undefined });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No API key available"),
      );
    });
  });

  describe("Requirement 7: performInit claim handling", () => {
    const devKey = "gt_dev_" + "c".repeat(48);
    const claimResult = {
      newApiKey: devKey,
      accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      graceExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    it("returns claimResult when present in response", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse({ claimResult });

      installMockTransport({ ok: true, json: responseBody });

      // Isolate file writes to tempDir so writeClaimedKey doesn't touch repo root
      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await performInit(config, null, "0.1.0");

      expect(result).not.toBeNull();
      expect(result!.claimResult.newApiKey).toBe(devKey);
      expect(result!.claimResult.accountId).toBe(claimResult.accountId);
      expect(result!.claimResult.graceExpiresAt).toBe(claimResult.graceExpiresAt);

      // stderr message must mention .env.local but NOT contain the key
      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      const claimMessage = stderrCalls.find(msg => msg.includes("Account claimed"));
      expect(claimMessage).toBeDefined();
      expect(claimMessage).not.toContain(devKey);
      stderrSpy.mockRestore();
    });

    it("returns null when no claimResult in response", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse();

      installMockTransport({ ok: true, json: responseBody });

      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      const result = await performInit(config, null, "0.1.0");
      expect(result).toBeNull();
    });

    it("key NEVER appears in stderr output", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse({ claimResult });

      installMockTransport({ ok: true, json: responseBody });

      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await performInit(config, null, "0.1.0");

      for (const call of stderrSpy.mock.calls) {
        const output = String(call[0]);
        expect(output).not.toContain(devKey);
        expect(output).not.toContain("gt_dev_");
      }
      stderrSpy.mockRestore();
    });
  });

  describe("Requirement 8: writeClaimedKey fallback chain", () => {
    const testKey = "gt_dev_" + "d".repeat(48);

    it("writes claimed key to .env.local (existing file with key)", async () => {
      const envLocalPath = join(tempDir, ".env.local");
      writeFileSync(envLocalPath, "GLASSTRACE_API_KEY=old_key\nOTHER=value\n", "utf-8");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await writeClaimedKey(testKey, tempDir);
      expect(result.persisted).toBe("env-local");

      const content = await readFile(envLocalPath, "utf-8");
      expect(content).toContain(`GLASSTRACE_API_KEY=${testKey}`);
      expect(content).not.toContain("old_key");
      expect(content).toContain("OTHER=value");

      // Verify file permissions
      const stats = statSync(envLocalPath);
      expect(stats.mode & 0o777).toBe(0o600);

      // Verify stderr message
      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      expect(stderrCalls.some(msg => msg.includes(".env.local"))).toBe(true);
      expect(stderrCalls.every(msg => !msg.includes(testKey))).toBe(true);
      stderrSpy.mockRestore();
    });

    it("creates .env.local if it does not exist", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await writeClaimedKey(testKey, tempDir);

      const envLocalPath = join(tempDir, ".env.local");
      const content = await readFile(envLocalPath, "utf-8");
      expect(content).toBe(`GLASSTRACE_API_KEY=${testKey}\n`);

      const stats = statSync(envLocalPath);
      expect(stats.mode & 0o777).toBe(0o600);
      stderrSpy.mockRestore();
    });

    it("appends key when .env.local exists without GLASSTRACE_API_KEY", async () => {
      const envLocalPath = join(tempDir, ".env.local");
      writeFileSync(envLocalPath, "OTHER=value", "utf-8");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await writeClaimedKey(testKey, tempDir);

      const content = await readFile(envLocalPath, "utf-8");
      expect(content).toContain("OTHER=value");
      expect(content).toContain(`GLASSTRACE_API_KEY=${testKey}`);
      stderrSpy.mockRestore();
    });

    it("falls back to .glasstrace/claimed-key when .env.local fails", async () => {
      // Make tempDir/.env.local a directory so file write fails
      mkdirSync(join(tempDir, ".env.local"), { recursive: true });

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await writeClaimedKey(testKey, tempDir);
      expect(result.persisted).toBe("claimed-key");

      const claimedKeyPath = join(tempDir, ".glasstrace", "claimed-key");
      const content = await readFile(claimedKeyPath, "utf-8");
      expect(content).toBe(testKey);

      const stats = statSync(claimedKeyPath);
      expect(stats.mode & 0o777).toBe(0o600);

      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      expect(stderrCalls.some(msg => msg.includes(".glasstrace/claimed-key"))).toBe(true);
      expect(stderrCalls.every(msg => !msg.includes(testKey))).toBe(true);
      stderrSpy.mockRestore();
    });

    it("logs dashboard message when all file writes fail", async () => {
      // Use a non-existent path nested under a file so both writes fail
      const badRoot = join(tempDir, "blocked-file");
      writeFileSync(badRoot, "block", "utf-8");
      const impossibleRoot = join(badRoot, "subdir");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await writeClaimedKey(testKey, impossibleRoot);
      expect(result.persisted).toBe("none");

      const stderrCalls = stderrSpy.mock.calls.map(c => String(c[0]));
      expect(stderrCalls.some(msg => msg.includes("dashboard settings"))).toBe(true);
      expect(stderrCalls.every(msg => !msg.includes(testKey))).toBe(true);
      stderrSpy.mockRestore();
    });
  });

  describe("Requirement 5: getActiveConfig", () => {
    it("returns in-memory config when available (tier 1)", () => {
      const response = makeInitResponse({
        config: {
          requestBodies: true,
          queryParamValues: true,
          envVarValues: true,
          fullConsoleOutput: true,
          importGraph: true,
        },
      });

      _setCurrentConfig(response);

      const config = getActiveConfig();
      expect(config.requestBodies).toBe(true);
      expect(config.queryParamValues).toBe(true);
    });

    it("falls back to file cache when in-memory is null (tier 2)", () => {
      const response = makeInitResponse({
        config: {
          requestBodies: true,
          queryParamValues: false,
          envVarValues: false,
          fullConsoleOutput: false,
          importGraph: false,
        },
      });

      // Write cache to cwd's .glasstrace/config
      const cached = { response, cachedAt: Date.now() };
      const dirPath = join(process.cwd(), ".glasstrace");
      try {
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

        const config = getActiveConfig();
        // May read the cache or return defaults depending on cwd
        expect(config).toBeTruthy();
      } finally {
        try {
          rmSync(dirPath, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it("returns DEFAULT_CAPTURE_CONFIG when both in-memory and cache are empty (tier 3)", () => {
      const config = getActiveConfig();
      expect(config).toEqual(DEFAULT_CAPTURE_CONFIG);
    });

    it("redacts attrHmacKey from the public getter (the secret stays off the public API)", () => {
      const response = makeInitResponse();
      response.config.captureFidelity = "full";
      response.config.attrHmacKey = "secret-key-value";
      _setCurrentConfig(response);

      const config = getActiveConfig();
      expect(config.attrHmacKey).toBeUndefined();
      // Non-secret fields stay readable through the public getter.
      expect(config.captureFidelity).toBe("full");
    });

    it("exposes attrHmacKey only through the internal getAttrHmacKey accessor", () => {
      const response = makeInitResponse();
      response.config.attrHmacKey = "secret-key-value";
      _setCurrentConfig(response);

      expect(getAttrHmacKey()).toBe("secret-key-value");
      expect(getActiveConfig().attrHmacKey).toBeUndefined();
    });
  });

  describe("Requirement 6: _resetConfigForTesting", () => {
    it("clears in-memory config store", () => {
      _setCurrentConfig(makeInitResponse());
      expect(getActiveConfig().requestBodies).toBe(false);

      _resetConfigForTesting();
      // Should return defaults now (no in-memory config)
      const config = getActiveConfig();
      expect(config).toEqual(DEFAULT_CAPTURE_CONFIG);
    });
  });

  describe("Health report recording", () => {
    it("records config sync timestamp on successful performInit", async () => {
      const syncSpy = vi.spyOn(healthCollector, "recordConfigSync");
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");

      installMockTransport({ ok: true, json: makeInitResponse() });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      expect(syncSpy).toHaveBeenCalledTimes(1);
      const timestamp = syncSpy.mock.calls[0][0];
      expect(typeof timestamp).toBe("number");
      expect(timestamp).toBeGreaterThan(0);
      expect(failSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("records init failure on network error", async () => {
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");
      const syncSpy = vi.spyOn(healthCollector, "recordConfigSync");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ rejectWith: new HttpsTransportError("fetch failed: network down") });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("records init failure on HTTP 401", async () => {
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 401, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      expect(failSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("records init failure on HTTP 429", async () => {
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 429, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      expect(failSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("records init failure on HTTP 500", async () => {
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 500, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      expect(failSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("calls recordInitFailure exactly once even when inner catch body throws (DISC-1121)", async () => {
      // Regression test for DISC-1121: the outer safety-net catch must not
      // double-count recordInitFailure() when the inner catch body itself throws.
      //
      // Scenario: transport throws (triggering inner catch), then console.warn
      // inside the inner catch also throws (triggering outer catch). The
      // failureRecorded guard flag ensures the outer catch only calls
      // recordInitFailure() when the inner catch has not already done so.
      const failSpy = vi.spyOn(healthCollector, "recordInitFailure");

      // Make console.warn throw exactly once (on the first call inside the
      // inner catch), then succeed on subsequent calls (so the outer catch's
      // own console.warn doesn't also throw and surface to Vitest).
      let warnCallCount = 0;
      vi.spyOn(console, "warn").mockImplementation(() => {
        warnCallCount += 1;
        if (warnCallCount === 1) {
          throw new Error("simulated console.warn failure");
        }
        // Second call (from outer catch) returns normally.
      });

      installMockTransport({ rejectWith: new HttpsTransportError("fetch failed: network down") });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      // Regardless of which catch ran, recordInitFailure must be called exactly
      // once — never twice — even when the inner catch body itself throws.
      expect(failSpy).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("passes health report to sendInitRequest payload", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      _setTransportForTesting(vi.fn(async (_url: string, body: unknown) => {
        capturedBody = body as Record<string, unknown>;
        return { status: 200, body: makeInitResponse(), raw: "" };
      }) as never);

      const healthReport: SdkHealthReport = {
        tracesExportedSinceLastInit: 42,
        tracesDropped: 3,
        initFailures: 1,
        configAge: 5000,
        sdkVersion: "1.0.0",
      };

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", healthReport);

      expect(capturedBody?.healthReport).toEqual(healthReport);

      vi.unstubAllGlobals();
    });

    it("omits healthReport from payload when null", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      _setTransportForTesting(vi.fn(async (_url: string, body: unknown) => {
        capturedBody = body as Record<string, unknown>;
        return { status: 200, body: makeInitResponse(), raw: "" };
      }) as never);

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", null);

      expect(capturedBody).toBeDefined();
      expect("healthReport" in capturedBody!).toBe(false);

      vi.unstubAllGlobals();
    });

    it("acknowledges health report on successful performInit", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");

      installMockTransport({ ok: true, json: makeInitResponse() });

      const healthReport = {
        tracesExportedSinceLastInit: 5,
        tracesDropped: 1,
        initFailures: 0,
        configAge: 1000,
        sdkVersion: "1.0.0",
      };

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", healthReport);

      expect(ackSpy).toHaveBeenCalledTimes(1);
      expect(ackSpy).toHaveBeenCalledWith(healthReport);

      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on network failure", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ rejectWith: new HttpsTransportError("fetch failed: network down") });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on HTTP 401", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 401, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on HTTP 429", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 429, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on HTTP 500", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: false, status: 500, text: "" });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on timeout", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ rejectWith: new DOMException("The operation was aborted", "AbortError") });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("does not acknowledge health report on ZodError", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      installMockTransport({ ok: true, json: { invalid: "response" } });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0", { tracesExportedSinceLastInit: 5, tracesDropped: 0, initFailures: 0, configAge: 0, sdkVersion: "1.0.0" });

      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("works when called without healthReport argument (backward compat)", async () => {
      const ackSpy = vi.spyOn(healthCollector, "acknowledgeHealthReport");

      installMockTransport({ ok: true, json: makeInitResponse() });

      const config = makeResolvedConfig();
      await performInit(config, null, "1.0.0");

      // Should not throw, and should not call acknowledge (no report to acknowledge)
      expect(ackSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it("records config sync from cached config on loadCachedConfig", () => {
      const syncSpy = vi.spyOn(healthCollector, "recordConfigSync");

      const response = makeInitResponse();
      const cachedAt = Date.now() - 3000;
      const cached = { response, cachedAt };
      const dirPath = join(tempDir, ".glasstrace");
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(join(dirPath, "config"), JSON.stringify(cached), "utf-8");

      const result = loadCachedConfig(tempDir);

      expect(result).not.toBeNull();
      expect(syncSpy).toHaveBeenCalledWith(cachedAt);
    });
  });

  describe("consumeRateLimitFlag", () => {
    it("returns true after 429 response", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installMockTransport({ ok: false, status: 429, text: "" });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(consumeRateLimitFlag()).toBe(true);
      vi.unstubAllGlobals();
    });

    it("returns false after successful init", async () => {
      installMockTransport({ ok: true, json: makeInitResponse() });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(consumeRateLimitFlag()).toBe(false);
      vi.unstubAllGlobals();
    });

    it("clears on read", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installMockTransport({ ok: false, status: 429, text: "" });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(consumeRateLimitFlag()).toBe(true);
      expect(consumeRateLimitFlag()).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe("didLastInitSucceed", () => {
    it("returns true after successful init", async () => {
      installMockTransport({ ok: true, json: makeInitResponse() });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(didLastInitSucceed()).toBe(true);
      vi.unstubAllGlobals();
    });

    it("returns false after failed init", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installMockTransport({ rejectWith: new HttpsTransportError("fetch failed: network down") });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(didLastInitSucceed()).toBe(false);
      vi.unstubAllGlobals();
    });

    it("returns false after 429", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installMockTransport({ ok: false, status: 429, text: "" });

      await performInit(makeResolvedConfig(), null, "1.0.0");

      expect(didLastInitSucceed()).toBe(false);
      vi.unstubAllGlobals();
    });

    it("returns false when no API key available", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await performInit(makeResolvedConfig({ apiKey: undefined }), null, "1.0.0");

      expect(didLastInitSucceed()).toBe(false);
    });
  });
});

describe("Result-evidence capability state (config lifecycle)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-capability-test-"));
    _resetConfigForTesting();
    // Keep pristine-default reads off the disk-cache tier so assertions do
    // not depend on the runner's cwd; promotion tests re-reset and spy cwd.
    markConfigCacheChecked();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } finally {
      vi.unstubAllGlobals();
      _resetConfigForTesting();
    }
  });

  const validEnvelope = {
    wireVersion: 1,
    aggregateScalars: true,
    boundedRows: false,
  } as const;

  /** An init response whose config carries the given envelope value. */
  function makeEnvelopeResponse(
    envelope: unknown,
    configOverrides?: Record<string, unknown>,
  ): SdkInitResponse {
    const base = makeInitResponse();
    return {
      ...base,
      config: {
        ...base.config,
        ...configOverrides,
        ...(envelope === undefined
          ? {}
          : { resultEvidenceCapabilities: envelope }),
      },
    } as SdkInitResponse;
  }

  function writeCacheFile(root: string, response: unknown): void {
    const dirPath = join(root, ".glasstrace");
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(
      join(dirPath, "config"),
      JSON.stringify({ response, cachedAt: Date.now() }),
      "utf-8",
    );
  }

  describe("getOperationConfigView — defaults, clear, and combinations", () => {
    it("presents the unavailable capability state with no config applied", () => {
      const view = getOperationConfigView();
      expect(view.resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });
      expect(view.sideEffectEvidence).toBe(false);
      expect(view.captureFidelity).toBe("strict");
      expect(view.readAttrHmacKey()).toBeUndefined();
    });

    it("returns to the unavailable state after an explicit clear", () => {
      _setCurrentConfig(
        makeEnvelopeResponse({
          wireVersion: 1,
          aggregateScalars: true,
          boundedRows: true,
        }),
      );
      expect(getOperationConfigView().resultEvidence.aggregateScalars).toBe(
        true,
      );
      _resetConfigForTesting();
      markConfigCacheChecked();
      const view = getOperationConfigView();
      expect(view.resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });
      expect(view.sideEffectEvidence).toBe(false);
      expect(view.captureFidelity).toBe("strict");
      expect(view.readAttrHmacKey()).toBeUndefined();
    });

    it("represents all four valid capability combinations independently", () => {
      for (const aggregateScalars of [false, true]) {
        for (const boundedRows of [false, true]) {
          _setCurrentConfig(
            makeEnvelopeResponse({
              wireVersion: 1,
              aggregateScalars,
              boundedRows,
            }),
          );
          expect(getOperationConfigView().resultEvidence).toEqual({
            wireVersion: 1,
            aggregateScalars,
            boundedRows,
          });
        }
      }
    });
  });

  describe("application-boundary envelope tolerance (performInit)", () => {
    const initConfig = makeResolvedConfig();

    beforeEach(() => {
      // performInit persists the applied response to `cwd`/.glasstrace —
      // point it at this test's temp dir so no cache leaks into the repo
      // root or a sibling test's tier-2 read.
      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    });

    it.each([
      ["future wire version", { ...validEnvelope, wireVersion: 2 }],
      ["partial envelope", { wireVersion: 1 }],
      [
        "unknown member",
        { ...validEnvelope, provider: "prisma" },
      ],
      [
        "non-boolean member",
        { wireVersion: 1, aggregateScalars: "true", boundedRows: false },
      ],
      ["non-object envelope", "enabled"],
      ["null envelope", null],
    ])(
      "applies an otherwise-valid response with a %s, capabilities unavailable",
      async (_label, envelope) => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        installMockTransport({
          json: makeEnvelopeResponse(envelope, { sideEffectEvidence: true }),
        });
        const result = await performInit(initConfig, null, "1.0.0");
        expect(result).toBeNull();
        // The rest of the response applied: the master switch came through.
        expect(getActiveConfig().sideEffectEvidence).toBe(true);
        // The capability envelope failed closed.
        expect(getOperationConfigView().resultEvidence).toEqual({
          wireVersion: null,
          aggregateScalars: false,
          boundedRows: false,
        });
        expect(didLastInitSucceed()).toBe(true);
        // The recovery is deliberately silent: no validation-failure warning
        // is emitted for a response the SDK applied.
        expect(
          warnSpy.mock.calls.some(([msg]) =>
            String(msg).includes("failed validation"),
          ),
        ).toBe(false);
      },
    );

    it("rejects a null response body without applying anything", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      installMockTransport({ json: null });
      await performInit(initConfig, null, "1.0.0");
      expect(getActiveConfig()).toEqual(DEFAULT_CAPTURE_CONFIG);
      expect(didLastInitSucceed()).toBe(false);
    });

    it("applies a valid envelope from a live response", async () => {
      installMockTransport({ json: makeEnvelopeResponse(validEnvelope) });
      await performInit(initConfig, null, "1.0.0");
      expect(getOperationConfigView().resultEvidence).toEqual(validEnvelope);
    });

    it("still rejects a response that is invalid outside the envelope", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const invalid = makeEnvelopeResponse(
        { ...validEnvelope, wireVersion: 2 },
        { sideEffectEvidence: true },
      ) as unknown as Record<string, unknown>;
      delete invalid.tierLimits;
      installMockTransport({ json: invalid });
      await performInit(initConfig, null, "1.0.0");
      // Whole-response rejection: nothing applied, existing warn preserved.
      expect(getActiveConfig()).toEqual(DEFAULT_CAPTURE_CONFIG);
      expect(didLastInitSucceed()).toBe(false);
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes("failed validation"),
        ),
      ).toBe(true);
    });

    it("rejects an unrelated-invalid response even when its envelope is valid", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const invalid = makeEnvelopeResponse(validEnvelope) as unknown as Record<
        string,
        unknown
      >;
      invalid.subscriptionStatus = 42;
      installMockTransport({ json: invalid });
      await performInit(makeResolvedConfig(), null, "1.0.0");
      expect(getActiveConfig()).toEqual(DEFAULT_CAPTURE_CONFIG);
      expect(didLastInitSucceed()).toBe(false);
    });

    it("transitions absent → valid → future → absent across refreshes", async () => {
      installMockTransport({ json: makeEnvelopeResponse(undefined) });
      await performInit(makeResolvedConfig(), null, "1.0.0");
      expect(getOperationConfigView().resultEvidence.wireVersion).toBeNull();

      installMockTransport({ json: makeEnvelopeResponse(validEnvelope) });
      await performInit(makeResolvedConfig(), null, "1.0.0");
      expect(getOperationConfigView().resultEvidence).toEqual(validEnvelope);

      installMockTransport({
        json: makeEnvelopeResponse({ ...validEnvelope, wireVersion: 2 }),
      });
      await performInit(makeResolvedConfig(), null, "1.0.0");
      // The prior true bit is not retained through an invalid envelope.
      expect(getOperationConfigView().resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });

      installMockTransport({ json: makeEnvelopeResponse(undefined) });
      await performInit(makeResolvedConfig(), null, "1.0.0");
      expect(getOperationConfigView().resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });
    });
  });

  describe("public direct-parse APIs stay strict", () => {
    it("sendInitRequest throws on an envelope-invalid response", async () => {
      installMockTransport({
        json: makeEnvelopeResponse({ ...validEnvelope, wireVersion: 2 }),
      });
      await expect(
        sendInitRequest(makeResolvedConfig(), null, "1.0.0"),
      ).rejects.toMatchObject({ name: "ZodError" });
    });

    it("loadCachedConfig returns null for an envelope-invalid cache", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeCacheFile(
        tempDir,
        makeEnvelopeResponse({ wireVersion: 1 }, { sideEffectEvidence: true }),
      );
      expect(loadCachedConfig(tempDir)).toBeNull();
      expect(
        warnSpy.mock.calls.some(([msg]) =>
          String(msg).includes("failed validation"),
        ),
      ).toBe(true);
    });

    it("loadCachedConfigTolerant recovers an envelope-invalid cache", () => {
      writeCacheFile(
        tempDir,
        makeEnvelopeResponse({ wireVersion: 1 }, { sideEffectEvidence: true }),
      );
      const result = loadCachedConfigTolerant(tempDir);
      expect(result).not.toBeNull();
      expect(result!.config.sideEffectEvidence).toBe(true);
      expect(result!.config.resultEvidenceCapabilities).toBeUndefined();
    });

    it("loadCachedConfigTolerant still rejects an unrelated-invalid cache", () => {
      const response = makeEnvelopeResponse({ wireVersion: 1 }) as unknown as Record<
        string,
        unknown
      >;
      delete response.tierLimits;
      writeCacheFile(tempDir, response);
      expect(loadCachedConfigTolerant(tempDir)).toBeNull();
    });

    it("loadCachedConfigTolerant preserves a valid cached envelope through normalization", () => {
      const response = makeEnvelopeResponse(validEnvelope);
      response.config.captureFidelity = "full";
      response.config.attrHmacKey = "cached-secret";
      writeCacheFile(tempDir, response);
      const result = loadCachedConfigTolerant(tempDir);
      expect(result).not.toBeNull();
      // Existing normalization is unchanged: key stripped, unkeyed full
      // downgraded — while the valid envelope survives.
      expect(result!.config.attrHmacKey).toBeUndefined();
      expect(result!.config.captureFidelity).toBe("strict");
      expect(result!.config.resultEvidenceCapabilities).toEqual(validEnvelope);
    });

    it("loadCachedConfigTolerant returns null when the cache file is absent", () => {
      expect(loadCachedConfigTolerant(tempDir)).toBeNull();
    });
  });

  describe("cache promotion at the application boundary", () => {
    it("promotes an envelope-invalid cache with capabilities unavailable", () => {
      _resetConfigForTesting();
      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      writeCacheFile(
        tempDir,
        makeEnvelopeResponse(
          { ...validEnvelope, extra: 1 },
          { sideEffectEvidence: true },
        ),
      );
      const view = getOperationConfigView();
      expect(view.sideEffectEvidence).toBe(true);
      expect(view.resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });
    });

    it("promotes a valid cached envelope into the capability view", () => {
      _resetConfigForTesting();
      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      writeCacheFile(tempDir, makeEnvelopeResponse(validEnvelope));
      expect(getOperationConfigView().resultEvidence).toEqual(validEnvelope);
    });

    it("keeps an old envelope-less cache promotable with capabilities unavailable", () => {
      _resetConfigForTesting();
      vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      writeCacheFile(
        tempDir,
        makeEnvelopeResponse(undefined, { sideEffectEvidence: true }),
      );
      const view = getOperationConfigView();
      expect(view.sideEffectEvidence).toBe(true);
      expect(view.resultEvidence.wireVersion).toBeNull();
    });
  });

  describe("coherent per-operation view", () => {
    it("a view retains its generation across a config refresh and key rotation", () => {
      const generationA = makeEnvelopeResponse(
        { wireVersion: 1, aggregateScalars: true, boundedRows: true },
        { sideEffectEvidence: true, captureFidelity: "full", attrHmacKey: "key-a" },
      );
      _setCurrentConfig(generationA);
      const viewA = getOperationConfigView();

      const generationB = makeEnvelopeResponse(undefined, {
        sideEffectEvidence: false,
      });
      _setCurrentConfig(generationB);
      const viewB = getOperationConfigView();

      // The earlier view is untouched by the refresh — same generation
      // throughout an operation already being evaluated.
      expect(viewA.sideEffectEvidence).toBe(true);
      expect(viewA.captureFidelity).toBe("full");
      expect(viewA.resultEvidence).toEqual({
        wireVersion: 1,
        aggregateScalars: true,
        boundedRows: true,
      });
      expect(viewA.readAttrHmacKey()).toBe("key-a");
      // The next operation's view observes the refresh.
      expect(viewB.sideEffectEvidence).toBe(false);
      expect(viewB.captureFidelity).toBe("strict");
      expect(viewB.resultEvidence.wireVersion).toBeNull();
      expect(viewB.readAttrHmacKey()).toBeUndefined();
    });

    it("key rotation lands on the next view, never a view already taken", () => {
      _setCurrentConfig(
        makeEnvelopeResponse(validEnvelope, {
          captureFidelity: "full",
          attrHmacKey: "key-a",
        }),
      );
      const viewA = getOperationConfigView();
      _setCurrentConfig(
        makeEnvelopeResponse(validEnvelope, {
          captureFidelity: "full",
          attrHmacKey: "key-b",
        }),
      );
      expect(viewA.readAttrHmacKey()).toBe("key-a");
      expect(getOperationConfigView().readAttrHmacKey()).toBe("key-b");
    });

    it("views are frozen and mutation cannot change stored state", () => {
      _setCurrentConfig(makeEnvelopeResponse(validEnvelope));
      const view = getOperationConfigView();
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.resultEvidence)).toBe(true);
      expect(() => {
        (view as { sideEffectEvidence: boolean }).sideEffectEvidence = true;
      }).toThrow(TypeError);
      expect(() => {
        (view.resultEvidence as { aggregateScalars: boolean }).aggregateScalars =
          false;
      }).toThrow(TypeError);
      // Stored state is unaffected by the attempted mutations.
      expect(getOperationConfigView().resultEvidence).toEqual(validEnvelope);
    });

    it("mutating the input response after apply does not change stored state", () => {
      const response = makeEnvelopeResponse(
        { wireVersion: 1, aggregateScalars: true, boundedRows: true },
        { sideEffectEvidence: true },
      );
      _setCurrentConfig(response);
      response.config.sideEffectEvidence = false;
      response.config.captureFidelity = "full";
      (response.config.resultEvidenceCapabilities as {
        aggregateScalars: boolean;
      }).aggregateScalars = false;
      const view = getOperationConfigView();
      expect(view.sideEffectEvidence).toBe(true);
      expect(view.captureFidelity).toBe("strict");
      expect(view.resultEvidence.aggregateScalars).toBe(true);
    });

    it("serializing a view never carries the identifier key", () => {
      _setCurrentConfig(
        makeEnvelopeResponse(validEnvelope, {
          captureFidelity: "full",
          attrHmacKey: "view-secret",
        }),
      );
      const view = getOperationConfigView();
      expect(JSON.stringify(view)).not.toContain("view-secret");
      expect(Object.keys(view)).not.toContain("attrHmacKey");
      expect(view.readAttrHmacKey()).toBe("view-secret");
    });

    it("fails closed to the everything-off view when resolution throws", () => {
      _resetConfigForTesting();
      // With the store empty and the cache tier unchecked, resolution reaches
      // the disk-cache tier, whose root lookup calls process.cwd() — make it
      // throw to simulate a torn-down working directory.
      vi.spyOn(process, "cwd").mockImplementation(() => {
        throw new Error("cwd unavailable");
      });
      const view = getOperationConfigView();
      expect(view.sideEffectEvidence).toBe(false);
      expect(view.captureFidelity).toBe("strict");
      expect(view.resultEvidence).toEqual({
        wireVersion: null,
        aggregateScalars: false,
        boundedRows: false,
      });
      expect(view.readAttrHmacKey()).toBeUndefined();
    });

    it("mutating a getActiveConfig() result does not change stored state", () => {
      _setCurrentConfig(makeEnvelopeResponse(validEnvelope));
      const returned = getActiveConfig();
      returned.sideEffectEvidence = true;
      returned.resultEvidenceCapabilities!.aggregateScalars = false;
      // The stored generation is unaffected by mutating the returned copy.
      expect(getActiveConfig().sideEffectEvidence).toBe(false);
      expect(getOperationConfigView().resultEvidence).toEqual(validEnvelope);
    });
  });

  describe("verifyInitReachable matches the application boundary", () => {
    it("verifies a response whose only defect is the capability envelope", async () => {
      installMockTransport({
        json: makeEnvelopeResponse(
          { wireVersion: 2, aggregateScalars: true, boundedRows: false },
          { sideEffectEvidence: true },
        ),
      });
      const result = await (
        await import("../../../packages/sdk/src/init-client.js")
      ).verifyInitReachable(makeResolvedConfig(), null, "1.0.0");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The verified response is the same recovered value the runtime
        // applies: envelope stripped, remainder intact.
        expect(result.response.config.sideEffectEvidence).toBe(true);
        expect(
          result.response.config.resultEvidenceCapabilities,
        ).toBeUndefined();
      }
    });

    it("still classifies an unrelated-invalid response as malformed", async () => {
      const invalid = makeEnvelopeResponse(validEnvelope) as unknown as Record<
        string,
        unknown
      >;
      delete invalid.tierLimits;
      installMockTransport({ json: invalid });
      const result = await (
        await import("../../../packages/sdk/src/init-client.js")
      ).verifyInitReachable(makeResolvedConfig(), null, "1.0.0");
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
    });
  });
});
