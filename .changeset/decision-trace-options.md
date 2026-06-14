---
"@glasstrace/protocol": minor
---

Add the optional `decisionTrace` option and `GLASSTRACE_DECISION_TRACE` env var

Adds an optional `decisionTrace` boolean to `GlasstraceOptions` and the
`GLASSTRACE_DECISION_TRACE` field to `GlasstraceEnvVarsSchema` so the SDK's
new decision-trace toggle is settable both in code and via the environment.
Additive only — both fields are optional and existing configs continue to
parse unchanged. No wire-format change and no backend consumer.
