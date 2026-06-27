---
"@glasstrace/sdk": minor
---

Wire the remaining config and capture decisions into the decision-trace toggle

Decision tracing now instruments the SDK's previously-silent config and capture
gates, so an operator or validator can see exactly which gate closed when capture
produces nothing. The following decision points are added behind the existing
`decisionTrace` / `GLASSTRACE_DECISION_TRACE` toggle (which still defaults off):

- `capture.fidelity.idModel`, `capture.fidelity.identifier`, and
  `capture.fidelity.hmacKey` — the identifier-capture path in the Prisma adapter:
  whether the account is on full fidelity, whether the value was hashed, and
  whether the per-account hashing key is provisioned.
- `config.tier` — which fallback tier served the active capture config
  (`served`, `cached`, or `default`).
- `sideEffect.fieldRejected` — a side-effect field or scalar was dropped, keyed by
  the closed omission reason only (never the field key or rejected value).
- `feature.consoleErrors`, `feature.errorResponseBodies`, and `feature.discovery`
  — whether each optional capture feature is enabled.
- `otel.path` — the OpenTelemetry provider path the SDK took (bare registration,
  the `@vercel/otel` path, or a coexistence outcome).
- `env.forceEnable` — how the production gate resolved (`normal`, `forced`, or
  `production_disabled`).
- `env.nudgeSuppressed` and `env.upgradeNoticeSuppressed` — whether the one-time
  MCP-connection nudge and the stale-instruction upgrade notice were shown or
  suppressed.

Most points respond to both the programmatic option and the env var.
`env.upgradeNoticeSuppressed` is an early-bootstrap point that decides before the
SDK threads the resolved decision-trace flag, so it is observable only via the
`GLASSTRACE_DECISION_TRACE` environment variable.

The change is strictly additive and behavior-neutral: every site is guarded so no
detail object is built while the toggle is off, no branch outcome ever changes, and
each point's outcome and one-shot dedup key come from a small closed, code-literal
vocabulary so no point can echo producer input, raw values, or secrets, or exhaust
the bounded dedup cap.
