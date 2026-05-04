/**
 * Unit tests for the custom ESLint rule
 * `glasstrace/no-unguarded-node-require`. Covers the four call shapes
 * the rule classifies (positive cases) and the surrounding shapes the
 * rule deliberately leaves alone (negative cases). The accompanying
 * audit (`audit-DISC-1563.md`) lists each shipped call site and its
 * justification; this file is the regression guard for the rule
 * itself.
 *
 * Vitest hosts the test runner; ESLint's `RuleTester` does the
 * harness work.
 */
import { describe, it } from "vitest";
import { RuleTester, type Rule } from "eslint";
// The rule is authored as plain JS so it stays loadable from the flat
// ESLint config without a build step. TS sees the imported binding as
// `any`; the cast restores the structural shape ESLint's `RuleTester`
// expects without forcing the rule file to ship its own `.d.ts`.
import ruleImpl from "../../../eslint-rules/no-unguarded-node-require.js";

const rule = ruleImpl as Rule.RuleModule;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: "module",
  },
});

describe("glasstrace/no-unguarded-node-require", () => {
  it("classifies the documented call shapes", () => {
    ruleTester.run("no-unguarded-node-require", rule, {
      valid: [
        // Async ESM dynamic import is the audited-safe replacement and
        // must NOT be flagged.
        { code: 'const fs = await import("node:fs");' },
        { code: 'const fsp = await import("node:fs/promises");' },

        // Calling `require()` with a non-`node:` specifier is unrelated
        // to the DISC-1555 failure mode.
        { code: 'const lodash = require("lodash");' },
        { code: 'const local = require("./local-helper.js");' },

        // `require()` invoked with anything other than a single literal
        // string argument is out of scope (rule deliberately conservative).
        { code: 'const m = require(name);' },
        { code: 'const m = require();' },
        { code: 'const m = require("node:fs", "extra");' },

        // `createRequire` *imported but not invoked* in the call shape
        // the rule targets is out of scope.
        {
          code: [
            'import { createRequire } from "node:module";',
            'const r = createRequire(import.meta.url);',
            'const result = r;',
          ].join("\n"),
        },

        // Type-only `import("node:fs")` in a TS type position is
        // invalid JS for the parser; passing valid JS only ensures the
        // rule itself does not over-fire.
        { code: 'function load() { return null; }' },
      ],
      invalid: [
        {
          code: 'const fs = require("node:fs");',
          errors: [{ messageId: "unguarded" }],
        },
        {
          code: 'const path = require("node:path");',
          errors: [{ messageId: "unguarded" }],
        },
        {
          code: 'const crypto = require("node:crypto");',
          errors: [{ messageId: "unguarded" }],
        },
        // The `node:fs/promises` specifier is also a Node built-in; even
        // though async ESM import is the canonical loader for it, a
        // sync `require("node:fs/promises")` would still hit the tsup
        // shim and is therefore flagged.
        {
          code: 'const fsp = require("node:fs/promises");',
          errors: [{ messageId: "unguarded" }],
        },
        // Chained `createRequire(import.meta.url)("node:*")` is the
        // workaround a contributor reaches for when the basic
        // `require("node:fs")` is flagged. It carries the same failure
        // mode (the produced `require` is still bound to the tsup
        // shim's CJS-resolution path under bundled ESM output) and is
        // explicitly rejected.
        {
          code: [
            'import { createRequire } from "node:module";',
            'const fs = createRequire(import.meta.url)("node:fs");',
          ].join("\n"),
          errors: [{ messageId: "unguarded" }],
        },
      ],
    });
  });
});
