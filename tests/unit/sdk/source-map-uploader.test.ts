import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  collectSourceMaps,
  computeBuildHash,
  uploadSourceMaps,
  requestPresignedTokens,
  submitManifest,
  uploadSourceMapsPresigned,
  uploadSourceMapsAuto,
  PRESIGNED_THRESHOLD_BYTES,
} from "../../../packages/sdk/src/source-map-uploader.js";
import type { BlobUploader } from "../../../packages/sdk/src/source-map-uploader.js";

describe("collectSourceMaps", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds all .map files in the build directory", async () => {
    fs.mkdirSync(path.join(tmpDir, "static", "chunks"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "static", "chunks", "main.js.map"),
      '{"version":3}',
    );
    fs.writeFileSync(
      path.join(tmpDir, "static", "chunks", "vendor.js.map"),
      '{"version":3,"sources":[]}',
    );

    const maps = await collectSourceMaps(tmpDir);
    expect(maps).toHaveLength(2);
    // filePath uses the compiled JS path (not the .map path) so it matches
    // stack-frame lookups at runtime
    expect(maps.map((m) => m.filePath).sort()).toEqual([
      "static/chunks/main.js",
      "static/chunks/vendor.js",
    ]);
  });

  it("returns relative paths and file contents", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "app.js.map"),
      '{"version":3,"file":"app.js"}',
    );

    const maps = await collectSourceMaps(tmpDir);
    expect(maps).toHaveLength(1);
    expect(maps[0].filePath).toBe("app.js");
    expect(maps[0].content).toBe('{"version":3,"file":"app.js"}');
  });

  it("error case: no .map files found returns empty array", async () => {
    fs.writeFileSync(path.join(tmpDir, "main.js"), "console.log('hi')");

    const maps = await collectSourceMaps(tmpDir);
    expect(maps).toEqual([]);
  });

  it("error case: non-existent directory returns empty array", async () => {
    const maps = await collectSourceMaps(
      path.join(tmpDir, "nonexistent"),
    );
    expect(maps).toEqual([]);
  });
});

describe("computeBuildHash", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it("returns git SHA when git is available", async () => {
    vi.mocked(execSync).mockReturnValueOnce("abc123def456\n");

    const hash = await computeBuildHash();
    expect(hash).toBe("abc123def456");
  });

  it("falls back to content hash when git fails", async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });

    const maps = [
      { filePath: "a.js.map", content: '{"version":3}' },
      { filePath: "b.js.map", content: '{"version":3,"sources":[]}' },
    ];

    const hash = await computeBuildHash(maps);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it("content hash is deterministic", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no git");
    });

    const maps = [
      { filePath: "main.js.map", content: "content1" },
      { filePath: "vendor.js.map", content: "content2" },
    ];

    const hash1 = await computeBuildHash(maps);
    const hash2 = await computeBuildHash(maps);
    expect(hash1).toBe(hash2);
  });

  it("content hash sorts paths alphabetically", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no git");
    });

    const maps1 = [
      { filePath: "b.js.map", content: "b" },
      { filePath: "a.js.map", content: "a" },
    ];
    const maps2 = [
      { filePath: "a.js.map", content: "a" },
      { filePath: "b.js.map", content: "b" },
    ];

    const hash1 = await computeBuildHash(maps1);
    const hash2 = await computeBuildHash(maps2);
    expect(hash1).toBe(hash2);
  });

  it("empty maps produce a valid hash when git fails", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("no git");
    });

    const hash = await computeBuildHash([]);
    expect(hash).toBeTruthy();
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

describe("uploadSourceMaps", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs valid request and returns parsed response", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123",
        fileCount: 1,
        totalSizeBytes: 100,
      }),
    };
    // Partial Response mock — only fields used by the function under test
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    const result = await uploadSourceMaps(
      "gt_dev_" + "a".repeat(48),
      "https://api.glasstrace.dev",
      "abc123",
      [{ filePath: "main.js.map", content: '{"version":3}' }],
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
    expect((options as RequestInit).method).toBe("POST");
    expect(
      (options as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer gt_dev_" + "a".repeat(48),
    });

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it("strips trailing slashes from endpoint URL", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123",
        fileCount: 1,
        totalSizeBytes: 100,
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await uploadSourceMaps(
      "gt_dev_" + "a".repeat(48),
      "https://api.glasstrace.dev///",
      "abc123",
      [{ filePath: "main.js.map", content: '{"version":3}' }],
    );

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
  });

  it("error case: upload fails with network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network error"));

    await expect(
      uploadSourceMaps(
        "gt_dev_" + "a".repeat(48),
        "https://api.glasstrace.dev",
        "abc123",
        [{ filePath: "main.js.map", content: '{"version":3}' }],
      ),
    ).rejects.toThrow();
  });

  it("error case: upload fails with non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("Unauthorized"),
    };
    // Partial Response mock — only fields used by the function under test
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(
      uploadSourceMaps(
        "gt_dev_" + "a".repeat(48),
        "https://api.glasstrace.dev",
        "abc123",
        [{ filePath: "main.js.map", content: '{"version":3}' }],
      ),
    ).rejects.toThrow();
  });

  it("consumes response body on error to prevent connection pool leaks", async () => {
    const textMock = vi.fn().mockResolvedValue("error body");
    const mockResponse = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: textMock,
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(
      uploadSourceMaps(
        "gt_dev_" + "a".repeat(48),
        "https://api.glasstrace.dev",
        "abc123",
        [{ filePath: "main.js.map", content: '{"version":3}' }],
      ),
    ).rejects.toThrow("Source map upload failed: 503 Service Unavailable");
    expect(textMock).toHaveBeenCalledOnce();
  });

  it("preserves upload failure error when response body consumption fails", async () => {
    const textMock = vi.fn().mockRejectedValue(new Error("stream error"));
    const mockResponse = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: textMock,
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);

    await expect(
      uploadSourceMaps(
        "gt_dev_" + "a".repeat(48),
        "https://api.glasstrace.dev",
        "abc123",
        [{ filePath: "main.js.map", content: '{"version":3}' }],
      ),
    ).rejects.toThrow("Source map upload failed: 503 Service Unavailable");
    expect(textMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Presigned upload tests
// ---------------------------------------------------------------------------

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);
const TEST_ENDPOINT = "https://api.glasstrace.dev";
const TEST_BUILD_HASH = "abc123def456";

function mockPresignedResponse(files: Array<{ filePath: string }>) {
  return {
    uploadId: "550e8400-e29b-41d4-a716-446655440000",
    expiresAt: Date.now() + 900_000,
    files: files.map((f) => ({
      filePath: f.filePath,
      clientToken: `token-${f.filePath}`,
      pathname: `source-maps/${f.filePath}`,
      maxBytes: 10_000_000,
    })),
  };
}

function mockManifestResponse(fileCount: number) {
  return {
    success: true as const,
    buildHash: TEST_BUILD_HASH,
    fileCount,
    totalSizeBytes: 1000,
    activatedAt: Date.now(),
  };
}

describe("requestPresignedTokens", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends correct URL, headers, and body", async () => {
    const responseData = mockPresignedResponse([{ filePath: "main.js" }]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(responseData),
    } as unknown as Response);

    const result = await requestPresignedTokens(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 500 }],
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
    expect((options as RequestInit).method).toBe("POST");
    expect(
      (options as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY}`,
    });

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.buildHash).toBe(TEST_BUILD_HASH);
    expect(body.files).toEqual([{ filePath: "main.js", sizeBytes: 500 }]);

    expect(result.uploadId).toBe(responseData.uploadId);
    expect(result.files).toHaveLength(1);
  });

  it("strips trailing slashes from endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(
        mockPresignedResponse([{ filePath: "main.js" }]),
      ),
    } as unknown as Response);

    await requestPresignedTokens(
      TEST_API_KEY, "https://api.glasstrace.dev///", TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 500 }],
    );

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
  });

  it("throws on 401 unauthorized", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("Unauthorized"),
    } as unknown as Response);

    await expect(
      requestPresignedTokens(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 500 }],
      ),
    ).rejects.toThrow("Presigned token request failed: 401 Unauthorized");
  });

  it("throws on 500 server error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: vi.fn().mockResolvedValue("error"),
    } as unknown as Response);

    await expect(
      requestPresignedTokens(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 500 }],
      ),
    ).rejects.toThrow("Presigned token request failed: 500 Internal Server Error");
  });

  it("drains response body on error", async () => {
    const textMock = vi.fn().mockResolvedValue("error body");
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: textMock,
    } as unknown as Response);

    await expect(
      requestPresignedTokens(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 500 }],
      ),
    ).rejects.toThrow();
    expect(textMock).toHaveBeenCalledOnce();
  });
});

describe("uploadToBlob", () => {
  it("calls @vercel/blob/client put with correct arguments", async () => {
    const mockPut = vi.fn().mockResolvedValue({ url: "https://blob.vercel-storage.com/file.js.map" });
    vi.doMock("@vercel/blob/client", () => ({ put: mockPut }));

    // Re-import to pick up the mock
    const { uploadToBlob: uploadToBlobMocked } = await import(
      "../../../packages/sdk/src/source-map-uploader.js"
    );

    const result = await uploadToBlobMocked("token-123", "source-maps/main.js", '{"version":3}');

    expect(mockPut).toHaveBeenCalledOnce();
    expect(mockPut).toHaveBeenCalledWith(
      "source-maps/main.js",
      expect.any(Blob),
      { access: "public", token: "token-123" },
    );
    expect(result.url).toBe("https://blob.vercel-storage.com/file.js.map");
    expect(result.size).toBe(Buffer.byteLength('{"version":3}', "utf-8"));

    vi.doUnmock("@vercel/blob/client");
  });

  it("returns correct byte size for multi-byte content", async () => {
    const mockPut = vi.fn().mockResolvedValue({ url: "https://blob.example.com/file" });
    vi.doMock("@vercel/blob/client", () => ({ put: mockPut }));

    const { uploadToBlob: uploadToBlobMocked } = await import(
      "../../../packages/sdk/src/source-map-uploader.js"
    );

    // Multi-byte characters: each emoji is 4 bytes in UTF-8
    const content = "hello \u{1F600}";
    const result = await uploadToBlobMocked("token", "path", content);
    expect(result.size).toBe(Buffer.byteLength(content, "utf-8"));
    // String length is 8, but byte length is 10 (6 ASCII + 4 for emoji)
    expect(result.size).not.toBe(content.length);

    vi.doUnmock("@vercel/blob/client");
  });
});

describe("submitManifest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends correct URL, headers, and body", async () => {
    const responseData = mockManifestResponse(1);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(responseData),
    } as unknown as Response);

    const files = [{
      filePath: "main.js",
      sizeBytes: 500,
      blobUrl: "https://blob.example.com/main.js",
    }];

    const result = await submitManifest(
      TEST_API_KEY, TEST_ENDPOINT,
      "550e8400-e29b-41d4-a716-446655440000", TEST_BUILD_HASH, files,
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/manifest");
    expect((options as RequestInit).method).toBe("POST");

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.uploadId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.buildHash).toBe(TEST_BUILD_HASH);
    expect(body.files).toEqual(files);

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it("throws on 401 unauthorized", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("Unauthorized"),
    } as unknown as Response);

    await expect(
      submitManifest(
        TEST_API_KEY, TEST_ENDPOINT,
        "550e8400-e29b-41d4-a716-446655440000", TEST_BUILD_HASH, [],
      ),
    ).rejects.toThrow("Source map manifest submission failed: 401 Unauthorized");
  });

  it("throws on 500 server error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: vi.fn().mockResolvedValue("error"),
    } as unknown as Response);

    await expect(
      submitManifest(
        TEST_API_KEY, TEST_ENDPOINT,
        "550e8400-e29b-41d4-a716-446655440000", TEST_BUILD_HASH, [],
      ),
    ).rejects.toThrow("Source map manifest submission failed: 500 Internal Server Error");
  });
});

describe("uploadSourceMapsPresigned", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("orchestrates all 3 phases successfully", async () => {
    const maps = [
      { filePath: "main.js", content: '{"version":3,"file":"main.js"}' },
      { filePath: "vendor.js", content: '{"version":3,"file":"vendor.js"}' },
    ];

    // Phase 1 response
    const presignedResp = mockPresignedResponse(maps);
    // Phase 3 response
    const manifestResp = mockManifestResponse(2);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    const mockUploader: BlobUploader = vi.fn().mockImplementation(
      async (_token: string, _pathname: string, content: string) => ({
        url: `https://blob.example.com/${_pathname}`,
        size: Buffer.byteLength(content, "utf-8"),
      }),
    );

    const result = await uploadSourceMapsPresigned(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
    );

    // Phase 1: one fetch for presigned tokens
    // Phase 3: one fetch for manifest
    expect(fetch).toHaveBeenCalledTimes(2);

    // Phase 2: blob uploader called for each file
    expect(mockUploader).toHaveBeenCalledTimes(2);

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(2);
  });

  it("throws when presigned token has no matching map entry", async () => {
    const maps = [{ filePath: "main.js", content: '{"version":3}' }];

    // Response includes a file not in maps
    const presignedResp = mockPresignedResponse([
      { filePath: "main.js" },
      { filePath: "unknown.js" },
    ]);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => presignedResp,
    } as unknown as Response);

    const mockUploader: BlobUploader = vi.fn();

    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
      ),
    ).rejects.toThrow('Presigned token for "unknown.js" has no matching source map entry');

    // No uploads should have started since validation happens before uploads
    expect(mockUploader).not.toHaveBeenCalled();
  });

  it("does not call submitManifest when blob upload fails", async () => {
    const maps = [
      { filePath: "main.js", content: '{"version":3}' },
      { filePath: "vendor.js", content: '{"version":3}' },
    ];

    const presignedResp = mockPresignedResponse(maps);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => presignedResp,
    } as unknown as Response);

    const mockUploader: BlobUploader = vi.fn()
      .mockRejectedValue(new Error("blob upload failed"));

    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
      ),
    ).rejects.toThrow();

    // Only 1 fetch call (Phase 1) — Phase 3 should not be reached
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses Buffer.byteLength for sizeBytes in presigned request", async () => {
    const content = "hello \u{1F600}"; // 10 bytes, not 8
    const maps = [{ filePath: "main.js", content }];

    const presignedResp = mockPresignedResponse(maps);
    const manifestResp = mockManifestResponse(1);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    const mockUploader: BlobUploader = vi.fn().mockResolvedValue({
      url: "https://blob.example.com/file", size: 10,
    });

    await uploadSourceMapsPresigned(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
    );

    // Check the Phase 1 request body
    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.files[0].sizeBytes).toBe(Buffer.byteLength(content, "utf-8"));
    expect(body.files[0].sizeBytes).toBe(10);
    expect(body.files[0].sizeBytes).not.toBe(content.length);
  });
});

describe("uploadSourceMapsAuto", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses legacy upload for small builds", async () => {
    const maps = [{ filePath: "main.js", content: '{"version":3}' }];

    const legacyResp = {
      success: true,
      buildHash: TEST_BUILD_HASH,
      fileCount: 1,
      totalSizeBytes: 14,
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => legacyResp,
    } as unknown as Response);

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
    );

    // Should call legacy endpoint
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
    expect(result.success).toBe(true);
  });

  it("uses presigned upload for large builds when blob is available", async () => {
    // Create content that exceeds threshold
    const largeContent = "x".repeat(PRESIGNED_THRESHOLD_BYTES);
    const maps = [{ filePath: "main.js", content: largeContent }];

    const presignedResp = mockPresignedResponse([{ filePath: "main.js" }]);
    const manifestResp = mockManifestResponse(1);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    const mockUploader: BlobUploader = vi.fn().mockResolvedValue({
      url: "https://blob.example.com/file",
      size: Buffer.byteLength(largeContent, "utf-8"),
    });

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      {
        checkBlobAvailable: async () => true,
        blobUploader: mockUploader,
      },
    );

    // Should call presigned endpoint, not legacy
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
    expect(result.success).toBe(true);
  });

  it("falls back to legacy upload for large builds when blob is unavailable", async () => {
    const largeContent = "x".repeat(PRESIGNED_THRESHOLD_BYTES);
    const maps = [{ filePath: "main.js", content: largeContent }];

    const legacyResp = {
      success: true,
      buildHash: TEST_BUILD_HASH,
      fileCount: 1,
      totalSizeBytes: PRESIGNED_THRESHOLD_BYTES,
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => legacyResp,
    } as unknown as Response);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      { checkBlobAvailable: async () => false },
    );

    // Should call legacy endpoint
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
    expect(result.success).toBe(true);

    // Should warn about missing @vercel/blob
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("Install @vercel/blob");

    warnSpy.mockRestore();
  });

  it("routes at exact threshold boundary to presigned", async () => {
    // Exactly at threshold should use presigned
    const content = "x".repeat(PRESIGNED_THRESHOLD_BYTES);
    const maps = [{ filePath: "main.js", content }];

    const presignedResp = mockPresignedResponse([{ filePath: "main.js" }]);
    const manifestResp = mockManifestResponse(1);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      {
        checkBlobAvailable: async () => true,
        blobUploader: vi.fn().mockResolvedValue({
          url: "https://blob.example.com/file", size: PRESIGNED_THRESHOLD_BYTES,
        }),
      },
    );

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
  });

  it("routes just below threshold to legacy", async () => {
    const content = "x".repeat(PRESIGNED_THRESHOLD_BYTES - 1);
    const maps = [{ filePath: "main.js", content }];

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true, buildHash: TEST_BUILD_HASH, fileCount: 1, totalSizeBytes: 100,
      }),
    } as unknown as Response);

    await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
    );

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
  });

  it("uses Buffer.byteLength for threshold calculation", async () => {
    // Create content that is below threshold by string length but above by byte length
    // Each emoji is 4 bytes in UTF-8 but 2 chars in JS
    const emojiCount = Math.ceil(PRESIGNED_THRESHOLD_BYTES / 4);
    const content = "\u{1F600}".repeat(emojiCount);
    expect(content.length).toBeLessThan(Buffer.byteLength(content, "utf-8"));
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThanOrEqual(PRESIGNED_THRESHOLD_BYTES);

    const maps = [{ filePath: "main.js", content }];

    const presignedResp = mockPresignedResponse([{ filePath: "main.js" }]);
    const manifestResp = mockManifestResponse(1);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      {
        checkBlobAvailable: async () => true,
        blobUploader: vi.fn().mockResolvedValue({
          url: "https://blob.example.com/file",
          size: Buffer.byteLength(content, "utf-8"),
        }),
      },
    );

    // Should route to presigned based on byte length, not string length
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
  });

  it("throws when maps array is empty", async () => {
    await expect(
      uploadSourceMapsAuto(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, [],
      ),
    ).rejects.toThrow("No source maps to upload");
  });
});

// Note: the "missing @vercel/blob" error path in uploadToBlob cannot be
// unit tested because @vercel/blob is installed as a devDependency and
// vitest's mock hoisting prevents simulating a missing module. The
// ERR_MODULE_NOT_FOUND error-code check is defensive code for end users
// who don't install the optional peer dependency.

describe("uploadSourceMapsPresigned — edge cases", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when maps array is empty", async () => {
    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, [], vi.fn(),
      ),
    ).rejects.toThrow("No source maps to upload");

    // No fetch calls should have been made
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws on duplicate filePath entries", async () => {
    const maps = [
      { filePath: "main.js", content: '{"version":3}' },
      { filePath: "main.js", content: '{"version":3,"duplicate":true}' },
    ];

    const presignedResp = mockPresignedResponse([{ filePath: "main.js" }]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => presignedResp,
    } as unknown as Response);

    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, vi.fn(),
      ),
    ).rejects.toThrow("Duplicate filePath entries in source maps");
  });

  it("propagates Phase 1 failure without attempting Phase 2 or 3", async () => {
    const maps = [{ filePath: "main.js", content: '{"version":3}' }];

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: vi.fn().mockResolvedValue("error"),
    } as unknown as Response);

    const mockUploader: BlobUploader = vi.fn();

    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
      ),
    ).rejects.toThrow("Presigned token request failed: 500 Internal Server Error");

    // Only one fetch (the failed Phase 1), no blob uploads, no Phase 3
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockUploader).not.toHaveBeenCalled();
  });

  it("uploads 7 files in two chunks (5 + 2) via concurrency limiter", async () => {
    const fileNames = Array.from({ length: 7 }, (_, i) => `file-${i}.js`);
    const maps = fileNames.map((name) => ({
      filePath: name,
      content: `{"version":3,"file":"${name}"}`,
    }));

    const presignedResp = mockPresignedResponse(
      fileNames.map((name) => ({ filePath: name })),
    );
    const manifestResp = mockManifestResponse(7);

    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => presignedResp } as unknown as Response;
      }
      return { ok: true, json: async () => manifestResp } as unknown as Response;
    });

    const uploadCalls: string[] = [];
    const mockUploader: BlobUploader = vi.fn().mockImplementation(
      async (_token: string, _pathname: string, content: string) => {
        uploadCalls.push(_pathname);
        return {
          url: `https://blob.example.com/${_pathname}`,
          size: Buffer.byteLength(content, "utf-8"),
        };
      },
    );

    const result = await uploadSourceMapsPresigned(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockUploader,
    );

    // All 7 files uploaded
    expect(mockUploader).toHaveBeenCalledTimes(7);
    expect(uploadCalls).toHaveLength(7);

    // Phase 1 + Phase 3 = 2 fetch calls
    expect(fetch).toHaveBeenCalledTimes(2);

    // Manifest submitted with all 7 files
    const [, manifestOptions] = vi.mocked(fetch).mock.calls[1];
    const manifestBody = JSON.parse((manifestOptions as RequestInit).body as string);
    expect(manifestBody.files).toHaveLength(7);

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(7);
  });
});
