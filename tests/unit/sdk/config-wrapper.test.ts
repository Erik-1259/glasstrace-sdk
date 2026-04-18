import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  withGlasstraceConfig,
  handleSourceMapUpload,
  _resetTurbopackWarningForTesting,
} from "../../../packages/sdk/src/config-wrapper.js";

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

  it("returns config unchanged in non-Node.js environments", () => {
    const originalVersions = process.versions;

    // Simulate non-Node environment
    Object.defineProperty(process, "versions", {
      value: { ...originalVersions, node: undefined },
      configurable: true,
    });

    try {
      const input = { reactStrictMode: true, images: { domains: ["example.com"] } };
      const result = withGlasstraceConfig(input);

      // Config should be returned as-is (shallow copy), without webpack modifications
      expect(result.reactStrictMode).toBe(true);
      expect(result.images).toEqual({ domains: ["example.com"] });
      expect(result.webpack).toBeUndefined();
      expect(result.experimental).toBeUndefined();
    } finally {
      Object.defineProperty(process, "versions", {
        value: originalVersions,
        configurable: true,
      });
    }
  });

  it("returns empty object for null input in non-Node.js environments", () => {
    const originalVersions = process.versions;

    Object.defineProperty(process, "versions", {
      value: { ...originalVersions, node: undefined },
      configurable: true,
    });

    try {
      const result = withGlasstraceConfig(null as unknown as Record<string, unknown>);
      expect(result).toEqual({});
    } finally {
      Object.defineProperty(process, "versions", {
        value: originalVersions,
        configurable: true,
      });
    }
  });

  it("error case: malformed config preserves original", () => {
    const original = { reactStrictMode: true };
    const result = withGlasstraceConfig(original);
    expect(result.reactStrictMode).toBe(true);
  });

  // --- DISC-1256 regression coverage ---

  it("seeds an empty turbopack config when the user has not set one", () => {
    const result = withGlasstraceConfig({});
    expect(result.turbopack).toEqual({});
  });

  it("preserves an existing turbopack config unchanged", () => {
    const userTurbopack = { rules: { "*.svg": { loaders: ["@svgr/webpack"] } } };
    const result = withGlasstraceConfig({ turbopack: userTurbopack });
    expect(result.turbopack).toBe(userTurbopack);
  });

  it("preserves caller subtype via generic parameter (DISC-1256)", () => {
    // Compile-time coverage: the generic signature means `result.myCustom`
    // is statically known to be `string`, not `unknown`. If the generic is
    // removed this assertion won't type-check.
    const result = withGlasstraceConfig({
      reactStrictMode: true as const,
      myCustom: "value",
    });
    const myCustom: string = result.myCustom;
    expect(myCustom).toBe("value");
    expect(result.reactStrictMode).toBe(true);
  });

  it("accepts an interface-shaped config without a string index signature (Next NextConfig shape)", () => {
    // Mirrors Next's real `NextConfig` — an interface with named optional
    // properties and NO string index signature. Before the constraint was
    // relaxed from `Record<string, unknown>` to `object`, this would fail
    // to type-check with "Index signature for type 'string' is missing"
    // (the DISC-1256 symptom reported by Next 16 consumers).
    interface NextConfigLike {
      reactStrictMode?: boolean;
      experimental?: Record<string, unknown>;
    }
    const next16Shape: NextConfigLike = { reactStrictMode: true };
    const result = withGlasstraceConfig(next16Shape);
    expect(result.reactStrictMode).toBe(true);
  });

  it("warns once when Turbopack is detected via TURBOPACK=1", () => {
    _resetTurbopackWarningForTesting();
    const originalEnvValue = process.env.TURBOPACK;
    process.env.TURBOPACK = "1";
    const warnSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});

    try {
      withGlasstraceConfig({});
      withGlasstraceConfig({}); // second call should not re-emit

      const turbopackWarnings = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Turbopack detected"),
      );
      expect(turbopackWarnings).toHaveLength(1);
      expect(turbopackWarnings[0][0]).toContain("next build --webpack");
    } finally {
      if (originalEnvValue === undefined) delete process.env.TURBOPACK;
      else process.env.TURBOPACK = originalEnvValue;
      warnSpy.mockRestore();
    }
  });

  // --- DISC-1257 regression coverage: serverExternalPackages push ---

  it("pushes @glasstrace/sdk onto serverExternalPackages for an empty config", () => {
    const result = withGlasstraceConfig({});
    const stable = (result as { serverExternalPackages?: unknown })
      .serverExternalPackages;
    expect(stable).toEqual(["@glasstrace/sdk"]);
  });

  it("does not write the deprecated experimental.serverComponentsExternalPackages key", () => {
    const result = withGlasstraceConfig({});
    const experimental = (result as { experimental?: Record<string, unknown> })
      .experimental ?? {};
    // Next 16 logs a deprecation warning for the legacy key; we only write
    // the stable Next 15+ top-level key now.
    expect(experimental.serverComponentsExternalPackages).toBeUndefined();
  });

  it("preserves user-provided serverExternalPackages entries (Next 15+ shape)", () => {
    const result = withGlasstraceConfig({
      serverExternalPackages: ["prisma", "@prisma/client"],
    });
    const stable = (result as { serverExternalPackages?: unknown })
      .serverExternalPackages;
    // User entries first, SDK appended.
    expect(stable).toEqual(["prisma", "@prisma/client", "@glasstrace/sdk"]);
  });

  it("leaves user-provided experimental.serverComponentsExternalPackages untouched", () => {
    // The legacy key is no longer managed by the wrapper; if a user has it
    // explicitly (e.g. for Next 14), we neither add to nor strip from it.
    const result = withGlasstraceConfig({
      experimental: {
        serverComponentsExternalPackages: ["prisma"],
      },
    });
    const experimental = (result as { experimental?: Record<string, unknown> })
      .experimental ?? {};
    expect(experimental.serverComponentsExternalPackages).toEqual(["prisma"]);
  });

  it("does not duplicate @glasstrace/sdk if the user already added it (stable key)", () => {
    const result = withGlasstraceConfig({
      serverExternalPackages: ["@glasstrace/sdk", "prisma"],
    });
    const stable = (result as { serverExternalPackages?: unknown })
      .serverExternalPackages;
    expect(stable).toEqual(["@glasstrace/sdk", "prisma"]);
  });

  it("preserves unrelated experimental keys while adding the external packages entry", () => {
    const result = withGlasstraceConfig({
      experimental: { typedRoutes: true, ppr: "incremental" },
    });
    const experimental = (result as { experimental?: Record<string, unknown> })
      .experimental ?? {};
    expect(experimental.typedRoutes).toBe(true);
    expect(experimental.ppr).toBe("incremental");
    expect(experimental.serverSourceMaps).toBe(true);
    const stable = (result as { serverExternalPackages?: unknown })
      .serverExternalPackages;
    expect(stable).toEqual(["@glasstrace/sdk"]);
  });

  it("does not mutate the caller's config object or arrays", () => {
    const userExternals = ["prisma"];
    const userConfig = {
      serverExternalPackages: userExternals,
      experimental: {
        typedRoutes: true,
      },
    };
    const snapshot = JSON.parse(JSON.stringify(userConfig)) as typeof userConfig;

    const result = withGlasstraceConfig(userConfig);

    // Original config references and arrays must be untouched.
    expect(userConfig).toEqual(snapshot);
    expect(userExternals).toEqual(["prisma"]);

    // But the returned config carries the addition.
    const stable = (result as { serverExternalPackages?: unknown })
      .serverExternalPackages as string[];
    expect(stable).toEqual(["prisma", "@glasstrace/sdk"]);
    expect(stable).not.toBe(userExternals);
  });

  // --- DISC-1257 regression coverage: webpack `node:*` externals ---

  // Shape of an entry in webpack's array-of-externals. Functions here
  // receive `(data, callback)` where `data.request` carries the import
  // specifier. We mirror that shape below to drive the SDK's handler
  // without pulling in webpack as a test dep.
  type ExternalsFnEntry = (
    data: { request?: string },
    callback: (err: Error | null, result?: string) => void,
  ) => void;

  function invokeSdkExternalsFn(
    webpackConfig: Record<string, unknown>,
    context: Record<string, unknown> = { isServer: true, dev: true },
  ): ExternalsFnEntry {
    const result = withGlasstraceConfig({});
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)(webpackConfig, context);
    const externals = wrapped.externals as unknown[];
    // The SDK handler is always the final entry so user externals take
    // precedence. The cast is safe because `appendNodeSchemeExternal`
    // only appends function entries.
    const handler = externals[externals.length - 1] as ExternalsFnEntry;
    expect(typeof handler).toBe("function");
    return handler;
  }

  it("externalizes node:* requests as `commonjs node:...`", () => {
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({ request: "node:child_process" }, cb);
    expect(cb).toHaveBeenCalledWith(null, "commonjs node:child_process");
  });

  it("externalizes bare Node built-in requests as `commonjs <name>`", () => {
    // OTel exporters use the bare form (`import * as zlib from "zlib"`).
    // Next dev's webpack pipeline does not auto-externalize these, so the
    // SDK's handler must cover both `node:`-prefixed and bare built-ins.
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({ request: "zlib" }, cb);
    expect(cb).toHaveBeenCalledWith(null, "commonjs zlib");
  });

  it("externalizes bare Node built-in subpaths as `commonjs <name>`", () => {
    // `fs/promises`, `stream/web`, etc. are reported as built-ins by
    // `node:module.isBuiltin`. The handler preserves the exact specifier.
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({ request: "fs/promises" }, cb);
    expect(cb).toHaveBeenCalledWith(null, "commonjs fs/promises");
  });

  it("passes through third-party package requests untouched", () => {
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({ request: "react" }, cb);
    // Pass-through = callback called with (null) and no `result` arg.
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("passes through relative-path requests untouched", () => {
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({ request: "./local-module" }, cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("passes through an undefined request untouched", () => {
    const handler = invokeSdkExternalsFn({});
    const cb = vi.fn();
    handler({}, cb);
    expect(cb).toHaveBeenCalledWith(null);
  });

  it("appends the handler to an existing externals array, preserving user entries", () => {
    const userEntry1 = { react: "React" };
    const userEntry2 = /^some-regex$/;
    const result = withGlasstraceConfig({});
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)(
      { externals: [userEntry1, userEntry2] },
      { isServer: true, dev: true },
    );
    const externals = wrapped.externals as unknown[];
    expect(externals).toHaveLength(3);
    expect(externals[0]).toBe(userEntry1);
    expect(externals[1]).toBe(userEntry2);
    expect(typeof externals[2]).toBe("function");
  });

  it("wraps a non-array externals value (function form) in an array", () => {
    const userFn = (): void => {};
    const result = withGlasstraceConfig({});
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)(
      { externals: userFn },
      { isServer: true, dev: true },
    );
    const externals = wrapped.externals as unknown[];
    expect(externals).toHaveLength(2);
    expect(externals[0]).toBe(userFn);
    expect(typeof externals[1]).toBe("function");
  });

  it("wraps a non-array externals value (object map form) in an array", () => {
    const userMap = { react: "React", "react-dom": "ReactDOM" };
    const result = withGlasstraceConfig({});
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)(
      { externals: userMap },
      { isServer: true, dev: true },
    );
    const externals = wrapped.externals as unknown[];
    expect(externals).toHaveLength(2);
    expect(externals[0]).toBe(userMap);
    expect(typeof externals[1]).toBe("function");
  });

  it("initialises an array when no externals were set", () => {
    const result = withGlasstraceConfig({});
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)({}, { isServer: true, dev: true });
    const externals = wrapped.externals as unknown[];
    expect(Array.isArray(externals)).toBe(true);
    expect(externals).toHaveLength(1);
    expect(typeof externals[0]).toBe("function");
  });

  it("runs the user's webpack hook before appending externals", () => {
    const callOrder: string[] = [];
    const userWebpack = vi.fn((config: Record<string, unknown>) => {
      callOrder.push("user");
      config.customFlag = true;
      return config;
    });
    const result = withGlasstraceConfig({ webpack: userWebpack });
    const wrapped = (result.webpack as (
      c: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Record<string, unknown>)({}, { isServer: true, dev: true });
    callOrder.push("sdk");
    expect(userWebpack).toHaveBeenCalledOnce();
    expect(wrapped.customFlag).toBe(true);
    const externals = wrapped.externals as unknown[];
    expect(externals).toHaveLength(1);
    expect(typeof externals[0]).toBe("function");
    expect(callOrder).toEqual(["user", "sdk"]);
  });

  it("does not warn about Turbopack when --webpack flag is present", () => {
    _resetTurbopackWarningForTesting();
    const originalArgv = process.argv;
    const originalEnvValue = process.env.TURBOPACK;
    process.argv = [...originalArgv, "--webpack"];
    process.env.TURBOPACK = "1"; // even with env set, --webpack wins

    const warnSpy = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});

    try {
      withGlasstraceConfig({});
      const turbopackWarnings = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Turbopack detected"),
      );
      expect(turbopackWarnings).toHaveLength(0);
    } finally {
      process.argv = originalArgv;
      if (originalEnvValue === undefined) delete process.env.TURBOPACK;
      else process.env.TURBOPACK = originalEnvValue;
      warnSpy.mockRestore();
    }
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
