/**
 * Regression guard: API key must never appear in outbound request bodies.
 *
 * Credentials are transmitted exclusively via the `Authorization: Bearer`
 * header. This file asserts that no request body emitted by the SDK
 * functions that touch the network includes a top-level `apiKey` field.
 *
 * Covers DISC-782 (source-map-uploader) and DISC-1156 (init-client).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SdkInitResponse } from "@glasstrace/protocol";

import {
  uploadSourceMaps,
  requestPresignedTokens,
  submitManifest,
} from "../../../packages/sdk/src/source-map-uploader.js";
import {
  sendInitRequest,
  _resetConfigForTesting,
  _setTransportForTesting,
} from "../../../packages/sdk/src/init-client.js";
import type { HttpsPostJsonResult } from "../../../packages/sdk/src/https-transport.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DEV_API_KEY = "gt_dev_" + "a".repeat(48);

function makeResolvedConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    apiKey: DEV_API_KEY,
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

// ---------------------------------------------------------------------------
// source-map-uploader: uploadSourceMaps
// ---------------------------------------------------------------------------

describe("no-api-key-in-body: uploadSourceMaps", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not include apiKey as a top-level field in the request body (DISC-782)", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123",
        fileCount: 1,
        totalSizeBytes: 42,
      }),
    } as unknown as Response);

    await uploadSourceMaps(
      DEV_API_KEY,
      "https://api.glasstrace.dev",
      "abc123",
      [{ filePath: "main.js", content: '{"version":3}' }],
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string) as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
  });

  it("sends the API key only via the Authorization header (DISC-782)", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123",
        fileCount: 1,
        totalSizeBytes: 42,
      }),
    } as unknown as Response);

    await uploadSourceMaps(
      DEV_API_KEY,
      "https://api.glasstrace.dev",
      "abc123",
      [{ filePath: "main.js", content: '{"version":3}' }],
    );

    const [, options] = mockFetch.mock.calls[0];
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${DEV_API_KEY}`);
  });
});

// ---------------------------------------------------------------------------
// source-map-uploader: requestPresignedTokens
// ---------------------------------------------------------------------------

describe("no-api-key-in-body: requestPresignedTokens", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not include apiKey in the presign request body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        uploadId: "550e8400-e29b-41d4-a716-446655440000",
        expiresAt: Date.now() + 900_000,
        files: [
          {
            filePath: "main.js",
            clientToken: "token-main.js",
            pathname: "source-maps/main.js",
            maxBytes: 10_000_000,
          },
        ],
      }),
    } as unknown as Response);

    await requestPresignedTokens(
      DEV_API_KEY,
      "https://api.glasstrace.dev",
      "abc123",
      [{ filePath: "main.js", sizeBytes: 42 }],
    );

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string) as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// source-map-uploader: submitManifest
// ---------------------------------------------------------------------------

describe("no-api-key-in-body: submitManifest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not include apiKey in the manifest submission body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123",
        fileCount: 1,
        totalSizeBytes: 42,
        activatedAt: Date.now(),
      }),
    } as unknown as Response);

    await submitManifest(
      DEV_API_KEY,
      "https://api.glasstrace.dev",
      "550e8400-e29b-41d4-a716-446655440000",
      "abc123",
      [{ filePath: "main.js", sizeBytes: 42, blobUrl: "https://blob.example.com/main.js" }],
    );

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string) as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// init-client: sendInitRequest
// ---------------------------------------------------------------------------

describe("no-api-key-in-body: sendInitRequest", () => {
  afterEach(() => {
    _resetConfigForTesting();
  });

  it("does not include apiKey as a top-level field in the init request body (DISC-1156)", async () => {
    const capturedBodies: unknown[] = [];
    _setTransportForTesting(async (_url, body) => {
      capturedBodies.push(body);
      return {
        status: 200,
        body: makeInitResponse(),
        raw: JSON.stringify(makeInitResponse()),
      } satisfies HttpsPostJsonResult;
    });

    await sendInitRequest(makeResolvedConfig(), null, "0.1.0");

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
  });

  it("does not include apiKey when an anonKey is present (DISC-1156)", async () => {
    const capturedBodies: unknown[] = [];
    _setTransportForTesting(async (_url, body) => {
      capturedBodies.push(body);
      return {
        status: 200,
        body: makeInitResponse(),
        raw: JSON.stringify(makeInitResponse()),
      } satisfies HttpsPostJsonResult;
    });

    const anonKey = ("gt_anon_" + "b".repeat(48)) as import("@glasstrace/protocol").AnonApiKey;
    await sendInitRequest(makeResolvedConfig(), anonKey, "0.1.0");

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
    // anonKey for straggler linking is still sent
    expect(body.anonKey).toBe(anonKey);
  });

  it("does not include apiKey when only an anonKey is configured (no dev key)", async () => {
    const capturedBodies: unknown[] = [];
    _setTransportForTesting(async (_url, body) => {
      capturedBodies.push(body);
      return {
        status: 200,
        body: makeInitResponse(),
        raw: JSON.stringify(makeInitResponse()),
      } satisfies HttpsPostJsonResult;
    });

    const anonKey = ("gt_anon_" + "c".repeat(48)) as import("@glasstrace/protocol").AnonApiKey;
    // No dev key — only anonKey available
    await sendInitRequest(makeResolvedConfig({ apiKey: "" }), anonKey, "0.1.0");

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.apiKey).toBeUndefined();
  });
});
