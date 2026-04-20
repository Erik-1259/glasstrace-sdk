# @glasstrace/sdk

## 0.20.1

### Patch Changes

- f9ef5bc: Add internal `WELL_KNOWN_GLASSTRACE_PATH` constant in
  `packages/sdk/src/cli/discovery-file.ts`.

  The new constant is the RFC 8615 static discovery-file path
  (`.well-known/glasstrace.json`) served by `sdk init` under the
  framework-specific static root. It replaces two duplicated string
  literals in `relativeDiscoveryPath` and carries a `@drift-check`
  JSDoc anchor so a future maintenance pass can verify the path
  against the design doc and the RFC.

  The change is additive and internal. `cli/discovery-file` is not
  in this package's `exports` map, so the constant is not reachable
  by external consumers and no published behavior changes. The
  changeset exists to trigger the linked-changeset co-bump and to
  document the extraction in the changelog.

  See `DRIFT.md` and `../glasstrace-product/docs/component-designs/sdk-2.0.md`
  §7.1 (Static discovery file).

  **Changeset linkage note.** `.changeset/config.json` declares
  `linked: [["@glasstrace/protocol", "@glasstrace/sdk"]]`, so this patch
  bump on `@glasstrace/sdk` will co-bump `@glasstrace/protocol` to the
  same patch level even though no protocol API changed in this
  changeset. That is expected behavior for linked packages.

## 0.20.0

### Minor Changes

- e6df410: Write a static discovery file at `public/.well-known/glasstrace.json`
  during `glasstrace init` so the Glasstrace browser extension can locate
  the project's anonymous key without a runtime HTTP handler. SvelteKit
  projects receive the file at `static/.well-known/glasstrace.json`.
  Re-running `init` preserves any user-added fields and only rewrites when
  the on-disk anonymous key has changed.

  `glasstrace uninit` now removes the discovery file and, when empty, the
  enclosing `.well-known/` directory. Sibling content (for example a
  project-maintained `security.txt`) is never touched.

  `createDiscoveryHandler` is deprecated and prints a one-time warning on
  first invocation. It remains functional for this release line and will
  be removed in `v1.0.0`. Users who wired the handler into `middleware.ts`
  (Next.js 15 and earlier) or `proxy.ts` (Next.js 16 and later) can remove
  it entirely after running `init` to generate the static file; the README
  contains before/after migration snippets for both cases.

## 0.19.0

### Patch Changes

- b204dbf: Re-export `deriveSessionId` from `@glasstrace/protocol` (DISC-1266). The SDK's session ID derivation now runs through a pure-JavaScript SHA-256 implementation, so CJS, ESM, browser, and Edge runtimes all produce the same `SessionId` for the same inputs. Node CJS session IDs are unchanged; Node ESM and browser/Edge runtimes that previously fell back to a non-SHA-256 hash now produce the contract-defined SHA-256 value.

## 0.18.0

### Minor Changes

- c4980aa: Coexistence-aware signal handler: always installed, re-raises only when not in coexistence mode (DISC-1265). Scenario B state is set synchronously before handler installation so signals arriving in the async setup window do not race against an existing provider's flush. Scenario B users now receive heartbeat telemetry on exit.

## 0.17.3

### Patch Changes

- 3827c9b: Register a lifecycle shutdown hook on the @vercel/otel path to flush buffered spans on SIGTERM (DISC-1263). @vercel/otel does not self-flush on process exit; this hook closes the gap.

## 0.17.2

### Patch Changes

- f0ecf07: Remove `apiKey` from outbound request bodies — credentials are sent exclusively via the `Authorization: Bearer` header (DISC-782, DISC-1156). Adds a dedicated regression test suite and a security note in the package README.
- a952a5c: SDK hygiene: fix nested-catch double-counting of recordInitFailure (DISC-1121), codify health-report invariant (DISC-1123), fix stale MCP tool count in generateInfoSection (DISC-1222).
- de523ca: Update `@vercel/otel` peer dependency range to `^2.0.0` (DISC-1264).

  The previous peer range of `^1.0.0` was effectively broken: `@vercel/otel@1.x`
  requires `@opentelemetry/sdk-trace-base@<2.0.0`, but `@glasstrace/sdk` depends
  on `@opentelemetry/sdk-trace-base@^2.6.1`, making joint installation impossible
  (ERESOLVE). The updated range reflects the version the SDK actually supports and
  eliminates the spurious `unmet peer` warning for users on `@vercel/otel@2.x`.

## 0.17.1

### Patch Changes

- 7ff75b0: Add `./package.json` to both packages' `exports` maps so tooling and smoke tests can read installed versions via `require('@glasstrace/<pkg>/package.json')` without hitting `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 22+. Also fixes the post-publish smoke workflow to read `node_modules/@glasstrace/<pkg>/package.json` via `fs.readFileSync` so it works against already-published versions that do NOT have `./package.json` in their exports map.

## 0.17.0

### Minor Changes

- 1da83f7: Add Next.js Server Action detection and extension-correlation support
  (DISC-1253). The enriching exporter now sets
  `glasstrace.next.action.detected = true` on spans where a POST targets
  a page route (not `/api/*`, not `/_next/*`) — the same post-hoc
  pattern used for tRPC procedure extraction. A new public helper
  `captureCorrelationId(req)` reads the `x-gt-cid` header and materializes
  it as `glasstrace.correlation.id` on the active span, enabling
  correlation with Glasstrace browser extension data; call it from a
  Next.js `middleware.ts` or a custom server request hook. When a
  Server Action trace is detected without a correlation ID, a one-time
  stderr nudge recommends installing the browser extension; silence it
  with `GLASSTRACE_SUPPRESS_ACTION_NUDGE=1`. `@glasstrace/protocol`
  exports a new `NEXT_ACTION_DETECTED` attribute name.

## 0.16.0

### Minor Changes

- 5586a4f: Detect `src/` layout and merge into existing `instrumentation.ts` instead of overwriting (DISC-493 Issue 1). Fixes the silent-init failure on every Next.js app using `src/` as its root layout.
- c9e95b9: Auto-attach the Glasstrace span processor onto an existing OTel provider (Next.js 16 production, Sentry, Datadog, New Relic) instead of silently giving up. Closes the "no traces exported" black hole documented in DISC-493 Issues 2 and 4. Auto-attach reuses the `createGlasstraceSpanProcessor()` primitive, so the automatic and manual integration paths share identical wiring and idempotence via the branded exporter symbol.
- e62c206: Bypass Next.js 16's patched `fetch` for `/v1/sdk/init` using `node:https`
  directly, and verify anon-key registration during CLI `glasstrace init`
  instead of relying on runtime fire-and-forget. Resolves the silent
  init-hang (DISC-493 Issue 3) and the silently-unlinked anon-key
  (DISC-494) in one PR.

  - The SDK now issues its init request via `node:https`, with a 10-second
    per-request timeout, 500 ms + 1500 ms retry backoff on transport
    failures, and a 20-second total deadline. Server HTTP 4xx/5xx
    responses are surfaced immediately and never retried.
  - `glasstrace init` now blocks on a verification call before reporting
    success. On failure it exits with code `2` and an error message
    distinguishing three classes: `fetch failed`, `server rejected the
key`, and `server returned malformed response`.
  - No new runtime dependencies — `node:https` is a Node.js core module
    and adds zero bundle weight to the tsup-inlined SDK.
  - Set `GLASSTRACE_SKIP_INIT_VERIFY=1` to skip verification for offline
    installs. CI mode skips verification automatically.

### Patch Changes

- 0a396b5: Fix `next dev --webpack` compatibility with `@glasstrace/sdk`. DISC-1257
  is a four-part fix that spans the SDK's emit pipeline and the Next.js
  config wrapper:

  - `shims: false` in tsup. The stock `esm_shims.js` injected static
    top-level `import path from "path"` and `import { fileURLToPath } from
"url"` pairs into every emitted ESM chunk to synthesize `__dirname` /
    `__filename`. The SDK source does not reference any of those symbols,
    so the shim was dead weight and now disabled.
  - `removeNodeProtocol: false` in tsup. tsup was rewriting SDK-source
    `node:fs/promises` / `node:path` / `node:crypto` imports to the
    unprefixed form before emit. Node 14.18+/16+ supports the `node:`
    prefix natively, and the SDK already requires Node >= 20, so
    preserving the prefix verbatim is a straight improvement.
  - `withGlasstraceConfig()` pushes `@glasstrace/sdk` onto
    `serverExternalPackages` (Next 15+). Next loads the SDK via Node's
    `require()` on the RSC and Route Handler paths instead of routing it
    through webpack — the same pattern Prisma, `@vercel/otel`, Sentry,
    `sharp`, and `bcrypt` ship with. The Next 14 legacy
    `experimental.serverComponentsExternalPackages` key is no longer
    written because Next 16 logs a deprecation warning for it.
  - `withGlasstraceConfig()` now also installs a webpack `externals`
    function that rewrites every Node.js built-in import — both `node:*`
    and the bare form (`zlib`, `stream`, etc.) used by transitive
    dependencies like `@opentelemetry/otlp-exporter-base` — into a
    runtime `commonjs` require. Membership is decided by Node's own
    `isBuiltin` helper so the list stays version-correct automatically.
    `serverExternalPackages` alone does not reach the
    `next dev --webpack` instrumentation path (vercel/next.js#58003,
    #28774); the externals function is what actually unblocks the dev
    server on webpack, and it's harmless on production webpack builds
    and Turbopack (which resolves Node built-ins natively and ignores
    this field).

  Production builds (Turbopack or webpack) were unaffected. Teams running
  `next dev --webpack` with `@glasstrace/sdk` are now unblocked
  (DISC-1257).

## 0.15.1

### Patch Changes

- 5f8a374: Migrate heartbeat shutdown handlers onto the lifecycle coordinator so OTel flush and final health-report fire in a deterministic order.

## 0.15.0

### Minor Changes

- 51b4295: Harden `sdk init` / `sdk uninit` lifecycle across six install/uninstall
  scenarios: uninit-while-running (shutdown marker file), re-install
  preservation (anon key, config cache, and diff-aware MCP prompts), npm
  uninstall warning (`preuninstall` script), partial-uninit validation
  (`sdk init --validate`), atomic config writes, and dev-key preservation
  in both `.env.local` and the uninit confirmation flow (DISC-1247,
  DISC-1251).

### Patch Changes

- 6dcef64: Register SIGTERM/SIGINT handlers earlier so spans are not lost when a signal arrives during OTel setup (DISC-1249).

  Signal handlers are now installed synchronously inside `registerGlasstrace()` (after the production-disabled check and the synchronous OTel provider probe), rather than at the end of the async `configureOtel()` chain. This closes a timing window where a SIGTERM / SIGINT received during the `@vercel/otel` probe or provider registration would be delivered with no handler attached, silently dropping buffered spans. Handlers are installed only when this SDK will own the provider (Scenario A); in coexistence mode the existing provider continues to own signal shutdown unchanged.

## 0.14.2

### Patch Changes

- 9e4935e: Fix Next.js 16 compatibility in `withGlasstraceConfig` and the source-map uploader

  - **DISC-1255** — `@vercel/blob/client` is now imported via the `Function("id", "return import(id)")` dynamic-import evasion helper. This prevents webpack, tsup, esbuild, and rollup from resolving the specifier at build time, which previously broke every webpack-based Next.js consumer that did not have the optional `@vercel/blob` peer dependency installed.
  - **DISC-1256** — `withGlasstraceConfig<T extends object>(config: T): T` now accepts Next's actual `NextConfig` interface (which has no string index signature) and preserves the caller's config subtype, resolving the Next 16 type-check error. The wrapper also seeds an empty `turbopack: {}` when none is provided so `next build` (which defaults to Turbopack in Next 16) no longer rejects the injected `webpack` config. A one-time warning explains that source-map upload currently runs only under `next build --webpack`; Turbopack parity is a follow-up.

  CI now guards against regressions with (a) a grep check against the shipped SDK bundle for literal `import("@vercel/blob/client")` / `import("@vercel/otel")` calls, and (b) a `next-compat` job that scaffolds a bare Next.js app and runs both `next build` and `next build --webpack`.

## 0.14.1

### Patch Changes

- 671e360: Re-release 0.14.0 content as 0.14.1 on the `latest` dist-tag.

  Version 0.14.0 was built correctly from `main` but published under the
  `canary` dist-tag due to a workflow misuse (a canary dispatch ran after
  the version PR had already consumed the changesets, causing the empty
  snapshot to publish the current stable semver as a canary). The canary
  publish path in `release.yml` now fails fast when no changesets are
  present, preventing this class of mis-tag going forward.

## 0.14.0

### Minor Changes

- 4f4abe8: Add OTel provider coexistence, lifecycle state machine, and public APIs

  - OTel coexistence: auto-attach to existing providers (Sentry, Datadog) via tiered detection (DISC-1202)
  - New public API: createGlasstraceSpanProcessor() for clean manual Sentry integration
  - New public APIs: isReady(), waitForReady(), getStatus() for lifecycle state querying
  - Lifecycle state machine with validated transitions across core, auth, and OTel layers
  - Unified shutdown coordinator with signal + beforeExit triggers
  - Runtime state bridge (.glasstrace/runtime-state.json) for CLI diagnostics
  - tRPC procedure name extraction from URL path (DISC-1215)
  - Error response body config scaffolding (DISC-1216 Phase 1)
  - Prisma instrumentation on bare OTel path (DISC-1223)
  - Remove API key from request bodies — credentials sent exclusively via Authorization header (DISC-1017)
  - Symbol.for('glasstrace.exporter') branding for cross-bundle processor detection

## 0.13.6

### Patch Changes

- 06ed0b5: Detect error traces via exception events when span status is UNSET — the Next.js dev server timing race can export spans before closeSpanWithError runs, but exception events from recordException are still present (DISC-1204).

## 0.13.5

### Patch Changes

- 0280d36: Fix context manager race condition — use static import of AsyncLocalStorage instead of async dynamic import that resolved after installContextManager() was called (DISC-1183).

## 0.13.4

### Patch Changes

- 84eb43e: Fix ESM context manager installation — use `createRequire` from `node:module` instead of `Function("require")` which fails in ESM global scope (DISC-1183).

## 0.13.3

### Patch Changes

- 1fa0fc8: Fix context manager timing — register AsyncLocalStorage context manager synchronously in registerGlasstrace() before configureOtel() runs, so Next.js spans created during async OTel setup inherit trace context (DISC-1183).

## 0.13.2

### Patch Changes

- b0b9e37: Fix trace context propagation — switch from BasicTracerProvider to NodeTracerProvider so spans from the same HTTP request share a traceId and have proper parent-child relationships (DISC-1183).

## 0.13.1

### Patch Changes

- 29b8d80: Add per-span trace context diagnostics in verbose mode for traceId/parentSpanId propagation analysis.

## 0.13.0

### Minor Changes

- 4f0798e: Add `glasstrace status` CLI command for machine-readable SDK configuration state (DISC-1179). Reports whether the SDK is installed, initialized, and fully configured — designed for AI agents to determine what action to take.

## 0.12.6

### Patch Changes

- fd22187: Remove DISC-1133 diagnostic logging — investigation confirmed the trace drop issue is backend-side (DISC-1157), not SDK-side.

## 0.12.5

### Patch Changes

- 570add7: Fix error status code inference for Next.js dev server timing race (DISC-1134) and add trace pipeline diagnostics in verbose mode for DISC-1133 investigation.

## 0.12.4

### Patch Changes

- ee4c771: Add periodic health heartbeat that reports SDK health metrics to the backend every 5 minutes after successful init. Includes exponential backoff with jitter on rate-limit (429) responses, shutdown health report on SIGTERM/SIGINT, and concurrent tick protection. Also fixes nested catch double-count (DISC-1121), documents ZodError double-reporting trade-off (DISC-1120), and corrects JSDoc on span export counting (DISC-1118).

## 0.12.3

### Patch Changes

- 82d2fa6: Fix trace capture rate by reducing BatchSpanProcessor flush interval from 5 seconds to 1 second, adding export failure logging so OTLP errors are no longer silent, fixing forceFlush to drain pending span batches, and enabling OTel diagnostic logging in verbose mode.

## 0.12.2

### Patch Changes

- fce4407: Add SDK health report collection to init call. Each `POST /v1/sdk/init` request now includes span export/drop counts, init failure counts, and config staleness metrics, enabling the backend to surface SDK health issues in the dashboard.

## 0.12.1

### Patch Changes

- f075582: Source map uploads now stream files individually instead of loading all into memory simultaneously, reducing peak memory usage for large projects.

## 0.12.0

### Minor Changes

- 879c6ef: SDK runtime modules no longer crash in non-Node environments. Session ID derivation falls back to a deterministic hash when node:crypto is unavailable. File-system operations use dynamic imports to avoid bundler failures.

### Patch Changes

- 005db52: Init now automatically rolls back completed scaffolding steps when a later step fails, preventing half-configured projects.

## 0.11.0

### Patch Changes

- 3e0e551: Discovery endpoint now includes `claimed: true` when the anonymous key has been linked to an account.

## 0.10.0

### Minor Changes

- 65a3004: SDK now gracefully handles non-Node.js environments (Edge Runtime, Cloudflare Workers) by disabling instrumentation with a clear warning instead of crashing on missing built-in module imports.

### Patch Changes

- a2a8f3e: Uninit now correctly handles next.config expressions containing parentheses or braces inside string literals and comments. Windsurf global config modifications now show the full file path in output.

## 0.9.1

### Patch Changes

- 766acd1: Added `sideEffects` field to package.json to enable bundler tree-shaking of unused exports.
- 83f7904: Fixed race condition in anonymous key creation where concurrent cold starts could end up with different keys.
- 37f5358: MCP connection nudge now fires on the first captured console.error, not just on explicit captureError() calls.

## 0.9.0

### Minor Changes

- a870032: Added `npx @glasstrace/sdk uninit` command that cleanly reverses all init artifacts. Supports `--dry-run` to preview changes.
- 5707f7c: Init now detects monorepo roots and automatically finds the Next.js app to scaffold into. Supports pnpm workspaces, npm workspaces, Turborepo, and Lerna monorepos.

## 0.8.0

### Minor Changes

- ad5e5e2: Init now injects registerGlasstrace() into existing instrumentation.ts files instead of skipping them. Projects with pre-existing Prisma, Sentry, or other instrumentation no longer need to manually add the Glasstrace registration call.

## 0.7.3

### Patch Changes

- 937d941: Fix first-run MCP setup by generating the anonymous key during init instead of requiring a separate dev server start, and guard against empty next.config files producing misleading "already wrapped" messages

## 0.7.2

### Patch Changes

- 6659716: Add error.stack to captureError, fix sideEffects field, improve documentation, and refactor internals

## 0.7.1

### Patch Changes

- 811cf91: Prevent API key exposure in claim result logging — keys are now written to .env.local instead of stderr

## 0.7.0

### Minor Changes

- d305b68: Add presigned source map upload for builds exceeding Vercel's 4.5MB serverless body limit

## 0.6.0

### Minor Changes

- 6329f5c: Handle account claim transitions in SDK init — automatically logs migration instructions when an anonymous key is linked to an account

## 0.4.2

### Patch Changes

- 945d2ad: Fix TOCTOU race in anonymous key generation and harden span attribute type guards

## 0.4.1

### Patch Changes

- 57586c6: Fix CodeQL ReDoS patterns in source-map-uploader and import-graph; wire first-error MCP nudge into captureError

## 0.4.0

### Minor Changes

- 1ab7ba3: Add `glasstrace mcp add` command for explicit MCP server registration with AI coding agents

## 0.3.0

### Minor Changes

- eba313a: Add MCP auto-configuration to `glasstrace init` — automatically detects AI coding agents and writes native MCP config files

## 0.2.3

### Patch Changes

- bcbb81a: Bundle OpenTelemetry packages (@opentelemetry/api, @opentelemetry/sdk-trace-base,
  @opentelemetry/exporter-trace-otlp-http) into the SDK so traces flow to the backend
  immediately after installation. No additional packages required. @opentelemetry/api
  is kept as an optional peer dependency for version compatibility with existing OTel
  installations.

## 0.2.2

### Patch Changes

- 17fa6ae: Treat empty-string GLASSTRACE_API_KEY as unset so the anonymous flow activates correctly after glasstrace init. The CLI now writes the API key as a comment in .env.local and clarifies that anonymous mode works by default.

## 0.2.1

### Patch Changes

- 243e2c1: Bundle @glasstrace/protocol and zod into the SDK so the package has zero mandatory dependencies. Consumers only need `npm install @glasstrace/sdk` plus their chosen OTel packages (all optional peer dependencies). Works with npm, pnpm, yarn, and Bun out of the box.

## 0.2.0

### Minor Changes

- 818cb18: Add opt-in console error capture and manual captureError API:

  - New `consoleErrors` field in CaptureConfig (default: false). When enabled, console.error and console.warn calls are recorded as span events on the active OTel span.
  - New `captureError(error)` function for manual error reporting, works regardless of consoleErrors config.
  - SDK's own log messages (prefixed with "[glasstrace]") are never captured.

- d4587e8: Initial release of the Glasstrace SDK and protocol packages.

  - `@glasstrace/protocol`: Shared types and wire format schemas (branded IDs, configuration, SDK init response, discovery, source map upload)
  - `@glasstrace/sdk`: Server-side debugging SDK for AI coding agents (OpenTelemetry instrumentation, span enrichment, anonymous key management, CLI scaffolder, Drizzle adapter)

- f2a551d: Harden OTel configuration for production reliability:

  - Switch from SimpleSpanProcessor to BatchSpanProcessor for OTLP exports, preventing event loop blocking on every span.end() call. SimpleSpanProcessor is retained only for the ConsoleSpanExporter debug fallback.
  - Stop silently overwriting existing OTel TracerProviders. If another tracing tool (Datadog, Sentry, New Relic) has already registered a provider, Glasstrace now skips registration and logs instructions for coexistence.
  - Register SIGTERM/SIGINT shutdown hooks to flush in-flight spans on process exit, preventing trace loss during graceful shutdowns.

### Patch Changes

- de777d0: Fix exporter resilience issues that could cause trace loss or stale authentication:

  - Defer span enrichment to flush time so buffered spans get session IDs computed with the resolved API key instead of the "pending" placeholder.
  - Close the buffer/flush race window by re-checking the key state after buffering.
  - Recreate the OTLP delegate exporter when the API key changes, supporting key rotation without restart.

- 28b35d7: Consume HTTP response bodies on error paths to prevent connection pool leaks under sustained error conditions.
- Updated dependencies [818cb18]
- Updated dependencies [d4587e8]
  - @glasstrace/protocol@0.2.0
