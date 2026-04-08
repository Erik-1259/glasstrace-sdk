import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock @vercel/blob/client — the put function is a vi.fn() that tests
// configure per-test. This mock intercepts both static and dynamic imports.
const mockPut = vi.fn();
vi.mock("@vercel/blob/client", () => ({
  put: mockPut,
}));

import { execSync } from "node:child_process";
import * as sourceMapUploader from "../../../packages/sdk/src/source-map-uploader.js";

const {
  collectSourceMaps,
  computeBuildHash,
  uploadSourceMaps,
  requestPresignedTokens,
  uploadToBlob,
  submitManifest,
  uploadSourceMapsPresigned,
  uploadSourceMapsAuto,
  PRESIGNED_THRESHOLD_BYTES,
} = sourceMapUploader;

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
// Presigned upload flow tests
// ---------------------------------------------------------------------------

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);
const TEST_ENDPOINT = "https://api.glasstrace.dev";
const TEST_BUILD_HASH = "abc123def456";

function makePresignedResponse(files: Array<{ filePath: string }>) {
  return {
    uploadId: "550e8400-e29b-41d4-a716-446655440000",
    expiresAt: Date.now() + 900_000,
    files: files.map((f) => ({
      filePath: f.filePath,
      clientToken: `token_${f.filePath}`,
      pathname: `builds/${TEST_BUILD_HASH}/${f.filePath}.map`,
      maxBytes: 10_000_000,
    })),
  };
}

function makeManifestResponse(fileCount: number) {
  return {
    success: true as const,
    buildHash: TEST_BUILD_HASH,
    fileCount,
    totalSizeBytes: 5_000_000,
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

  it("constructs correct URL and headers", async () => {
    const presignedResp = makePresignedResponse([{ filePath: "main.js" }]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(presignedResp),
    } as unknown as Response);

    await requestPresignedTokens(
      TEST_API_KEY,
      TEST_ENDPOINT,
      TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 1000 }],
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
    expect(body.files).toEqual([{ filePath: "main.js", sizeBytes: 1000 }]);
  });

  it("parses valid response", async () => {
    const presignedResp = makePresignedResponse([{ filePath: "main.js" }]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(presignedResp),
    } as unknown as Response);

    const result = await requestPresignedTokens(
      TEST_API_KEY,
      TEST_ENDPOINT,
      TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 1000 }],
    );

    expect(result.uploadId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].clientToken).toBe("token_main.js");
  });

  it("strips trailing slashes from endpoint", async () => {
    const presignedResp = makePresignedResponse([{ filePath: "main.js" }]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(presignedResp),
    } as unknown as Response);

    await requestPresignedTokens(
      TEST_API_KEY,
      TEST_ENDPOINT + "///",
      TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 1000 }],
    );

    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
  });

  it("throws on 401 error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi.fn().mockResolvedValue("Unauthorized"),
    } as unknown as Response);

    await expect(
      requestPresignedTokens(
        TEST_API_KEY,
        TEST_ENDPOINT,
        TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 1000 }],
      ),
    ).rejects.toThrow("Presigned token request failed: 401 Unauthorized");
  });

  it("throws on 500 error and drains response body", async () => {
    const textMock = vi.fn().mockResolvedValue("Internal Server Error");
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: textMock,
    } as unknown as Response);

    await expect(
      requestPresignedTokens(
        TEST_API_KEY,
        TEST_ENDPOINT,
        TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 1000 }],
      ),
    ).rejects.toThrow("Presigned token request failed: 500 Internal Server Error");
    expect(textMock).toHaveBeenCalledOnce();
  });
});

describe("uploadToBlob", () => {
  beforeEach(() => {
    mockPut.mockReset();
  });

  it("returns url and size on success", async () => {
    mockPut.mockResolvedValue({ url: "https://blob.vercel-storage.com/builds/abc/main.js.map" });

    const result = await uploadToBlob("test_token", "builds/abc/main.js.map", '{"version":3}');

    expect(result.url).toBe("https://blob.vercel-storage.com/builds/abc/main.js.map");
    expect(result.size).toBe(Buffer.byteLength('{"version":3}', "utf-8"));
    expect(mockPut).toHaveBeenCalledWith(
      "builds/abc/main.js.map",
      expect.any(Blob),
      { access: "public", token: "test_token" },
    );
  });

  it("throws with blob error message on failure", async () => {
    mockPut.mockRejectedValue(new Error("Blob upload failed: quota exceeded"));

    await expect(
      uploadToBlob("test_token", "builds/abc/main.js.map", '{"version":3}'),
    ).rejects.toThrow("Blob upload failed: quota exceeded");
  });
});

describe("submitManifest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs correct request and parses response", async () => {
    const manifestResp = makeManifestResponse(1);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(manifestResp),
    } as unknown as Response);

    const result = await submitManifest(
      TEST_API_KEY,
      TEST_ENDPOINT,
      "550e8400-e29b-41d4-a716-446655440000",
      TEST_BUILD_HASH,
      [{ filePath: "main.js", sizeBytes: 5000, blobUrl: "https://blob.vercel-storage.com/main.js.map" }],
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/manifest");
    expect((options as RequestInit).method).toBe("POST");

    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.uploadId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.buildHash).toBe(TEST_BUILD_HASH);
    expect(body.files[0].blobUrl).toBe("https://blob.vercel-storage.com/main.js.map");

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(1);
  });

  it("throws on error response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue("Invalid manifest"),
    } as unknown as Response);

    await expect(
      submitManifest(
        TEST_API_KEY,
        TEST_ENDPOINT,
        "550e8400-e29b-41d4-a716-446655440000",
        TEST_BUILD_HASH,
        [{ filePath: "main.js", sizeBytes: 5000, blobUrl: "https://blob.vercel-storage.com/main.js.map" }],
      ),
    ).rejects.toThrow("Source map manifest submission failed: 400 Bad Request");
  });
});

describe("uploadSourceMapsPresigned", () => {
  let mockBlobUploader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockBlobUploader = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("orchestrates all three phases", async () => {
    const maps = [
      { filePath: "main.js", content: '{"version":3,"file":"main.js"}' },
      { filePath: "vendor.js", content: '{"version":3,"file":"vendor.js"}' },
    ];

    const presignedResp = makePresignedResponse(maps.map((m) => ({ filePath: m.filePath })));
    const manifestResp = makeManifestResponse(2);

    // Phase 1 fetch (presign), then Phase 3 fetch (manifest)
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(presignedResp),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(manifestResp),
      } as unknown as Response);

    // Phase 2: blob uploads via injected mock
    mockBlobUploader
      .mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/main.js.map", size: 30 })
      .mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/vendor.js.map", size: 32 });

    const result = await uploadSourceMapsPresigned(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockBlobUploader,
    );

    // Phase 1 + Phase 3 = 2 fetch calls
    expect(fetch).toHaveBeenCalledTimes(2);
    // Phase 2 = 2 blob uploads
    expect(mockBlobUploader).toHaveBeenCalledTimes(2);

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(2);
  });

  it("does not call submitManifest when a blob upload fails", async () => {
    const maps = [
      { filePath: "main.js", content: '{"version":3}' },
      { filePath: "vendor.js", content: '{"version":3}' },
    ];

    const presignedResp = makePresignedResponse(maps.map((m) => ({ filePath: m.filePath })));

    // Phase 1 succeeds
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue(presignedResp),
    } as unknown as Response);

    // Phase 2: first upload succeeds, second fails
    mockBlobUploader
      .mockResolvedValueOnce({ url: "https://blob.vercel-storage.com/main.js.map", size: 13 })
      .mockRejectedValueOnce(new Error("Upload failed: network error"));

    await expect(
      uploadSourceMapsPresigned(
        TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps, mockBlobUploader,
      ),
    ).rejects.toThrow("Upload failed: network error");

    // Only Phase 1 fetch — no Phase 3 manifest call
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("uploadSourceMapsAuto", () => {
  let mockBlobUploader: ReturnType<typeof vi.fn>;
  let mockCheckAvailable: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockBlobUploader = vi.fn();
    mockCheckAvailable = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes to legacy upload for small builds", async () => {
    const smallMap = { filePath: "main.js", content: "x".repeat(100) };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: TEST_BUILD_HASH,
        fileCount: 1,
        totalSizeBytes: 100,
      }),
    } as unknown as Response);

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, [smallMap],
      { checkBlobAvailable: mockCheckAvailable, blobUploader: mockBlobUploader },
    );

    // Legacy upload goes to /v1/source-maps
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
    expect((result as { success: boolean }).success).toBe(true);
    // Should not check blob availability for small builds
    expect(mockCheckAvailable).not.toHaveBeenCalled();
  });

  it("routes to presigned flow for large builds", async () => {
    const largeContent = "x".repeat(PRESIGNED_THRESHOLD_BYTES);
    const maps = [{ filePath: "main.js", content: largeContent }];

    mockCheckAvailable.mockResolvedValue(true);

    const presignedResp = makePresignedResponse([{ filePath: "main.js" }]);
    const manifestResp = makeManifestResponse(1);

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(presignedResp),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(manifestResp),
      } as unknown as Response);

    mockBlobUploader.mockResolvedValueOnce({
      url: "https://blob.vercel-storage.com/main.js.map",
      size: PRESIGNED_THRESHOLD_BYTES,
    });

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      { checkBlobAvailable: mockCheckAvailable, blobUploader: mockBlobUploader },
    );

    // Phase 1 goes to /v1/source-maps/presign
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps/presign");
    expect((result as { success: boolean }).success).toBe(true);
    expect(mockBlobUploader).toHaveBeenCalledOnce();
  });

  it("falls back to legacy when @vercel/blob is not installed for large builds", async () => {
    const largeContent = "x".repeat(PRESIGNED_THRESHOLD_BYTES);
    const maps = [{ filePath: "main.js", content: largeContent }];

    // Simulate @vercel/blob not being installed
    mockCheckAvailable.mockResolvedValue(false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: TEST_BUILD_HASH,
        fileCount: 1,
        totalSizeBytes: PRESIGNED_THRESHOLD_BYTES,
      }),
    } as unknown as Response);

    const result = await uploadSourceMapsAuto(
      TEST_API_KEY, TEST_ENDPOINT, TEST_BUILD_HASH, maps,
      { checkBlobAvailable: mockCheckAvailable, blobUploader: mockBlobUploader },
    );

    // Falls back to legacy /v1/source-maps
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.glasstrace.dev/v1/source-maps");
    expect((result as { success: boolean }).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("@vercel/blob is not installed"),
    );
    expect(mockBlobUploader).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
