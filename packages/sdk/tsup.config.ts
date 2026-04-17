import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/init": "src/cli/init.ts",
    "cli/uninit": "src/cli/uninit.ts",
    "cli/mcp-add": "src/cli/mcp-add.ts",
    "cli/status": "src/cli/status.ts",
    "cli/validate": "src/cli/validate.ts",
    "adapters/drizzle": "src/adapters/drizzle.ts",
  },
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  // Inline all runtime dependencies into the SDK bundle so consumers have
  // zero required dependencies. OTel's API uses Symbol.for on globalThis for
  // singleton coordination, making bundled and user-installed copies safe to
  // coexist. @vercel/otel and @prisma/instrumentation remain external (optional).
  noExternal: [
    "@glasstrace/protocol",
    "zod",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/core",
  ],
  dts: { resolve: [
    "@glasstrace/protocol",
    "zod",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/core",
  ] },
  // Disable tsup's ESM shim. The shim injects a top-level
  //   import path from "path";
  //   import { fileURLToPath } from "url";
  // pair into every emitted ESM chunk in order to synthesize
  // `__dirname`/`__filename` for code that was authored as CJS. Those static
  // top-level imports break `next dev --webpack`, which does not externalize
  // Node built-ins on the dev bundler path (DISC-1257).
  //
  // We can safely opt out because the SDK source does not reference
  // `__dirname`, `__filename`, or `import.meta.url` anywhere, and tsup/esbuild
  // emits an independent `__require()` polyfill (unrelated to this flag) that
  // keeps synchronous `require()` calls working in the ESM output.
  shims: false,
  sourcemap: true,
  clean: true,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
