---
"@glasstrace/sdk": patch
---

Bundle OpenTelemetry packages (@opentelemetry/api, @opentelemetry/sdk-trace-base,
@opentelemetry/exporter-trace-otlp-http) into the SDK so traces flow to the backend
immediately after installation. No additional packages required. @opentelemetry/api
is kept as an optional peer dependency for version compatibility with existing OTel
installations.
