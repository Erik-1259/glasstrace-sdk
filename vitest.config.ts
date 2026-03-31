import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@glasstrace/protocol": path.resolve(__dirname, "packages/protocol/src/index.ts"),
    },
  },
  define: {
    __SDK_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        perFile: true,
        lines: 80,
      },
    },
  },
});
