import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/init": "src/cli/init.ts",
    "adapters/drizzle": "src/adapters/drizzle.ts",
  },
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.build.json",
  // Inline @glasstrace/protocol and zod into the SDK bundle so consumers
  // have zero runtime dependencies. This ensures the SDK works with npm,
  // pnpm, yarn, and Bun without any transitive dependency issues.
  noExternal: ["@glasstrace/protocol", "zod"],
  dts: { resolve: ["@glasstrace/protocol", "zod"] },
  sourcemap: true,
  clean: true,
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
});
