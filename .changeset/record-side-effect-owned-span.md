---
"@glasstrace/sdk": minor
---

Make categorical side-effect evidence robust to a missing active span

`recordSideEffect` now accepts an optional owned span —
`recordSideEffect(input, { span })` — that attaches the operation to a span you
control instead of the ambient active OTel span, mirroring the `capture()`
value-fidelity primitive. Use it when the host app's OTel context may not
survive intact to the call site (categorical evidence otherwise drops silently
when no span is recording). A supplied span that has ended or is a
`NonRecordingSpan` is a silent no-op and does not fall back to the ambient span.

When no recording span is available, the SDK now also emits a one-time
diagnostic under `verbose` — instead of dropping the evidence with no signal —
pointing at the fix (`tracedMiddleware`, or passing an owned span).
