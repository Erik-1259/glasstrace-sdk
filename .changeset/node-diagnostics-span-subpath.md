---
"@glasstrace/sdk": minor
---

Add a Node-only `@glasstrace/sdk/diagnostics` subpath: a flag-gated,
observe-only span-lifecycle diagnostic processor that makes span loss
measurable on a real application.

It is off by default; enable it with `GLASSTRACE_SPAN_DIAGNOSTICS=true`. On
the bare (SDK-owned `BasicTracerProvider`) path it auto-attaches at
registration (no code change); applications on `@vercel/otel` or a
coexisting provider attach it with `createSpanDiagnostics()`. It emits one JSON object per line
— `start`, `end`, `unended`, and a terminal `run-summary` — to the file
named by `GLASSTRACE_SPAN_DIAGNOSTICS_OUT`, or to stdout with a
`[span-diag]` prefix. Records carry only structural, low-cardinality facts
(span name, route template, HTTP method, kind, ids, age); raw attribute
values, URLs, headers, and bodies are never read. The processor never
mutates, exports, ends, or salvages a span, and never throws into the host
request.
