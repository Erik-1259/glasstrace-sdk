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
} from "../../../packages/sdk/src/source-map-uploader.js";

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
});
