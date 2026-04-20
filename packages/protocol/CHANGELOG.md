# @glasstrace/protocol

## 0.19.1

### Patch Changes

- 0b2cfa1: Ship `@drift-check` JSDoc tags on the Tier-1 protocol surfaces tagged
  in SDK-031 (`DevApiKeySchema`, `AnonApiKeySchema`, `SessionIdSchema`,
  `DiscoveryResponseSchema`, `GLASSTRACE_ATTRIBUTE_NAMES`,
  `deriveSessionId`). TypeScript preserves these tags on the emitted
  `dist/index.d.ts`, so the published type surface has changed since
  `0.19.0` even though no runtime behavior did.

  The SDK-031 PR (#177) only declared a patch on `@glasstrace/sdk`. The
  repo's previous `.changeset/config.json` grouped `@glasstrace/protocol`
  and `@glasstrace/sdk` under `linked`, but `linked` only syncs versions
  among packages whose changesets **explicitly list them** — it does not
  auto-add unmentioned packages to the bump group. The protocol `.d.ts`
  change therefore shipped without a version bump. This changeset closes
  that gap.

## 0.19.0

### Minor Changes

- b204dbf: Export `deriveSessionId()` for client-side session ID derivation (DISC-1266). Enables consumers (e.g. the Glasstrace browser extension) to derive the same `SessionId` the SDK produces from the same inputs. The implementation is a pure-JavaScript SHA-256 so every runtime — Node CJS, Node ESM, modern browsers, Vercel Edge, Cloudflare Workers — produces a byte-identical result.

## 0.17.1

### Patch Changes

- 7ff75b0: Add `./package.json` to both packages' `exports` maps so tooling and smoke tests can read installed versions via `require('@glasstrace/<pkg>/package.json')` without hitting `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 22+. Also fixes the post-publish smoke workflow to read `node_modules/@glasstrace/<pkg>/package.json` via `fs.readFileSync` so it works against already-published versions that do NOT have `./package.json` in their exports map.

## 0.17.0

### Patch Changes

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
