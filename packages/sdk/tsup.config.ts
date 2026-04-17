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
  // Provides CJS compatibility shims (require, __filename, import.meta.url)
  // for the ESM output. Required because some SDK modules use synchronous
  // require() for optional features (e.g., loadFsSyncOrNull, getHashFn).
  shims: true,
  sourcemap: true,
  clean: true,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
