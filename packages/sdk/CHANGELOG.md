# @glasstrace/sdk

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
