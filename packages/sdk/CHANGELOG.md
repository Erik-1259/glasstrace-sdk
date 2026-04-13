# @glasstrace/sdk

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
