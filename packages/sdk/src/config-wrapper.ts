type NextConfig = Record<string, unknown>;
type WebpackConfigFn = (config: Record<string, unknown>, context: Record<string, unknown>) => Record<string, unknown>;

/** Subset of the webpack context object passed by Next.js to the webpack config function. */
interface WebpackContext {
  isServer: boolean;
  dev: boolean;
  [key: string]: unknown;
}

/** Minimal webpack compiler shape for the afterEmit hook. */
interface WebpackCompiler {
  hooks?: {
    afterEmit?: {
      tapPromise?: (name: string, fn: (compilation: unknown) => Promise<void>) => void;
    };
  };
}

/**
 * Wraps the developer's Next.js config to enable source map generation
 * and upload .map files to the ingestion API at build time.
 *
 * The build NEVER fails because of Glasstrace — all errors are caught
 * and logged as warnings.
 *
 * @param nextConfig - The developer's existing Next.js configuration object.
 * @returns A new config object with source map generation and upload enabled.
 */
export function withGlasstraceConfig(nextConfig: NextConfig): NextConfig {
  // Guard: config wrapper requires Node.js for source map instrumentation.
  // In non-Node environments (Edge Runtime, browser), return config unchanged.
  if (typeof process === "undefined" || typeof process.versions?.node !== "string") {
    return nextConfig != null ? { ...nextConfig } : {};
  }

  // Handle null/undefined gracefully
  const config: NextConfig = nextConfig != null ? { ...nextConfig } : {};

  // Enable server-side source map generation for Glasstrace uploads.
  // Intentionally does NOT set productionBrowserSourceMaps — that exposes
  // full source code publicly via browser DevTools. Users who want public
  // browser source maps can set it explicitly in their Next.js config.

  // Enable server-side source maps (Next.js experimental feature)
  const existingExperimental = (config.experimental as Record<string, unknown>) ?? {};
  config.experimental = { ...existingExperimental, serverSourceMaps: true };

  // Capture distDir for source map collection (default: .next)
  const distDir = typeof config.distDir === "string" ? config.distDir : ".next";

  // Capture existing webpack config if any
  const existingWebpack = config.webpack as WebpackConfigFn | undefined;

  // Register webpack config modifier
  config.webpack = (
    webpackConfig: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Record<string, unknown> => {
    // Call existing webpack config first
    let result = webpackConfig;
    if (typeof existingWebpack === "function") {
      result = existingWebpack(webpackConfig, context);
    }

    const webpackContext = context as WebpackContext;

    // Only run source map upload on client-side production builds (not server, not dev)
    if (!webpackContext.isServer && webpackContext.dev === false) {
      // Register a plugin to collect and upload source maps after compilation
      const plugins = (result.plugins as Array<Record<string, unknown>>) ?? [];
      plugins.push({
        apply(compiler: Record<string, unknown>) {
          const typedCompiler = compiler as WebpackCompiler;
          if (typedCompiler.hooks?.afterEmit?.tapPromise) {
            typedCompiler.hooks.afterEmit.tapPromise(
              "GlasstraceSourceMapUpload",
              async () => {
                await handleSourceMapUpload(distDir);
              },
            );
          }
        },
      });
      result.plugins = plugins;
    }

    return result;
  };

  return config;
}

/**
 * Collects source map files from the build output directory and uploads
 * them to the Glasstrace ingestion API. Never throws — all errors are
 * caught and logged as warnings so the build is never blocked.
 *
 * Exported for testing only; not part of the public API.
 *
 * @param distDir - The Next.js build output directory (e.g. ".next").
 */
export async function handleSourceMapUpload(distDir: string): Promise<void> {
  try {
    const apiKey = process.env.GLASSTRACE_API_KEY;
    const endpoint =
      process.env.GLASSTRACE_ENDPOINT ?? "https://api.glasstrace.dev";

    // Anonymous mode: skip upload
    if (!apiKey || apiKey.trim() === "") {
      console.info(
        "[glasstrace] Source map upload skipped (no API key). Stack traces will show compiled locations.",
      );
      return;
    }

    // Dynamic import: source-map-uploader uses node:fs, node:path, node:crypto,
    // and node:child_process. Deferring the import avoids a module-evaluation
    // crash when config-wrapper.ts is loaded in a non-Node bundler context.
    const { discoverSourceMapFiles, computeBuildHash, uploadSourceMaps } =
      await import("./source-map-uploader.js");

    const files = await discoverSourceMapFiles(distDir);

    if (files.length === 0) {
      console.info("[glasstrace] No source map files found. Skipping upload.");
      return;
    }

    const buildHash = await computeBuildHash(files);

    await uploadSourceMaps(apiKey, endpoint, buildHash, files);
    console.info(
      `[glasstrace] Uploaded ${String(files.length)} source map(s) for build ${buildHash}.`,
    );
  } catch (error: unknown) {
    // Build must NEVER fail because of Glasstrace
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.warn(
      `[glasstrace] Source map upload failed: ${message}. Build continues normally.`,
    );
  }
}
