/**
 * Structural view of Next.js's `NextConfig`. The SDK does not import Next's
 * type directly because Next is not a peer dependency — this wrapper must
 * type-check regardless of which Next.js version the consumer has installed.
 *
 * The constraint is `object` rather than `Record<string, unknown>` because
 * Next's actual `NextConfig` is an interface *without* a string index
 * signature. Requiring `[key: string]: unknown` would fail the assignability
 * check that caused DISC-1256, reported by Next 16 consumers as:
 *   > Argument of type 'NextConfig' is not assignable to parameter of type
 *   > 'NextConfig'. Index signature for type 'string' is missing in type
 *   > 'NextConfig'.
 *
 * `object` accepts every non-primitive value, which is what the wrapper
 * actually handles at runtime (it shallow-copies the input and reads a few
 * known properties defensively). Combined with the generic signature on
 * `withGlasstraceConfig`, callers preserve their exact config subtype.
 */
type NextConfig = object;
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
 * Detects whether the current `next build` invocation is using Turbopack.
 *
 * Next 16 made Turbopack the default bundler for `next build`. We detect it
 * via `process.argv` (the `--turbopack` flag or the absence of `--webpack`
 * on Next 16) and the `TURBOPACK` environment variable that Next sets
 * internally. Falls back to `false` in non-Node environments.
 */
function isTurbopackBuild(): boolean {
  if (typeof process === "undefined") return false;

  const argv = Array.isArray(process.argv) ? process.argv : [];
  if (argv.includes("--webpack")) return false;
  if (argv.includes("--turbopack")) return true;

  // Next sets TURBOPACK=1 when running its Turbopack pipeline.
  if (process.env?.TURBOPACK === "1") return true;

  return false;
}

/**
 * Package name the wrapper adds to Next's server-external-packages list.
 * Kept as a module-level constant so tests can reference the exact string
 * without risk of drift between implementation and assertion.
 */
const SDK_PACKAGE_NAME = "@glasstrace/sdk";

/**
 * Pushes `@glasstrace/sdk` onto both keys Next.js uses to mark a package
 * as server-external (loaded via Node's `require()` at runtime instead of
 * bundled through webpack/Turbopack).
 *
 * Next 15+ reads the stable top-level `serverExternalPackages`. Next 14 reads
 * the legacy `experimental.serverComponentsExternalPackages`. Writing both is
 * harmless on every supported Next version — the key the running Next does
 * not recognise is simply ignored — and avoids the need to detect the Next
 * version at config-time (which is not cleanly possible from inside a
 * `next.config.{js,ts}` callback).
 *
 * Dedupe is intentional: if the user already added `@glasstrace/sdk` to
 * either array, the entry is not duplicated. User entries are preserved in
 * their original order; the SDK entry is appended.
 *
 * This closes the `next dev --webpack` failure mode from DISC-1257: the
 * webpack dev bundler does not externalize any `node:` scheme, so a bundled
 * SDK chunk that imports `node:child_process` (and similar) crashes on
 * first request. Treating the SDK as a server-external package sidesteps
 * the bundler entirely on the instrumentation path.
 *
 * Mutates the `config` bag in place; callers pass the shallow-copied bag
 * owned by `withGlasstraceConfig`, so the user's original reference is not
 * affected.
 */
function ensureServerExternal(config: Record<string, unknown>): void {
  // Next 15+ stable key: top-level `serverExternalPackages`.
  const existingStable = config.serverExternalPackages;
  const stable: string[] = Array.isArray(existingStable)
    ? // Clone so we never mutate a caller-owned array in place.
      existingStable.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!stable.includes(SDK_PACKAGE_NAME)) {
    stable.push(SDK_PACKAGE_NAME);
  }
  config.serverExternalPackages = stable;

  // Next 14 legacy key: `experimental.serverComponentsExternalPackages`.
  const existingExperimental = config.experimental;
  const experimental: Record<string, unknown> =
    existingExperimental != null && typeof existingExperimental === "object"
      ? { ...(existingExperimental as Record<string, unknown>) }
      : {};
  const existingLegacy = experimental.serverComponentsExternalPackages;
  const legacy: string[] = Array.isArray(existingLegacy)
    ? existingLegacy.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!legacy.includes(SDK_PACKAGE_NAME)) {
    legacy.push(SDK_PACKAGE_NAME);
  }
  experimental.serverComponentsExternalPackages = legacy;
  config.experimental = experimental;
}

/**
 * Wraps the developer's Next.js config to enable source map generation
 * and upload .map files to the ingestion API at build time.
 *
 * The build NEVER fails because of Glasstrace — all errors are caught
 * and logged as warnings.
 *
 * ## What the wrapper configures for you
 *
 * - `experimental.serverSourceMaps: true` — enables server-side source maps
 *   so Glasstrace can resolve stack traces back to your source.
 * - `serverExternalPackages: ["@glasstrace/sdk"]` (Next 15+) and
 *   `experimental.serverComponentsExternalPackages: ["@glasstrace/sdk"]`
 *   (Next 14) — tells Next to load the SDK via Node's `require()` at runtime
 *   instead of bundling it through webpack or Turbopack. This is the same
 *   pattern Prisma, `@vercel/otel`, Sentry, `sharp`, and `bcrypt` ship with.
 *   It closes the `next dev --webpack` crash from DISC-1257 and is applied
 *   unconditionally for consistency with production builds.
 * - An empty `turbopack: {}` when none is set, so Next 16 does not reject
 *   the config for setting `webpack` without a companion `turbopack` key
 *   (DISC-1256).
 * - A `webpack` hook that collects and uploads `.map` files on client-side
 *   production builds.
 *
 * ## Turbopack
 *
 * Next.js 16 made Turbopack the default bundler for `next build`, and Next
 * rejects configs that set `webpack` without also setting `turbopack`. This
 * wrapper therefore seeds an empty `turbopack: {}` when the user has not set
 * one themselves, preserving existing behaviour for explicit Turbopack configs.
 *
 * **Source-map upload is currently webpack-only.** Under Turbopack the build
 * succeeds, but the afterEmit hook that collects and uploads `.map` files does
 * not fire. Run `next build --webpack` to get source-map uploads, or wait for
 * a follow-up release that ports the plugin to Turbopack.
 *
 * @param nextConfig - The developer's existing Next.js configuration object.
 * @returns A new config object with source map generation and upload enabled.
 *   The return type mirrors the input type so that caller-side config
 *   properties are preserved. The `object` constraint (rather than
 *   `Record<string, unknown>`) is what makes the wrapper accept Next's
 *   real `NextConfig` interface (DISC-1256).
 */
export function withGlasstraceConfig<T extends NextConfig>(nextConfig: T): T {
  // Guard: config wrapper requires Node.js for source map instrumentation.
  // In non-Node environments (Edge Runtime, browser), return config unchanged.
  if (typeof process === "undefined" || typeof process.versions?.node !== "string") {
    return (nextConfig != null ? { ...nextConfig } : ({} as T));
  }

  // Handle null/undefined gracefully
  const config: T = nextConfig != null ? { ...nextConfig } : ({} as T);
  // Mutable bag-of-props view of the same object. Using `object` as the
  // constraint (see the `NextConfig` type alias above) means `T` does not
  // declare the keys we touch — `experimental`, `turbopack`, `distDir`,
  // `webpack` — so we interact with them through this looser view while the
  // public return type stays faithfully `T`.
  const bag = config as Record<string, unknown>;

  // Enable server-side source map generation for Glasstrace uploads.
  // Intentionally does NOT set productionBrowserSourceMaps — that exposes
  // full source code publicly via browser DevTools. Users who want public
  // browser source maps can set it explicitly in their Next.js config.

  // Enable server-side source maps (Next.js experimental feature)
  const existingExperimental = (bag.experimental as Record<string, unknown>) ?? {};
  bag.experimental = {
    ...existingExperimental,
    serverSourceMaps: true,
  };

  // Mark the SDK as a server-external package (DISC-1257). This must run
  // after the `serverSourceMaps` assignment above because `ensureServerExternal`
  // also writes to `bag.experimental` — calling it first would have its work
  // clobbered by the spread. `ensureServerExternal` itself preserves any
  // existing `experimental` keys (including `serverSourceMaps`) by spreading.
  ensureServerExternal(bag);

  // Seed an empty Turbopack config when the user has not set one. Next 16
  // refuses builds that set `webpack` without a companion `turbopack` key
  // (DISC-1256). Merging preserves any existing Turbopack config the user
  // supplied — we only fill in the default.
  if (bag.turbopack == null) {
    bag.turbopack = {};
  }

  // One-time warning: source-map upload does not run under Turbopack yet.
  // Log at most once per process to avoid spamming repeated builds (dev mode,
  // watch mode). The warning goes to stderr via console.warn — intentionally
  // not using sdkLog so the message surfaces during the build even if SDK
  // logging is otherwise suppressed.
  if (isTurbopackBuild()) {
    warnTurbopackLimitationOnce();
  }

  // Capture distDir for source map collection (default: .next)
  const distDir = typeof bag.distDir === "string" ? bag.distDir : ".next";

  // Capture existing webpack config if any
  const existingWebpack = bag.webpack as WebpackConfigFn | undefined;

  // Register webpack config modifier
  bag.webpack = (
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

let _turbopackWarningEmitted = false;
function warnTurbopackLimitationOnce(): void {
  if (_turbopackWarningEmitted) return;
  _turbopackWarningEmitted = true;
  console.warn(
    "[glasstrace] Turbopack detected. Source-map upload currently runs only under webpack — " +
      "run `next build --webpack` to upload source maps, or wait for the Turbopack port in a future SDK release.",
  );
}

/**
 * Resets the one-shot Turbopack warning flag. For test use only.
 *
 * @internal
 */
export function _resetTurbopackWarningForTesting(): void {
  _turbopackWarningEmitted = false;
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
