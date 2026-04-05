---
"@glasstrace/sdk": minor
---

Harden OTel configuration for production reliability:

- Switch from SimpleSpanProcessor to BatchSpanProcessor for OTLP exports, preventing event loop blocking on every span.end() call. SimpleSpanProcessor is retained only for the ConsoleSpanExporter debug fallback.
- Stop silently overwriting existing OTel TracerProviders. If another tracing tool (Datadog, Sentry, New Relic) has already registered a provider, Glasstrace now skips registration and logs instructions for coexistence.
- Register SIGTERM/SIGINT shutdown hooks to flush in-flight spans on process exit, preventing trace loss during graceful shutdowns.
