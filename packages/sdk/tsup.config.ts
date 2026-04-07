import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/init": "src/cli/init.ts",
    "cli/mcp-add": "src/cli/mcp-add.ts",
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
  sourcemap: true,
  clean: true,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
