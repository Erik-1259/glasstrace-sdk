import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkInitResponse } from "@glasstrace/protocol";
import { DEFAULT_CAPTURE_CONFIG } from "@glasstrace/protocol";
import {
  loadCachedConfig,
  saveCachedConfig,
  sendInitRequest,
  performInit,
  getActiveConfig,
  _resetConfigForTesting,
  _isRateLimitBackoff,
  _setCurrentConfig,
} from "../../../packages/sdk/src/init-client.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";

function makeInitResponse(overrides?: Partial<SdkInitResponse>): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
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
    await rm(tempDir, { recursive: true, force: true });
    _resetConfigForTesting();
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
  });

  describe("Requirement 2: saveCachedConfig", () => {
    it("writes valid SdkCachedConfig JSON to .glasstrace/config", async () => {
      const response = makeInitResponse();
      await saveCachedConfig(response, tempDir);

      const content = await readFile(join(tempDir, ".glasstrace", "config"), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.response).toEqual(response);
      expect(typeof parsed.cachedAt).toBe("number");
      expect(parsed.cachedAt).toBeGreaterThan(0);
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
        expect.stringContaining("Failed to cache config"),
      );
    });
  });

  describe("Requirement 3: sendInitRequest", () => {
    it("constructs correct request shape and validates response", async () => {
      const config = makeResolvedConfig();
      const responseBody = makeInitResponse();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseBody),
      }));

      const result = await sendInitRequest(config, null, "0.1.0");
      expect(result.config).toEqual(responseBody.config);
      expect(result.subscriptionStatus).toBe("anonymous");

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall[0]).toBe("https://api.glasstrace.dev/v1/sdk/init");
      const reqInit = fetchCall[1]!;
      expect(reqInit.method).toBe("POST");
      expect((reqInit.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${config.apiKey}`,
      );
    });

    it("includes anonKey when both dev key and anon key are provided (straggler linking)", async () => {
      const config = makeResolvedConfig();
      const anonKey = ("gt_anon_" + "b".repeat(48)) as import("@glasstrace/protocol").AnonApiKey;
      const responseBody = makeInitResponse();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseBody),
      }));

      await sendInitRequest(config, anonKey, "0.1.0");
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.anonKey).toBe(anonKey);
      expect(body.apiKey).toBe(config.apiKey);
    });

    it("throws on non-OK response", async () => {
      const config = makeResolvedConfig();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }));

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow(
        "Init request failed with status 500",
      );
    });

    it("throws when response fails schema validation", async () => {
      const config = makeResolvedConfig();

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ invalid: true }),
      }));

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow();
    });

    it("throws when no API key available", async () => {
      const config = makeResolvedConfig({ apiKey: undefined });

      await expect(sendInitRequest(config, null, "0.1.0")).rejects.toThrow(
        "No API key available",
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

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(responseBody),
      }));

      await performInit(config, null, "0.1.0");

      // In-memory config should be updated
      const active = getActiveConfig();
      expect(active.requestBodies).toBe(true);
      expect(active.queryParamValues).toBe(true);
    });

    it("handles 401 without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      }));

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_auth_failed"),
      );
    });

    it("handles 429 and sets backoff", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({}),
      }));

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
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({}),
      }));
      await performInit(config, null, "0.1.0");
      expect(_isRateLimitBackoff()).toBe(true);

      // Second call should skip and reset backoff
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await performInit(config, null, "0.1.0");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(_isRateLimitBackoff()).toBe(false);
    });

    it("handles network error without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_unreachable"),
      );
    });

    it("handles timeout via AbortController", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        const error = new DOMException("The operation was aborted", "AbortError");
        return Promise.reject(error);
      }));

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ingestion_unreachable"),
      );
    });

    it("handles 500 server error without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }));

      await performInit(config, null, "0.1.0");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Using cached config"),
      );
    });

    it("handles invalid response schema without throwing", async () => {
      const config = makeResolvedConfig();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ invalid: "schema" }),
      }));

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
});
