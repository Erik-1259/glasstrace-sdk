import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noUnguardedNodeRequire from "./eslint-rules/no-unguarded-node-require.js";

/**
 * Custom plugin scoped to the `glasstrace` namespace. The single rule
 * `no-unguarded-node-require` enforces the DISC-1555 discipline:
 * every synchronous `require("node:*")` call site in the
 * SDK source must be reviewed for ESM-loader compatibility and
 * suppressed with a reasoned `eslint-disable-next-line` directive. See
 * `CONTRIBUTING.md` and `eslint-rules/no-unguarded-node-require.js`.
 */
const glasstracePlugin = {
  rules: {
    "no-unguarded-node-require": noUnguardedNodeRequire,
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/", "**/node_modules/", "**/coverage/"],
  },
  {
    files: ["packages/sdk/src/**/*.{ts,tsx,js,mjs,cjs}"],
    plugins: {
      glasstrace: glasstracePlugin,
    },
    rules: {
      "glasstrace/no-unguarded-node-require": "error",
    },
  },
);
