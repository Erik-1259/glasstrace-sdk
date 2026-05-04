---
"@glasstrace/sdk": patch
---

DISC-1556 P0 hotfix (Option C from SDK-044 brief). Convert the silent
"auto-attach returned null" failure mode into a structured fail-loud
diagnostic: the SDK now emits a typed `otel:failed` lifecycle event,
persists a `lastError` field to `runtime-state.json` (with a sanitized
provider class identifier — never URLs, headers, or credentials), and
escalates the coexistence-path guidance log level from `warn` to
`error` under `NODE_ENV=production`. The README gains a "Production
deployment under Next 16" section documenting the manual
`createGlasstraceSpanProcessor()` workaround as the production-supported
integration path and the `getStatus().tracing === "not-configured"`
programmatic failure signal. Trace export under Next 16 production is
still impacted (auto-attach detection extension is queued for a follow-
up wave); this hotfix makes the failure observable so users can apply
the manual workaround. Existing public APIs (`getStatus`,
`RuntimeState`) gain optional fields only; no breaking changes.
