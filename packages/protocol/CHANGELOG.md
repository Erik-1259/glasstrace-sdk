# @glasstrace/protocol

## 0.22.0

### Minor Changes

- 9a7b70b: feat(sdk): bounded error stack + source provenance + framework-fallback
  markers in `glasstrace.error.*` (SDK-041; closes the SDK side of
  DISC-1535)

  The exporter now emits a curated set of bounded error-evidence
  attributes when a span carries OTel exception data (event-form via
  `recordException()` or attribute-form via `exception.stacktrace`),
  or when a framework rewrites the route to a fallback path. Product
  consumers (ingestion → MCP → dashboard) already accept these
  attributes via the MCP-019 / SCHEMA-033 rollout; the SDK side closes
  the missing emitter.

  ## New `@glasstrace/protocol` constants

  Additive (no rename, no removal). Wire keys remain in the existing
  `glasstrace.error.*` family.

  | SDK constant            | Wire key                           |
  | ----------------------- | ---------------------------------- |
  | `ERROR_STACK`           | `glasstrace.error.stack`           |
  | `ERROR_STACK_TRUNCATED` | `glasstrace.error.stack.truncated` |
  | `ERROR_STACK_REDACTED`  | `glasstrace.error.stack.redacted`  |
  | `ERROR_SOURCE`          | `glasstrace.error.source`          |
  | `ERROR_FRAMEWORK_KIND`  | `glasstrace.error.framework.kind`  |
  | `ERROR_ORIGINAL_PATH`   | `glasstrace.error.original_path`   |
  | `ERROR_FALLBACK_ROUTE`  | `glasstrace.error.fallback_route`  |

  Companion value-enum tuples + literal-union types for
  `glasstrace.error.source` and `glasstrace.error.framework.kind`
  land in a new `error-evidence.ts` module:

  - `ERROR_SOURCE_VALUES` / `ErrorSource`: `"otel_exception"` |
    `"otel_event"` | `"glasstrace_attribute"` |
    `"framework_runtime"` | `"framework_fallback"` |
    `"response_body"`.
  - `ERROR_FRAMEWORK_KIND_VALUES` / `ErrorFrameworkKind`:
    `"runtime"` | `"compile"` | `"fallback"` | `"unknown"`.

  ## SDK behaviour

  Bounded stack capture: when `exception.stacktrace` is observed
  (event preferred, span-attr fallback) on a non-OK span, the
  exporter promotes the string to `glasstrace.error.stack` after:

  1. Sanitization — absolute POSIX/Windows paths are normalized to a
     `<path>/<keep-marker>/...` form that drops the user's home
     directory and any other prefix above `node_modules`, `.next`,
     `.glasstrace`, `src`, `dist`, `build`, `lib`, `app`, or `pages`
     (priority order). `file:///` URIs are unwrapped first.
     `webpack-internal:///` and `node:` schemes pass through
     unchanged. URL query strings and fragments are stripped.
     Credentials are redacted using the same pattern set as
     `glasstrace.error.response_body` (Bearer / JWT / Glasstrace
     API keys / AWS access keys / generic key=value secrets).
  2. Truncation — bounded to 8192 UTF-8 bytes; `...[stack truncated]`
     marker appended on overflow. Codepoint-safe truncation via the
     same `TextEncoder`/`TextDecoder` walk used by
     `error-response-body.ts`.

  Sibling boolean attributes
  (`glasstrace.error.stack.truncated` /
  `glasstrace.error.stack.redacted`) tell product consumers when
  the bounded form is partial or has been modified.

  Source provenance: `glasstrace.error.source` is set to the
  narrowest applicable source — `otel_exception` (event) or
  `otel_event` (span attr) — when error facts come from OTel; or
  `framework_fallback` when the framework-rewrite path was the
  only signal. A more specific OTel source always wins over a
  broader framework marker.

  Framework fallback markers: when `http.route` is a known fallback
  (`/_error`, `/_not-found`, `/_404`, `/_500`) AND `http.url` /
  `url.full` / `http.target` resolves to a different requested
  path, the exporter emits `glasstrace.error.original_path`,
  `glasstrace.error.fallback_route`, and
  `glasstrace.error.framework.kind = "fallback"`. The existing
  `glasstrace.route` attribute is unchanged so existing consumers
  remain undisrupted; product reads `original_path` first per the
  Agent Evidence Engine SDK Attribute Contract §5.5.

  ## What's deferred

  - Parsed `StackFrameSummary[]` structured attribute output is
    out of scope for v1. Bounded `exception.stacktrace` input is
    the contract per SDK-041 Decision A; product owns
    `StackSummary` parsing via SCHEMA-033.
  - Next.js compile-diagnostic capture is out of scope per SDK-041
    Decision C. Production builds don't surface compile errors at
    runtime; dev-only capture would need new hooks plus a
    `captureConfig.compileDiagnostics` flag.
  - Health/degraded capture signals for unsupported framework
    modes are out of scope per SDK-041 Decision E. The SDK emits
    "missing evidence" implicitly by not setting attrs it cannot
    observe; explicit machine-readable degraded signaling lands
    separately under AESC §5.6.

  ## Backward compatibility

  All new wire keys are additive. Existing consumers keep working:

  - `glasstrace.error.message` / `code` / `category` / `field` /
    `response_body` continue to be emitted in the same situations as
    before; the _value_ that wins on a span where both an exception
    event AND `exception.*` span attributes are populated has flipped
    (see "Behavior change" below).
  - `glasstrace.route` continues to carry whatever the framework
    reports.
  - Spans without an exception event or fallback route emit no new
    attributes; the public API surface is unchanged for healthy
    spans.
  - Older SDK traces that lack the new fields are accepted by
    product ingestion as missing-evidence (the MCP-019 packet
    already disclaims absent stack / framework / log evidence).

  ### Behavior change — exception event now wins over span attributes

  Pre-1.6 SDKs preferred `attrs["exception.message"]` /
  `attrs["exception.type"]` over the `recordException()` event when
  both surfaces were populated on the same span. The OTel canonical
  surface for exceptions is the event; preferring span attributes
  mislabeled provenance and silently downgraded the higher-
  confidence source.

  This release inverts the precedence so the exception event wins.
  Span attributes are the fallback used only when no event is
  present, matching the new `glasstrace.error.stack` read order and
  the `glasstrace.error.source` precedence rule
  (`otel_exception > otel_event`).

  **Who is affected:** projects whose instrumentation populates BOTH
  the exception event AND `exception.*` span attributes with
  _different_ values. Most instrumentations choose one surface; this
  combination is rare. Projects on a single surface are unaffected
  because the alternative stays absent and the existing code path
  keeps firing.

  ## Tests

  - `error-stack.test.ts` (new file, 21 tests): pure helper coverage
    for path normalization (POSIX abs / Windows abs / `file://` /
    webpack-internal / node: / fallback-to-basename / rightmost-
    marker anchoring), URL query/fragment stripping, credential
    redaction (positive + false-positive guards), truncation
    (codepoint-safe boundary walk), end-to-end `prepareStack`.
  - `enriching-exporter.test.ts` (existing file, +14 tests in
    "SDK-041 error evidence v1" + 6 tests in "extractPathOnly"):
    exporter integration coverage for stack capture from event-
    attrs vs span-attrs, `glasstrace.error.source` enum,
    framework-fallback positive/negative cases, oversized
    truncation, credential redaction in the rendered attribute,
    backward-compat (no new attrs on healthy spans), provenance
    precedence when both OTel and framework signals fire.

  Pre-push gate: typecheck clean, lint clean, 2096 tests passing
  (was 2056 + 40 new), build clean (F003 edge gate passes,
  postbuild stamp gate passes).

  Wave 14 of the 2026-05-08 SDK-041 wave plan; closes DISC-1535
  PARTIAL → RESOLVED on the SDK side. Stable release is gated on
  the canary publishing cleanly and a product round-trip
  verification against the Agent Evidence Engine MCP-019 path.

## 0.21.3

### Patch Changes

- 6c516bc: feat(protocol): add side-effect evidence attribute name constants and value enums (SDK-049)

  Adds `glasstrace.side_effect.*` attribute name constants to
  `GLASSTRACE_ATTRIBUTE_NAMES` (4 top-level + 7 field + 7 omission =
  18 entries) and exports the operation-kind, semantic-field-key,
  omission-reason, operation-status, and operation-phase value tuples
  with their derived TypeScript types. The capture-config schema gains
  an additive `sideEffectEvidence` flag that defaults to `false`.
  Aligns the SDK protocol with the glasstrace-product side-effect
  evidence summary contract (SCHEMA-036, ING-023, MCP-024). Additive
  only; existing constants and config defaults are untouched.

## 0.21.2

### Patch Changes

- 7efaf28: Tighten `PresignedUploadResponseSchema`, `PresignedUploadRequestSchema`, and
  `SourceMapManifestRequestSchema` to mirror the backend canonical `.max()`
  bounds (DISC-1562):

  - `filePath` ≤ 512 characters (`MAX_SOURCE_MAP_FILE_PATH_LENGTH`)
  - `clientToken` ≤ 2048 characters
  - `pathname` ≤ 1024 characters
  - `maxBytes` / `sizeBytes` ≤ 50 MiB (`MAX_SOURCE_MAP_FILE_SIZE`)
  - `files` array ≤ 100 entries (`MAX_SOURCE_MAP_FILE_COUNT`, replacing the
    previously hard-coded literal so the cap is self-documenting)

  Also exports the three `MAX_SOURCE_MAP_*` constants from the package
  barrel so SDK code and external tooling can reference the same numeric
  ceilings the backend applies at write time.

  Each `.max()` carries an informative custom error message
  (e.g. `"filePath length exceeds maximum of 512 characters"`) so
  validation failures surface the offending field and limit instead of
  Zod's default `"string too long"`.

  Non-breaking patch: the backend canonical schema has enforced these
  bounds at the producer site since the upload pipeline shipped, so no
  historical response payload exceeds them. Third-party tooling that
  validates against the SDK schema now observes the same acceptance
  envelope the backend enforces, closing the residual contract drift
  DISC-1544 left open.

## 0.21.1

### Patch Changes

- 401e741: chore: update internal `@drift-check` anchors to reference the renamed component design `sdk-architecture.md` (was `sdk-2.0.md`).

  The companion glasstrace-product change renamed `docs/component-designs/sdk-2.0.md` to `docs/component-designs/sdk-architecture.md` so the filename no longer pins to a specific milestone. The rename ships the doc as a milestone-neutral architecture reference covering both the published SDK 1.x line and the next-major target.

  This patch propagates the rename into SDK-side citations so the published `dist/*.d.ts` JSDoc tooltips that consumers see in their IDE (e.g., on `DevApiKeySchema`, `AnonApiKeySchema`, `GLASSTRACE_ATTRIBUTE_NAMES`, `MAX_PENDING_SPANS`, `WELL_KNOWN_GLASSTRACE_PATH`) point at the live filename. `DRIFT.md` is updated in the same change.

  No runtime behavior change. No public API change. Pure JSDoc / documentation-string update.

## 0.21.0

### Minor Changes

- c5a4d31: feat(sdk): emit `glasstrace.build.hash` and `glasstrace.source.{file,line}` on error spans (SDK-040 / DISC-1543).

  The SDK now stamps three previously-dormant span attributes that the ingestion service has been reading since `@glasstrace/protocol@0.19.0`. With the writers in place, the source-map upload + resolver pipeline becomes live end-to-end: the dashboard renders mapped frames for error traces and the enrichment LLM prompt receives concrete source-location context.

  - `glasstrace.build.hash` — stamped on every server span. Read once at module load from `process.env.GLASSTRACE_BUILD_HASH`. Set the env var in your build/deploy step (typically `GLASSTRACE_BUILD_HASH=$(git rev-parse HEAD)`) so the runtime trace and the build-time source-map manifest agree on the same hash. When the env var is unset, the attribute is silently omitted — no behavior change for projects that have not adopted the convention.
  - `glasstrace.source.file` and `glasstrace.source.line` — stamped on the `glasstrace.error` span event by the manual `captureError()` API. Values come from the top user-attributable frame of `Error.stack`, with V8 internal frames (`node:internal/*`, `node:fs`, etc.) and SDK-internal frames (`@glasstrace/sdk` package or in-tree `packages/sdk/src/capture-error.ts`) skipped automatically. The reported `file:line` is the compiled-output path; ingestion's source-map resolver maps it back to the original source via the uploaded manifest.

  `@glasstrace/protocol` adds `BUILD_HASH: "glasstrace.build.hash"` to `GLASSTRACE_ATTRIBUTE_NAMES` (the other three keys were already declared). All three new emissions are additive, edge-bundle-clean, and gated to error spans where they apply — non-error spans do not carry source-frame attributes. The `process.env.GLASSTRACE_BUILD_HASH` read lives in a Node-only helper module (`build-info.ts`) imported only by `enriching-exporter.ts`, which is itself excluded from the edge bundle by the F003 runtime-partition gate.

  See the new "Source maps" section of the SDK README for the full configuration surface and behavior.

## 0.20.0

### Minor Changes

- b02a43f: Align `PresignedUploadResponseSchema` with the canonical backend wire schema (DISC-1544):

  - Add the per-file `access: z.enum(["public"])` field that the backend has been emitting since DISC-756. The SDK protocol previously omitted it from the response shape, so external consumers using the protocol package as their canonical wire spec would silently drop it on parse. The Glasstrace SDK itself runs a `.parse()` against this schema during source-map upload; the backend has always set the field, so this change is runtime-compatible across all currently-deployed backends.
  - Switch `expiresAt` from `z.number().int().positive()` to `z.number().int().nonnegative()` to match the backend's shared `TimestampSchema`. This is strictly more permissive (now accepts `0`); no SDK consumer relies on the prior strict-positive bound.

  Categorized as a minor bump per existing precedent for additive schema changes (e.g., `errorResponseBodies` in 0.14.0, `claimed`/`accountHint` in 0.11.0). Backend integrations consuming `@glasstrace/protocol@0.20.0` need no source changes — the canonical wire shape is unchanged.

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
