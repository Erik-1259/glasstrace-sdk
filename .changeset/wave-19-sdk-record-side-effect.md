---
"@glasstrace/sdk": minor
---

feat(sdk): add `recordSideEffect` API with `sideEffectEvidence` capture-config opt-in (SDK-049)

Introduces a public `recordSideEffect(input)` API that attaches
allowlisted, non-sensitive semantic metadata about side-effect
operations (`email`, `calendar_link`, `webhook`, `external_api`,
`queue`, `after_callback`) to the current active OTel span. The SDK
enforces the allowlist client-side as defense-in-depth; the
glasstrace-product storage filter is a second defense, not the
primary boundary. Behavior is observational only: no provider calls,
no retries, no duplicates, never throws.

The new `captureConfig.sideEffectEvidence` flag defaults to `false`;
no `glasstrace.side_effect.*` attribute reaches the wire unless the
account explicitly opts in. Unsafe values (URLs, emails, tokens,
headers, prose-shaped whitespace) are silently dropped and replaced
with integer omission counters that never echo the rejected input.
