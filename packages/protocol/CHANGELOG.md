# @glasstrace/protocol

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

- 4f4abe8: Add tRPC procedure and error response body attributes to protocol schema

  - New attribute: glasstrace.trpc.procedure for tRPC procedure name extraction
  - New attribute: glasstrace.error.response_body for error response body capture
  - New config field: errorResponseBodies (boolean, default false) in CaptureConfigSchema

## 0.11.0

### Minor Changes

- 3e0e551: Added `claimed` and `accountHint` optional fields to `DiscoveryResponseSchema` for account claim signaling.

## 0.5.0

### Minor Changes

- 16656dd: Add claim result field to SdkInitResponse and presigned source map upload types

## 0.2.0

### Minor Changes

- 818cb18: Add opt-in console error capture and manual captureError API:

  - New `consoleErrors` field in CaptureConfig (default: false). When enabled, console.error and console.warn calls are recorded as span events on the active OTel span.
  - New `captureError(error)` function for manual error reporting, works regardless of consoleErrors config.
  - SDK's own log messages (prefixed with "[glasstrace]") are never captured.

- d4587e8: Initial release of the Glasstrace SDK and protocol packages.

  - `@glasstrace/protocol`: Shared types and wire format schemas (branded IDs, configuration, SDK init response, discovery, source map upload)
  - `@glasstrace/sdk`: Server-side debugging SDK for AI coding agents (OpenTelemetry instrumentation, span enrichment, anonymous key management, CLI scaffolder, Drizzle adapter)
