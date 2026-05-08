---
"@glasstrace/sdk": minor
"@glasstrace/protocol": minor
---

feat(sdk): bounded error stack + source provenance + framework-fallback
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

| SDK constant | Wire key |
|---|---|
| `ERROR_STACK` | `glasstrace.error.stack` |
| `ERROR_STACK_TRUNCATED` | `glasstrace.error.stack.truncated` |
| `ERROR_STACK_REDACTED` | `glasstrace.error.stack.redacted` |
| `ERROR_SOURCE` | `glasstrace.error.source` |
| `ERROR_FRAMEWORK_KIND` | `glasstrace.error.framework.kind` |
| `ERROR_ORIGINAL_PATH` | `glasstrace.error.original_path` |
| `ERROR_FALLBACK_ROUTE` | `glasstrace.error.fallback_route` |

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
  `response_body` are unchanged.
- `glasstrace.route` continues to carry whatever the framework
  reports.
- Spans without an exception event or fallback route emit no new
  attributes; the public API surface is unchanged for healthy
  spans.
- Older SDK traces that lack the new fields are accepted by
  product ingestion as missing-evidence (the MCP-019 packet
  already disclaims absent stack / framework / log evidence).

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
