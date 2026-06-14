---
"@glasstrace/sdk": minor
---

Make config capture/emit/redact decisions observable via a decision-trace toggle

The SDK makes many of its capture, emit, and redact decisions silently:
when capture produces nothing, it is hard to tell which config gate closed.
This adds an opt-in decision trace, off by default, that emits one
greppable `[glasstrace] decision:` line — and a `core:decision` in-process
lifecycle event for the load-bearing gates — at each instrumented decision
point.

- New toggle: the `decisionTrace` option and the `GLASSTRACE_DECISION_TRACE`
  environment variable, both defaulting off. `verbose: true` turns it on as
  well, so existing verbose sessions get decision lines for free.
- The same decisions are mirrored to a `core:decision` event on the SDK's
  internal lifecycle bus, which the SDK's own integration tests assert on.
  This bus is not part of the public API; the greppable console line is the
  supported way to consume decision traces.
- Two priority gates are instrumented in this release: the `recordSideEffect`
  capture-disabled branch, and the config-apply outcome at init (the
  backend-authoritative `sideEffectEvidence` / `captureFidelity` the SDK
  applied; on init failure it reports the still-active cached posture, or a
  distinct fail-closed line when no cached config keeps capture enabled).

Strictly additive and behavior-neutral: capture behavior is byte-for-byte
identical whether the toggle is on or off, the emitter never throws into the
caller, and it is a strict no-op (no hot-path allocation) when off. It emits
flags and enums only — never request/response bodies, never a rejected key
or value, and never a secret (keys are masked; key-shaped config values are
reported only as present/absent).
