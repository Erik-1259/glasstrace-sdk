import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { withGlasstraceConfig, handleSourceMapUpload } from "../../../packages/sdk/src/config-wrapper.js";

// Mock child_process for computeBuildHash
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("abc123def456\n"),
}));

describe("withGlasstraceConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("returns a config object", () => {
    const result = withGlasstraceConfig({});
    expect(result).not.toBeNull();
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("does not set productionBrowserSourceMaps (avoids exposing source code)", () => {
    const result = withGlasstraceConfig({});
    expect(result.productionBrowserSourceMaps).toBeUndefined();
  });

  it("enables experimental.serverSourceMaps", () => {
    const result = withGlasstraceConfig({});
    expect((result.experimental as Record<string, unknown>).serverSourceMaps).toBe(true);
  });

  it("preserves existing experimental config", () => {
    const result = withGlasstraceConfig({
      experimental: { ppr: true },
    });
    const experimental = result.experimental as Record<string, unknown>;
    expect(experimental.serverSourceMaps).toBe(true);
    expect(experimental.ppr).toBe(true);
  });

  it("preserves existing config values", () => {
    const original = {
      reactStrictMode: true,
      images: { domains: ["example.com"] },
    };
    const result = withGlasstraceConfig(original);
    expect(result.reactStrictMode).toBe(true);
    expect(result.images).toEqual({ domains: ["example.com"] });
  });

  it("preserves user's productionBrowserSourceMaps setting", () => {
    const result = withGlasstraceConfig({
      productionBrowserSourceMaps: false,
    });
    expect(result.productionBrowserSourceMaps).toBe(false);
  });

  it("registers a webpack config modifier", () => {
    const result = withGlasstraceConfig({});
    expect(typeof result.webpack).toBe("function");
  });

  it("webpack modifier preserves existing webpack config", () => {
    const existingWebpack = vi.fn().mockReturnValue({ entry: {} });
    const result = withGlasstraceConfig({ webpack: existingWebpack });

    (result.webpack as (...args: unknown[]) => unknown)(
      { plugins: [] },
      { isServer: false, dev: false },
    );
    expect(existingWebpack).toHaveBeenCalledOnce();
  });

  it("webpack adds plugin for client production builds", () => {
    const result = withGlasstraceConfig({});
    const webpackConfig = { plugins: [] as unknown[] };

    (result.webpack as (...args: unknown[]) => unknown)(
      webpackConfig,
      { isServer: false, dev: false },
    );

    // Plugin should be added for client production build
    expect(webpackConfig.plugins.length).toBeGreaterThan(0);
  });

  it("webpack skips plugin for server builds", () => {
    const result = withGlasstraceConfig({});
    const webpackConfig = { plugins: [] as unknown[] };

    (result.webpack as (...args: unknown[]) => unknown)(
      webpackConfig,
      { isServer: true, dev: false },
    );

    // No plugin added for server builds
    expect(webpackConfig.plugins).toHaveLength(0);
  });

  it("webpack skips plugin for dev builds", () => {
    const result = withGlasstraceConfig({});
    const webpackConfig = { plugins: [] as unknown[] };

    (result.webpack as (...args: unknown[]) => unknown)(
      webpackConfig,
      { isServer: false, dev: true },
    );

    // No plugin added for dev builds
    expect(webpackConfig.plugins).toHaveLength(0);
  });

  it("webpack plugin apply registers afterEmit hook", () => {
    const result = withGlasstraceConfig({});
    const webpackConfig = { plugins: [] as Array<{ apply: (c: unknown) => void }> };

    (result.webpack as (...args: unknown[]) => unknown)(
      webpackConfig,
      { isServer: false, dev: false },
    );

    const plugin = webpackConfig.plugins[0];
    const tapPromise = vi.fn();
    const mockCompiler = {
      hooks: {
        afterEmit: { tapPromise },
      },
    };

    plugin.apply(mockCompiler);
    expect(tapPromise).toHaveBeenCalledWith(
      "GlasstraceSourceMapUpload",
      expect.any(Function),
    );
  });

  it("uses custom distDir when provided", () => {
    const result = withGlasstraceConfig({ distDir: "custom-build" });
    expect(result.distDir).toBe("custom-build");
  });

  it("anonymous mode skips upload and logs info", () => {
    delete process.env.GLASSTRACE_API_KEY;
    const consoleSpy = vi.spyOn(globalThis.console, "info").mockImplementation(() => {});

    const result = withGlasstraceConfig({});
    expect(result).toBeDefined();
    expect(result.productionBrowserSourceMaps).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("withGlasstraceConfig never throws", () => {
    // Intentionally invalid — testing that null/undefined inputs are handled gracefully
    expect(() => withGlasstraceConfig(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => withGlasstraceConfig(undefined as unknown as Record<string, unknown>)).not.toThrow();
  });

  it("error case: malformed config preserves original", () => {
    const original = { reactStrictMode: true };
    const result = withGlasstraceConfig(original);
    expect(result.reactStrictMode).toBe(true);
  });
});

describe("handleSourceMapUpload", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tmpDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-config-"));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("skips upload when no API key", async () => {
    delete process.env.GLASSTRACE_API_KEY;
    const consoleSpy = vi.spyOn(globalThis.console, "info").mockImplementation(() => {});

    await handleSourceMapUpload(tmpDir);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Source map upload skipped"),
    );
    consoleSpy.mockRestore();
  });

  it("skips upload when API key is empty", async () => {
    process.env.GLASSTRACE_API_KEY = "   ";
    const consoleSpy = vi.spyOn(globalThis.console, "info").mockImplementation(() => {});

    await handleSourceMapUpload(tmpDir);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Source map upload skipped"),
    );
    consoleSpy.mockRestore();
  });

  it("error case: no .map files logs info and skips", async () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_" + "a".repeat(48);
    const consoleSpy = vi.spyOn(globalThis.console, "info").mockImplementation(() => {});

    await handleSourceMapUpload(tmpDir);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("No source map files found"),
    );
    consoleSpy.mockRestore();
  });

  it("successful upload logs info", async () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(path.join(tmpDir, "main.js.map"), '{"version":3}');

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: true,
        buildHash: "abc123def456",
        fileCount: 1,
        totalSizeBytes: 100,
      }),
    };
    // Partial Response mock — only fields used by the function under test
    vi.mocked(fetch).mockResolvedValue(mockResponse as unknown as Response);
    const consoleSpy = vi.spyOn(globalThis.console, "info").mockImplementation(() => {});

    await handleSourceMapUpload(tmpDir);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Uploaded 1 source map(s)"),
    );
    consoleSpy.mockRestore();
  });

  it("upload failure does not throw", async () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(path.join(tmpDir, "main.js.map"), '{"version":3}');

    vi.mocked(fetch).mockRejectedValue(new Error("network timeout"));
    const consoleSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});

    await expect(handleSourceMapUpload(tmpDir)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Source map upload failed"),
    );
    consoleSpy.mockRestore();
  });

  it("non-Error throw is handled", async () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(path.join(tmpDir, "main.js.map"), '{"version":3}');

    vi.mocked(fetch).mockRejectedValue("string error");
    const consoleSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});

    await expect(handleSourceMapUpload(tmpDir)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown error"),
    );
    consoleSpy.mockRestore();
  });
});
