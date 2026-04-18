import { isBuiltin as isNodeBuiltin } from "node:module";

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
 * Signature of a webpack 5 externals function in the array-of-entries form.
 * The `data` argument carries the import request; the `callback` signals
 * either an externalization decision (`"commonjs <specifier>"`) or a
 * pass-through (no second argument).
 *
 * Typed structurally rather than importing from `webpack` to keep the SDK
 * free of a webpack peer dependency.
 */
type WebpackExternalsFn = (
  data: { request?: string; context?: string; contextInfo?: unknown; getResolve?: unknown },
  callback: (err: Error | null, result?: string) => void,
) => void;

/**
 * Appends an externals entry to a webpack config that rewrites every
 * Node.js built-in import into a runtime CommonJS `require()`. This is
 * the piece of DISC-1257 that actually fixes `next dev --webpack`:
 * webpack dev-mode ships no default handler for the `node:` URI scheme
 * AND does not auto-externalize bare built-ins pulled through transitive
 * SDK dependencies (e.g. `import * as zlib from "zlib"` inside an OTel
 * exporter). Either form crashes the first render — `UnhandledSchemeError`
 * for `node:*`, `Can't resolve 'zlib'` for bare built-ins — unless the
 * wrapper tells webpack to treat them as runtime externals.
 *
 * Membership is decided by Node's own `isBuiltin` helper
 * (`node:module`, available since Node 18.6; SDK `engines` floor is
 * Node >= 20), so the list of built-ins stays authoritative across
 * Node versions — no hand-maintained allowlist to drift out of date.
 *
 * Webpack 5 accepts externals as a string, RegExp, object, function, or
 * array of any mixture of those. Next.js itself uses the array form. The
 * helper preserves whatever the user (or Next) already supplied:
 * - Array: append the new entry, user entries keep their positions.
 * - Function or object: wrap in an array with the user entry first so it
 *   takes precedence over the SDK's handler.
 * - Missing / nullish: initialise as a single-entry array.
 *
 * The emitted `commonjs <request>` form preserves whichever specifier the
 * caller used (prefixed or bare), which Node resolves natively on Node
 * >= 14.18 — well below the SDK's `engines` floor of Node >= 20.
 */
function appendNodeSchemeExternal(webpackConfig: Record<string, unknown>): void {
  const nodeBuiltinExternal: WebpackExternalsFn = (data, callback) => {
    const request = data.request;
    if (typeof request === "string" && isNodeBuiltin(request)) {
      callback(null, "commonjs " + request);
      return;
    }
    callback(null);
  };

  const existing = webpackConfig.externals;
  if (Array.isArray(existing)) {
    webpackConfig.externals = [...existing, nodeBuiltinExternal];
  } else if (existing == null) {
    webpackConfig.externals = [nodeBuiltinExternal];
  } else {
    // Function, object-map, RegExp, or string form — preserve as the first
    // array entry so user/Next externals resolve before the SDK's fallback.
    webpackConfig.externals = [existing, nodeBuiltinExternal];
  }
}

/**
 * Pushes `@glasstrace/sdk` onto Next.js's `serverExternalPackages` list so
 * the package is loaded via Node's `require()` at runtime instead of
 * bundled through webpack/Turbopack.
 *
 * Only the Next 15+ stable top-level key is written. The Next 14 legacy
 * `experimental.serverComponentsExternalPackages` key was dropped because
 * Next 16 logs a deprecation warning for it on every build. Next 14 is
 * EOL; webpack-dev users on Next 14 are covered by the companion
 * `node:*` externals function installed below, and Turbopack users on
 * Next 14 were already unaffected.
 *
 * Dedupe is intentional: if the user already added `@glasstrace/sdk` to
 * the array, the entry is not duplicated. User entries are preserved in
 * their original order; the SDK entry is appended.
 *
 * Note that `serverExternalPackages` only affects RSC and Route Handler
 * bundling — it does NOT externalize the instrumentation path under
 * `next dev --webpack` (see vercel/next.js#58003, #28774). The full fix
 * for DISC-1257 pairs this write with the `node:*` externals function.
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
 * - `serverExternalPackages: ["@glasstrace/sdk"]` — tells Next to load the
 *   SDK via Node's `require()` at runtime instead of bundling it through
 *   webpack or Turbopack on the RSC / Route Handler paths. This is the same
 *   pattern Prisma, `@vercel/otel`, Sentry, `sharp`, and `bcrypt` ship with.
 * - A webpack `externals` entry that marks every Node.js built-in import
 *   (both `node:*` and bare forms like `zlib` or `stream`) as a runtime
 *   `commonjs` require. `serverExternalPackages` does not apply to the
 *   instrumentation path under `next dev --webpack`
 *   (vercel/next.js#58003, #28774), so any bundled SDK chunk that imports
 *   `node:child_process` or the bare `zlib` specifier used by
 *   `@opentelemetry/otlp-exporter-base` would otherwise crash with
 *   `UnhandledSchemeError` or `Can't resolve 'zlib'`. This entry is the
 *   actual DISC-1257 fix for the dev-webpack path. Turbopack is
 *   unaffected — it ignores `config.webpack` and resolves Node built-ins
 *   natively.
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

  // Mark the SDK as a server-external package (DISC-1257). This covers the
  // RSC and Route Handler bundlers on Next 15+. The companion `node:*`
  // externals entry inside the `config.webpack` hook below is what actually
  // unblocks `next dev --webpack`.
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

    // DISC-1257: externalize Node.js built-in imports for the webpack path.
    const webpackContext = context as WebpackContext;

    // Next's `serverExternalPackages` only influences RSC / Route Handler
    // bundling; the instrumentation path under `next dev --webpack` still
    // runs transitive SDK imports through the dev bundler, which crashes
    // on any built-in module — `UnhandledSchemeError` for `node:*` and
    // `Can't resolve 'zlib'` / `'stream'` / etc. for bare specifiers used
    // by OTel's exporter dependencies (vercel/next.js#58003, #28774).
    //
    // Telling webpack to externalize every Node built-in as a runtime
    // CommonJS require resolves the crash on every SERVER webpack code
    // path — production build, dev server, instrumentation hook. We
    // scope it to `webpackContext.isServer` so client-side compilations
    // (where Next applies browser polyfills / fallbacks for things like
    // `buffer` / `stream` / `crypto`) are not affected. Emitting
    // `commonjs` externals on the client would bypass those fallbacks
    // and inject `require(...)` at runtime, which fails in the browser.
    // Turbopack ignores this field and resolves Node built-ins natively
    // on both client and server.
    if (webpackContext.isServer) {
      appendNodeSchemeExternal(result);
    }

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
