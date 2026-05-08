---
"@glasstrace/sdk": minor
---

feat(sdk): three-state export-path circuit breaker (DISC-1568)

The OTLP export path now wraps every batch through a CLOSED →
OPEN → HALF_OPEN circuit breaker that protects production
applications from emitting wasted traffic when the Glasstrace
ingest endpoint is rejecting batches (invalid credentials, server
outage, network partition).

Behavior:

- **Trip threshold**: 5 consecutive non-success export results.
  Any 2xx response resets the counter.
- **OPEN backoff**: 30 seconds initially, doubling on each failed
  HALF_OPEN probe up to a 30-minute cap. While OPEN, span batches
  are dropped via the existing `recordSpansDropped` health
  surface; the BSP never retries (the OPEN window is itself the
  backoff). No buffering — the bounded-memory contract is
  preserved.
- **Recovery**: when the timer expires, the next real batch acts
  as the probe. Success closes the breaker; failure doubles the
  timer and re-opens.
- **Credential rotation**: when `setResolvedApiKey()` observes a
  different SHA-256 hash for the resolved API key, the breaker
  resets to CLOSED immediately. An in-flight HALF_OPEN probe at
  rotation time is invalidated via a generation counter so its
  outcome cannot poison the post-rotation breaker.
- **FSM coupling**: while OPEN, the SDK reports
  `getStatus().tracing === "degraded"`; the breaker's recovery
  re-evaluates the SDK back to `"active"` only when no other
  degradation source (e.g., `OtelState.COEXISTENCE_FAILED`) is
  active. Centralised through a new
  `recomputeCoreFromDegradationSources()` helper.

Observability:

- Three new lifecycle events extend the existing `otel:`
  namespace: `otel:circuit_opened`, `otel:circuit_half_open`,
  `otel:circuit_closed`. Payloads are PII-safe by construction
  (closed `category` enum, fixed-template `message`, no URLs /
  headers / payload bodies).
- `RuntimeStateLastError` gains a new `category: "export-circuit-open"`
  variant and an optional `exportCircuitCategory` field surfaced
  through `.glasstrace/runtime-state.json` and `npx glasstrace status`.
- Existing `getStatus().tracing === "degraded"` signal now
  triggers on circuit OPEN.

Backward compatibility: additive only. Applications that never
see export failures observe identical behavior to prior versions.
The `RuntimeStateLastError` `category` enum was already documented
as non-breaking on extension. No public API was renamed or
removed.

Closes the original DISC-377 §Item 4 "invalid key wastes traffic"
failure mode that the reverted PR #26 attempted to address.
