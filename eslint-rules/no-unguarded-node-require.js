/**
 * Custom ESLint rule: `glasstrace/no-unguarded-node-require`.
 *
 * Flags synchronous `require("node:*")` and equivalent shapes
 * (`createRequire(...)("node:*")`) anywhere in `packages/sdk/src/`.
 *
 * Why: when the SDK is loaded as an ESM module under a Next.js
 * dev/start server (or any other ESM-loader runtime), tsup's bundled
 * CJS-compatibility shim cannot resolve `require()` from an ESM scope
 * and throws "Dynamic require of '<spec>' is not supported". DISC-1555
 * documented the failure mode end-to-end. Every reachable sync
 * `require("node:*")` call site must therefore wrap the call in a
 * try/catch (or behind the `isSyncFsAvailable` probe) so the throw
 * converts into a graceful, observable-free outcome.
 *
 * The rule does not attempt to verify the try/catch wrapper
 * structurally — the AST shape of "guarded" varies (probe call, try
 * inside owner function, isolating the call inside a returns-null
 * helper) and a brittle structural check would produce false positives
 * for legitimate patterns and false negatives for novel ones. Instead
 * the rule treats any sync `require("node:*")` as a code-review
 * trigger: contributors disable the rule with an `eslint-disable-next-
 * line` comment that names the guard pattern in plain English. The
 * disable comment is the audit trail.
 *
 * To suppress at a specific call site, add the comment line above the
 * call:
 *
 *     // eslint-disable-next-line glasstrace/no-unguarded-node-require -- <reason>
 *
 * See `CONTRIBUTING.md` ("Synchronous `require("node:*")` discipline")
 * for the exhaustive guidance and DISC-1555 for the failure-mode
 * analysis.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag synchronous `require(\"node:*\")` calls that are not explicitly guarded for ESM-loader contexts (DISC-1555).",
      recommended: false,
    },
    schema: [],
    messages: {
      unguarded:
        "Synchronous `require(\"{{specifier}}\")` is unsafe under tsup's ESM `__require` shim (DISC-1555). Wrap the call in try/catch with a graceful fallback, then suppress with `// eslint-disable-next-line glasstrace/no-unguarded-node-require -- <reason>`.",
    },
  },
  create(context) {
    /**
     * Returns the literal `node:*` specifier of a CallExpression whose
     * callee is `require`, or `null` for any other shape (computed
     * member, non-literal argument, non-`node:` prefix, etc.).
     *
     * @param {import("estree").CallExpression} node
     */
    function nodeSpecifierFromRequireCall(node) {
      if (node.callee.type !== "Identifier" || node.callee.name !== "require") {
        return null;
      }
      if (node.arguments.length !== 1) return null;
      const arg = node.arguments[0];
      if (arg.type !== "Literal" || typeof arg.value !== "string") return null;
      if (!arg.value.startsWith("node:")) return null;
      return arg.value;
    }

    /**
     * Returns the literal `node:*` specifier passed to a
     * `createRequire(...)(...)` call, or `null` if any link in the chain
     * doesn't match the call shape (e.g. `createRequire` is called with
     * a non-literal argument, or the returned value is stored in a
     * variable rather than invoked inline).
     *
     * The rule deliberately matches only the chained-call form because
     * that is the form a contributor reaches for as a workaround when
     * the basic `require("node:*")` pattern is flagged. Detecting
     * indirected `const r = createRequire(...); r("node:fs");` would
     * require dataflow analysis the lint layer is not the right layer
     * for; a code review remains the backstop for that shape.
     *
     * @param {import("estree").CallExpression} node
     */
    function nodeSpecifierFromCreateRequireCall(node) {
      const callee = node.callee;
      if (callee.type !== "CallExpression") return null;
      if (
        callee.callee.type !== "Identifier" ||
        callee.callee.name !== "createRequire"
      ) {
        return null;
      }
      if (node.arguments.length !== 1) return null;
      const arg = node.arguments[0];
      if (arg.type !== "Literal" || typeof arg.value !== "string") return null;
      if (!arg.value.startsWith("node:")) return null;
      return arg.value;
    }

    return {
      CallExpression(node) {
        const fromRequire = nodeSpecifierFromRequireCall(node);
        if (fromRequire !== null) {
          context.report({
            node,
            messageId: "unguarded",
            data: { specifier: fromRequire },
          });
          return;
        }
        const fromCreateRequire = nodeSpecifierFromCreateRequireCall(node);
        if (fromCreateRequire !== null) {
          context.report({
            node,
            messageId: "unguarded",
            data: { specifier: fromCreateRequire },
          });
        }
      },
    };
  },
};

export default rule;
