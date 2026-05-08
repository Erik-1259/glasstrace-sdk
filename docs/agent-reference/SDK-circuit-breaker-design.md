<!-- version: 1 -->
# SDK Export-Path Circuit Breaker — Design Memo (Wave 15C)

**Status:** DRAFT — gating dependency for Wave 15C-impl
**Tracker:** [DISC-1568](../../../glasstrace-product/docs/discoveries/DISC-1568.md)
**Original failure-mode entry:** DISC-377 §Item 4 (note: DISC-377's
"Filed as DISC-441" pointer is a citation error — DISC-441 is unrelated
pnpm bundling work; DISC-1568 is the correct tracker).
**Related precedent:** DISC-1556 / Wave 11 (`runtime-state.lastError`,
`otel:failed` lifecycle event), DISC-1247 (FSM-validity rules).

This memo resolves the eight design decisions enumerated in DISC-1568
§"Design decisions to resolve at brief or recon time" so the
implementation wave (15C-impl) can ship recon-first against a stable
contract. It is internal SDK documentation, not a public-facing doc.

---

## State-transition diagram

```
                 ┌───────────────────────────────────────────────┐
                 │                                               │
                 │   reset on credential rotation (any state)    │
                 │                                               │
                 ▼                                               │
        ┌──────────────┐                                         │
        │   CLOSED     │   ◄── default; export proceeds          │
        │ (export OK)  │       failures counted in window        │
        └──────┬───────┘                                         │
               │                                                 │
               │  N consecutive failures                         │
               │  (or threshold within window)                   │
               ▼                                                 │
        ┌──────────────┐                                         │
        │    OPEN      │   ◄── exports suppressed (drop)         │
        │ (timer T)    │       backoff timer counts down         │
        └──────┬───────┘                                         │
               │                                                 │
               │  timer T expires                                │
               ▼                                                 │
        ┌──────────────┐    success    ┌────────────────┐        │
        │  HALF_OPEN   │ ────────────► │   CLOSED       │ ───────┘
        │ (1 probe)    │               │ counters reset │
        └──────┬───────┘               └────────────────┘
               │
               │  failure
               ▼
        ┌──────────────┐
        │    OPEN      │   ◄── timer doubled (capped at T_MAX)
        │ (timer 2·T)  │
        └──────────────┘
```

---

## Recon — file:line citations

All claims grounded in source on `origin/main` at `d3295a3` (post-Wave
15A merge `71167d9`).

| # | Claim | Citation | Status |
|---|---|---|---|
| 1 | OTLP export entry point is `GlasstraceExporter.export()` which delegates to a lazily-created OTLP exporter via `ensureDelegate()`. | `packages/sdk/src/enriching-exporter.ts:95-120`, `packages/sdk/src/enriching-exporter.ts:631-653` | proved |
| 2 | Delegate factory wires `OTLPTraceExporter` from `@opentelemetry/exporter-trace-otlp-http`. | `packages/sdk/src/coexistence.ts:19`, `packages/sdk/src/coexistence.ts:68-69`, `packages/sdk/src/otel-config.ts:345-346` | proved |
| 3 | Exporter currently surfaces export failures only via `sdkLog("warn", ...)`; there is no failure counter, no state, no backoff at the export layer. | `packages/sdk/src/enriching-exporter.ts:108-114`, `packages/sdk/src/enriching-exporter.ts:721-725` | proved |
| 4 | A `rateLimitBackoff` flag exists at the **init/heartbeat** layer (not the export layer) — single boolean, set on 429 from `performInit`, consumed by the heartbeat. Does not gate span export. | `packages/sdk/src/init-client.ts:88-89`, `packages/sdk/src/init-client.ts:523-526`, `packages/sdk/src/init-client.ts:660-672`, `packages/sdk/src/heartbeat.ts:224`, `packages/sdk/src/heartbeat.ts:236-249` | proved |
| 5 | Existing `RuntimeStateLastError` schema lives at `runtime-state.ts:84-107` with category enum `"auto-attach-returned-null"` (single-member today; extension is non-breaking). | `packages/sdk/src/runtime-state.ts:84-107` | proved |
| 6 | Lifecycle FSM defines `OtelState.COEXISTENCE_FAILED` (terminal — no outgoing transitions) and `CoreState.ACTIVE_DEGRADED` (reversible to/from `ACTIVE`). | `packages/sdk/src/lifecycle.ts:47-55`, `packages/sdk/src/lifecycle.ts:84-91`, `packages/sdk/src/lifecycle.ts:115-126` | proved |
| 7 | Lifecycle event payload type table is `SdkLifecycleEvents` at `lifecycle.ts:133-170`; the `otel:failed` event (DISC-1556) is the precedent for structured fail-loud diagnostics with PII-safe payload contract. | `packages/sdk/src/lifecycle.ts:146-162` | proved |
| 8 | `runtime-state.ts` `writeStateNow` writes `lastError` only when populated; debounced 1s, with SHUTDOWN bypass. | `packages/sdk/src/runtime-state.ts:246-285` | proved |
| 9 | `GlasstraceExporter.shutdown()` flushes pending and shuts down delegate; never blocks indefinitely (best-effort, callbacks always completed). | `packages/sdk/src/enriching-exporter.ts:130-150` | proved |
| 10 | The exporter receives `ExportResult` from the delegate, with `result.code !== 0` indicating failure and an optional `result.error` carrying the cause. | `packages/sdk/src/enriching-exporter.ts:108-114` | proved |
| 11 | Build envelope: BSP wraps the exporter with `scheduledDelayMillis: 1000`, so per-batch failures arrive at most ~1/sec under healthy app load. | `packages/sdk/src/coexistence.ts:88-90` | proved |

**Recon citation count: 11.** All 8 design decisions below trace to ≥1
proved citation; no claim is `uncertain`.

---

## Reservations

This memo reserves the following lifecycle event-name prefix for Wave
15C-impl:

- **`lifecycle.export.circuit.*`** — circuit-breaker state transitions
  (specific event names listed under §5 below).

This reservation is non-overlapping with Wave 15B's reservations:

- 15B reserves `lifecycle.middleware.*` and `lifecycle.async.*`.
- 15C reserves `lifecycle.export.circuit.*`.

---

## Decision 1 — Failure classification

**Question:** Which response codes/conditions trip the circuit?

**Decision:**

| Condition | Trips circuit? | Rationale |
|---|---|---|
| HTTP 401 / 403 (auth) | **YES** | Primary triggering case from DISC-1568. Persistently invalid credentials never recover without rotation. |
| HTTP 5xx | **YES** | Server errors are typically transient; circuit's half-open recovery is the right shape. |
| Network errors (ECONNREFUSED, EAI_AGAIN, ETIMEDOUT, abort) | **YES** | Same shape as 5xx — transient infrastructure failures; recovery via half-open. |
| HTTP 429 (rate limit) | **NO — out of scope** | Routes through the existing `init-client.ts:88-89` `rateLimitBackoff` path at the **init layer**. The export layer does not currently see 429 as a discrete condition (the OTLP exporter surfaces 429 as a generic non-zero `ExportResult`). 15C-impl will treat 429 the same as a generic export failure (it counts toward the threshold) but emit a distinct `failureCategory: "rate_limit"` field on the lifecycle event so future work can split if observability shows it matters. |
| HTTP 4xx other (400, 404, 413, 414, 422) | **YES** | These are usually permanent (malformed payload, route gone) — circuit prevents repeat attempts that will never succeed. The doubled-timer half-open recovery is the same shape and adds no new failure mode. |
| HTTP 2xx / 3xx | NO | Success path; resets failure counter to zero. |

**Why not split the rate-limit path between init and export?** Recon
proved (#4) that `rateLimitBackoff` is a single boolean at the init
layer with no shared state with the export layer. Sharing the circuit
across layers would require coupling the heartbeat path to export
failures and is out of scope for 15C. A future refactor (filed in
15C-impl as a discovery if recon confirms the need) could unify the
paths; this memo defers that.

**Failure-category enum (used in events + `runtime-state.lastError`):**

```ts
type ExportCircuitFailureCategory =
  | "auth"           // 401, 403
  | "client_error"   // 4xx other than 401/403/429
  | "rate_limit"     // 429 surfaced by export layer
  | "server_error"   // 5xx
  | "network";       // socket / DNS / TLS / timeout
```

---

## Decision 2 — Failure threshold + window

**Question:** How many failures in what time frame trip the circuit?

**Decision:** **Consecutive-failure threshold of 5.** No sliding window.

**Numerical reasoning:**

- BSP cadence (recon #11): export attempted ~1/sec under sustained load.
- A transient infrastructure blip (DNS hiccup, brief TCP RST during a
  rolling deploy) typically clears within 1-3 seconds.
- A persistent 401 from an invalid key never recovers without rotation.
- 5 consecutive failures = ~5s of continuous failure under healthy load
  — long enough to filter out 1-3s transient blips, short enough that
  a broken auth condition stops emitting wasted traffic in seconds.

**Why consecutive (not windowed)?** A windowed counter (e.g., "10 in
60s") penalises bursty traffic that experienced a single transient
failure period. Under low load (1 export every ~30s when the app is
mostly idle), the consecutive counter naturally lengthens the
detection window to ~150s — which is still acceptable for the wasted-
traffic concern (the app is barely emitting anyway). The consecutive
counter also has trivial state (1 integer) and trivial reset semantics
(any success resets to 0); a windowed counter requires a circular
buffer of timestamps and rolling-window arithmetic on every export
attempt. Simplicity wins here.

**Resets to zero** on:
- Any successful export (any 2xx response).
- Credential rotation (per §7).
- Process restart.

---

## Decision 3 — Half-open probe cadence

**Question:** Initial timer T, maximum timer T_MAX, doubling factor.

**Decision:**

| Parameter | Value | Rationale |
|---|---|---|
| Initial timer (T₀) | **30s** | Long enough to amortize most transient failures. Short enough that a broken-auth user notices within a release-deploy cadence. |
| Doubling factor | **2.0** | Standard exponential backoff. |
| Maximum timer (T_MAX) | **30 min (1800s)** | After 6 doublings (30s → 60s → 120s → 240s → 480s → 960s → 1800s) the timer caps. A persistently broken key will stop emitting probes after ~1hr cumulative wait. |
| Probe payload | **1 export attempt** (the next batch arriving from BSP). No synthetic probes. | The next real batch acts as the probe; this avoids an extra OTLP request for HALF_OPEN testing. |

**Why no jitter?** Exponential backoff jitter helps when many clients
synchronize their probes against a shared backend. A single SDK process
emitting one probe per backoff window is not at risk of thundering-herd
amplification. Adding jitter is straightforward to add later if
observability data shows synchronized retries from many SDK instances.

---

## Decision 4 — OPEN-state behavior

**Question:** Drop spans in OPEN, or buffer to a bounded ring and replay?

**Decision:** **Drop spans entirely in OPEN.** Increment
`recordSpansDropped()` per the existing health-collector contract.

**Rationale:**

1. **Symmetry with the auth-failed case.** The originally-shipped (and
   reverted) circuit (PR #26) buffered spans, which created the
   permanent-export-disabled bug DISC-1568 §Summary describes. Dropping
   keeps the failure mode bounded — the worst case is "spans during
   outage are lost" not "spans during outage are queued and then
   replayed against an account that may have rotated keys."
2. **Replay correctness is hard.** A buffered span enriched at buffer
   time with the old API key cannot safely be replayed under a
   rotated key (correlation / account / build-hash semantics drift).
   Re-enriching at replay time recovers correctness but doubles
   memory traffic.
3. **Existing buffer at a different layer.** `GlasstraceExporter`
   already has a bounded pending-spans buffer for the
   `API_KEY_PENDING` state (`enriching-exporter.ts:32`,
   `MAX_PENDING_SPANS = 1024`). Adding a second bounded ring at the
   circuit layer creates two overlapping bounded queues with
   subtly-different semantics — confusing and bug-prone.
4. **Health surface.** `recordSpansDropped()` already exists; the
   circuit OPEN drops surface naturally via the heartbeat.

**Implementation note:** in OPEN, `GlasstraceExporter.export()` calls
the result callback with `{ code: 0 }` — the BSP must believe the
export "succeeded" to drop the batch from its queue. The dropped count
goes to `recordSpansDropped()`. **The BSP's own retry path is bypassed
because we don't return failure to it.**

---

## Decision 5 — Observability

**Question:** What lifecycle events fire? How does state surface in
`runtime-state.json`?

**Decision:**

### Lifecycle events (reserved prefix `lifecycle.export.circuit.*`)

```ts
// Added to SdkLifecycleEvents in lifecycle.ts:133-170
"lifecycle.export.circuit.opened": {
  /** Why the circuit tripped. */
  category: ExportCircuitFailureCategory;
  /** Human-readable summary built from a fixed template; no user data. */
  message: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Number of consecutive failures observed (== threshold). */
  consecutiveFailures: number;
  /** Backoff timer scheduled, in ms. */
  nextProbeMs: number;
};

"lifecycle.export.circuit.half_open": {
  /** ISO 8601 timestamp at which the probe attempt is being made. */
  timestamp: string;
  /** Backoff timer that just expired (ms). */
  previousTimerMs: number;
};

"lifecycle.export.circuit.closed": {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /**
   * Total time the circuit spent OPEN+HALF_OPEN before recovery, in ms.
   * Useful for surfacing user-visible "outage duration" diagnostics.
   */
  outageDurationMs: number;
};
```

**PII safety** mirrors the DISC-1556 `otel:failed` contract
(`lifecycle.ts:146-162`): `message` is built from a fixed template,
no user-app data leaks (no URLs, no payload bodies, no header
values). The `category` enum is a closed set defined in §1.

### `runtime-state.lastError` extension

Extend `RuntimeStateLastError` at `runtime-state.ts:84-107` with a new
category (extension is non-breaking per the existing contract comment
at `runtime-state.ts:80-83`):

```ts
// Added member to the existing union at runtime-state.ts:94
category:
  | "auto-attach-returned-null"  // existing (DISC-1556)
  | "export-circuit-open";       // new (DISC-1568 / Wave 15C)
```

When category is `"export-circuit-open"`, the existing fields apply
verbatim:

- `message`: fixed-template human-readable summary.
- `timestamp`: ISO 8601 of circuit-open transition.
- `providerClass`: **NOT applicable** for export-circuit failures; the
  field stays optional and remains absent for this category.

A new optional field is added strictly for the export-circuit case:

```ts
/**
 * Failure category that tripped the export circuit, when
 * `category === "export-circuit-open"`. Closed enum; extending is
 * non-breaking.
 */
exportCircuitCategory?: ExportCircuitFailureCategory;
```

**Subscription wiring:** `runtime-state.ts:194-197` (the existing
`onLifecycleEvent("otel:failed", ...)` listener) is duplicated for
`lifecycle.export.circuit.opened`. The CLOSED transition clears
`_lastError` only when the previous error category was
`"export-circuit-open"` (we must not clobber a separate `auto-attach-
returned-null` error).

---

## Decision 6 — FSM interaction

**Question:** Does circuit OPEN set `CoreState.ACTIVE_DEGRADED`? Emit a
new state? Coexist independently?

**Decision:** **Circuit OPEN sets `CoreState.ACTIVE_DEGRADED`. Circuit
CLOSED transitions back to `CoreState.ACTIVE` *if and only if* no other
degradation source is active.**

**Rationale:**

1. `ACTIVE_DEGRADED` is reversible (recon #6: valid transitions
   `ACTIVE → ACTIVE_DEGRADED` and `ACTIVE_DEGRADED → ACTIVE` both
   exist at `lifecycle.ts:84-91`). Circuit recovery genuinely is the
   "back to active" case.
2. Adding a new core state would break the DISC-1247 FSM-validity
   rules (every existing transition table would need new entries).
   The existing `ACTIVE_DEGRADED` semantics already cover "the SDK is
   running but capture is impaired" — that's exactly the OPEN-circuit
   condition.
3. `OtelState.COEXISTENCE_FAILED` is not the right surface — that's
   for OTel auto-attach failures, not export-path failures, and it's
   terminal (recon #6) so it can't reverse on recovery.

**The "if and only if no other degradation source is active" guard:**
the SDK has multiple degradation sources today (OTel coexistence
failure, plus the new circuit). The transition rule is:

```
On circuit CLOSED:
  - If OtelState is anything other than COEXISTENCE_FAILED:
      setCoreState(ACTIVE)         // if currently ACTIVE_DEGRADED
  - Else:
      // OTel is still failed; stay ACTIVE_DEGRADED
      no-op
```

Implementation site: a small helper `recomputeCoreFromDegradationSources()`
called by both the circuit transition logic and (defensively) by future
degradation sources. Centralising the logic prevents the "two sources
of truth" bug where the circuit thinks it's healthy but OTel doesn't.

**State-transition table:**

| Trigger | Pre-state | Post-state |
|---|---|---|
| Circuit OPEN, OTel healthy | ACTIVE | ACTIVE_DEGRADED |
| Circuit OPEN, OTel `COEXISTENCE_FAILED` | ACTIVE_DEGRADED | ACTIVE_DEGRADED (no-op) |
| Circuit CLOSED, OTel healthy | ACTIVE_DEGRADED | ACTIVE |
| Circuit CLOSED, OTel `COEXISTENCE_FAILED` | ACTIVE_DEGRADED | ACTIVE_DEGRADED (no-op) |
| Circuit HALF_OPEN | (any) | (no FSM change — internal probe) |
| Shutdown initiated | (any) | SHUTTING_DOWN (existing path; circuit stops emitting) |

---

## Decision 7 — Credential-rotation reset

**Question:** How does the SDK detect rotation and reset the circuit?

**Decision:** **Detect rotation by hashing the resolved API key on every
`registerGlasstrace()` call and on every successful response from the
heartbeat's `performInit`.** Reset circuit to CLOSED + zero failure
counters when the hash changes.

**Detection sites:**

1. **`registerGlasstrace()` call.** When the user re-invokes register
   with a different key (e.g., dev-loop config change). Existing call
   site is `register.ts`; circuit reset hooks into the same path that
   rebuilds the OTel pipeline.
2. **Heartbeat refresh path.** After `performInit` returns a new
   `SdkInitResponse` whose key differs from the cached key. Wires
   into `init-client.ts:653` (`_setCurrentConfig`) — when the
   in-memory config rotates, the circuit module is notified.
3. **Manual reset call (test-only).** A `_resetCircuitForTesting()`
   export, mirroring the existing `_resetConfigForTesting()` at
   `init-client.ts:630-636`.

**Hashing:** SHA-256 of the API key, truncated to the first 16 bytes
(32 hex chars). The hash is held in module state — the raw key is
already at module state in the SDK (`init-client.ts` cached config),
so the hash adds no new exposure surface. The hash is **not** logged
or surfaced in `runtime-state.json` (it's a key-derived value; treat
as sensitive).

**Why not subscribe to a lifecycle event?** No `auth:key_rotated`
event exists today. Adding one is in-scope for 15C-impl if recon
confirms it; the alternative (direct module-state comparison on
`_setCurrentConfig`) is simpler and avoids fan-out through the event
emitter.

**Reset semantics:**

- failure counter → 0
- timer → cleared (no pending probe)
- state → CLOSED
- `runtime-state.lastError` → cleared if its category was
  `"export-circuit-open"`
- emit `lifecycle.export.circuit.closed` with
  `outageDurationMs: <time since OPEN>` so the CLI bridge can
  report "outage cleared by credential rotation".

**Edge case — rotation during HALF_OPEN probe.** The probe is in flight
when rotation happens. Decision: **the probe completes (we don't
abort it), but its result is ignored for state-transition purposes**
since the circuit has already reset to CLOSED. If the probe succeeds,
fine. If it fails, the new key starts fresh — the failure does not
count toward the post-rotation circuit's threshold. Implementation:
attach a generation counter to each probe; rotation increments the
counter; probe-completion handlers check the counter before mutating
state.

---

## Decision 8 — Test coverage matrix

Fixture shape for every test below:

- **Mock transport.** Implement a minimal `SpanExporter` that records
  every `export()` call and lets the test simulate `ExportResult`
  outcomes (`{ code: 0 }`, `{ code: 1, error: ... }`). Plug it via
  `createDelegate` in the `GlasstraceExporter` constructor (recon #2;
  the factory is parameterized, so this is a clean injection point).
- **Time advancement.** Vitest `vi.useFakeTimers()` + `vi.advanceTimersByTime()`.
  No real-clock waiting in any test.
- **Lifecycle event capture.** Subscribe via `onLifecycleEvent` for the
  three `lifecycle.export.circuit.*` events; assert payload contents.
- **Runtime-state assertion.** Read the on-disk `runtime-state.json` via
  the existing `_readRuntimeStateForTesting()` helper at
  `runtime-state.ts` (or add one if absent — file under the
  test-coverage scope).

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | CLOSED → OPEN under N consecutive failures | Mock transport returns `{ code: 1, error }` for 5 batches in a row. | After 5th failure: state = OPEN, `lifecycle.export.circuit.opened` fires once with `consecutiveFailures: 5`, `runtime-state.lastError.category === "export-circuit-open"`, `recordSpansDropped` increments by N for any subsequent batch in OPEN. |
| 2 | OPEN → HALF_OPEN after timer T expires | Trip circuit per #1, advance fake timers by 30000ms. | State transitions to HALF_OPEN. `lifecycle.export.circuit.half_open` fires once with `previousTimerMs: 30000`. Next export attempt is allowed through. |
| 3 | HALF_OPEN → CLOSED on success | From #2, mock transport returns `{ code: 0 }` on the next export. | State = CLOSED. `lifecycle.export.circuit.closed` fires once with `outageDurationMs >= 30000`. `runtime-state.lastError` cleared (when category was `export-circuit-open`). Failure counter = 0. |
| 4 | HALF_OPEN → OPEN on failure with doubled timer | From #2, mock transport returns `{ code: 1 }` on the probe. | State = OPEN. Next backoff = 60000ms (T₀ × 2). After 6 doublings, capped at 1800000ms. |
| 5 | Reset on credential rotation | Trip circuit per #1. Call `_setCurrentConfig` with a new key (different SHA-256). | State = CLOSED immediately. Failure counter = 0. `lifecycle.export.circuit.closed` fires with `outageDurationMs` set to time since OPEN. `runtime-state.lastError` cleared. |
| 6 | Bounded behavior under sustained failure | Trip circuit, then emit 100,000 spans during OPEN over simulated 30 minutes. | No memory growth (assert no internal queue size grows). All spans counted via `recordSpansDropped`. CPU bound: assert each `export()` call is O(1) (no per-span allocation in OPEN). |
| 7 | Interaction with shutdown — don't block flush | Trip circuit. Call `GlasstraceExporter.shutdown()`. | Shutdown completes within 100ms (no delegate flush attempted while OPEN; existing pending-batch callbacks invoked with `{ code: 0 }` — recon #9). Test: assert shutdown promise resolves before fake timer for the next probe expires. |
| 8 | Lifecycle event payload coverage | Trip + recover circuit. | Each of the 3 `lifecycle.export.circuit.*` events fires with the contracted payload shape (assert keys present, types correct, no extra keys, no PII fields). |
| 9 | FSM coexistence — circuit OPEN sets ACTIVE_DEGRADED | Healthy SDK at `CoreState.ACTIVE`. Trip circuit. | `CoreState === ACTIVE_DEGRADED`. On circuit CLOSED, `CoreState === ACTIVE` (no other degradation). |
| 10 | FSM coexistence — circuit recovery does not clobber OTel-failed | Set `OtelState.COEXISTENCE_FAILED` (already-degraded path). Trip then recover circuit. | Stays at `CoreState.ACTIVE_DEGRADED` after circuit closed (OTel still failed). Helper from §6 must guard correctly. |
| 11 | Failure-category routing | Inject `{ code: 1, error: { status: 401 } }`, `{ status: 503 }`, network error, `{ status: 429 }`. | Each tripped open event has the correct `category` in `lifecycle.export.circuit.opened` and the matching `exportCircuitCategory` in `runtime-state.lastError`. |
| 12 | Probe-during-rotation race | Trip circuit, advance to HALF_OPEN, kick off probe. Mid-probe, rotate the key. | Probe-completion callback observes the generation-counter mismatch (per §7) and is no-op. Post-rotation state = CLOSED. New failures from the new key start fresh. |

**Coverage gates for 15C-impl:**

- All 12 scenarios above must have explicit unit tests.
- Tests must run under the SDK's existing Vitest config; no real
  network, no real timers.
- Lifecycle event subscriptions must clean up in `afterEach` to
  prevent cross-test bleed.

---

## Open items deferred to 15C-impl

1. **Discovery-on-recon:** if 15C-impl recon surfaces that any decision
   above is incompatible with code state — file via the SDK conductor's
   sub-agent worktree process (DISC-1629 / DISC-1630 reserved).
2. **Public API documentation:** circuit-breaker behavior is internal —
   no public README exposure unless 15C-impl introduces a config knob
   (the wave plan calls out "minor bump if new public surface; document
   opt-out / config knobs if any" at line 298).
3. **Cross-repo validation:** out of scope per Wave 15 plan
   (line 235); SDK conductor publishes canary + runs local Next 16
   e2e fixture only.
4. **Future split of rate-limit handling between init and export
   layers:** see §1; deferred behind a discovery if observability
   shows it matters.

---

## Cross-references

- DISC-1568 — primary tracker
  (`../../../glasstrace-product/docs/discoveries/DISC-1568.md`)
- DISC-377 §Item 4 — original failure-mode entry
- DISC-441 — UNRELATED pnpm-bundling work (citation correction
  documented in DISC-1568 §"Cross-References Correction")
- DISC-1556 / Wave 11 — `runtime-state.lastError` + `otel:failed`
  precedent (`packages/sdk/src/runtime-state.ts:84-107`,
  `packages/sdk/src/lifecycle.ts:146-162`)
- DISC-1247 — FSM-validity rules (referenced in the FSM section)
- Wave 15 plan — `glasstrace-product/.claude/plans/2026-05-08-sdk-loose-ends-wave-15.md`
  (gitignored; do NOT PR)
- Wave 15B reservations — `lifecycle.middleware.*`,
  `lifecycle.async.*` (non-overlapping with this memo's
  `lifecycle.export.circuit.*`)
