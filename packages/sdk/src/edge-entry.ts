/**
 * Edge-runtime entry point for `@glasstrace/sdk`.
 *
 * Re-exports the subset of the SDK surface whose import closure:
 *   - does not touch any Node built-in (`node:*`, `builtinModules`)
 *     or `@vercel/blob`, per the F003 closure scan in
 *     `scripts/check-edge-bundle.mjs`, AND
 *   - does not reference the Node `process` global at all, per the
 *     F003 global-usage scan in the same gate.
 *
 * Why the second constraint: edge runtimes (Cloudflare Workers,
 * Vercel Edge without Node compat, browsers) do not provide the
 * `process` global. A module that reads `process.env.X` crashes on
 * import when that read happens at top level, and crashes on call
 * when it happens inside a function body. The original SDK-028
 * reconnaissance only probed import closures; the `process`-global
 * scan was added in response to P1/P2 Codex review findings after
 * observing that `session.ts`, `fetch-classifier.ts`, and the
 * `env-detection.ts` functions all reach `process.env` either at
 * module init or via call-time reads. Those symbols therefore remain
 * behind `node-entry.ts`.
 *
 * Symbols blocked from the edge surface by this second constraint
 * (reclaim via DISC-1281):
 *   - `deriveSessionId`, `getOrigin`, `getDateString`, `SessionManager`
 *     — `session.ts` top-level `process.env` reads
 *   - `classifyFetchTarget` — `fetch-classifier.ts` top-level
 *     `process.env` reads
 *   - `readEnvVars`, `resolveConfig`, `isProductionDisabled`,
 *     `isAnonymousMode` — call-time `process.env` reads; the last
 *     two are pure functions of their input `ResolvedConfig` but the
 *     gate cannot distinguish that from the bundled output without
 *     AST-level analysis, so they move together with `readEnvVars` /
 *     `resolveConfig` to keep the boundary crisp.
 *
 * This entry point is **not wired into `package.json#exports` yet** —
 * SDK-030 wires the subpath. SDK-028 only proves the bundle can be
 * emitted cleanly.
 *
 * Implementation note: the re-exports below deliberately use the
 * `import { ... }; export { ... };` two-step form rather than the
 * shorter `export { ... } from "./mod.js";` form. tsup's ESM output
 * leaves `export ... from` re-exports as pass-through references
 * ("./errors.js") instead of bundling them into the entry's chunk,
 * producing a `dist/edge-entry.js` that fails to resolve at runtime
 * (the referenced sibling files never get emitted). The two-step form
 * forces esbuild to treat the bindings as real imports and inline the
 * symbols into the entry's chunk graph. See DISC-1280 for the
 * underlying tsup/esbuild behavior.
 */

import { SdkError } from "./errors.js";
import { GlasstraceSpanProcessor } from "./span-processor.js";
import { captureCorrelationId } from "./correlation-id.js";
import type { CorrelationIdRequest } from "./correlation-id.js";

export {
  SdkError,
  GlasstraceSpanProcessor,
  captureCorrelationId,
};

export type { CorrelationIdRequest };
