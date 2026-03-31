import { defineConfig } from "vitest/config";

export default defineConfig({
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
