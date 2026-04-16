---
"@glasstrace/protocol": minor
---

Add tRPC procedure and error response body attributes to protocol schema

- New attribute: glasstrace.trpc.procedure for tRPC procedure name extraction
- New attribute: glasstrace.error.response_body for error response body capture
- New config field: errorResponseBodies (boolean, default false) in CaptureConfigSchema
