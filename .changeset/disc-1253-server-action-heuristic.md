---
"@glasstrace/sdk": minor
"@glasstrace/protocol": patch
---

Add Next.js Server Action detection and extension-correlation support
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
