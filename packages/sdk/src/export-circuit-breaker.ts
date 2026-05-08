/**
 * Export-Path Circuit Breaker (DISC-1568 / Wave 15C-impl)
 *
 * Three-state machine — CLOSED → OPEN → HALF_OPEN — that bounds wasted
 * traffic from the OTLP export path when the backend is rejecting
 * batches (invalid credentials, server errors, network failures, rate
 * limits). The breaker counts consecutive failures, trips OPEN when it
 * crosses the configured threshold, drops spans during the open window
 * (incrementing the existing `recordSpansDropped` health surface),
 * permits a single probe batch after the backoff timer expires, and
 * either closes (probe succeeds) or doubles the timer back to OPEN
 * (probe fails). Credential rotation resets the breaker to CLOSED with
 * a generation counter that invalidates any in-flight probe.
 *
 * **Pure logic, no I/O:** the module owns no sockets, no files, no
 * direct logger access. Lifecycle event emission and health-collector
 * recording are wired in via {@link createExportCircuitBreaker}'s
 * `events` and `recordDropped` callbacks so the module is unit-
 * testable with mock collaborators and zero side effects per test.
 *
 * **Design memo:** glasstrace-product
 * `docs/task-briefs/SDK-circuit-breaker-design.md` (private). All
 * eight decisions in that memo are encoded as constants below; the
 * memo is the source of truth for the numbers (T₀ = 30s, threshold = 5,
 * doubling = 2×, T_MAX = 30 min, etc.).
 */

/**
 * Closed enum of failure categories that can trip the breaker. Surfaced
 * verbatim in the `otel:circuit_opened` lifecycle payload and on
 * {@link RuntimeStateLastError.exportCircuitCategory}; CLI consumers
 * may render the value, so renaming or removing a member is a public-
 * contract change.
 */
export type ExportCircuitFailureCategory =
  | "auth"          // 401, 403
  | "client_error"  // 4xx other than 401/403/429
  | "rate_limit"    // 429 surfaced by export layer
  | "server_error"  // 5xx
  | "network";      // socket / DNS / TLS / timeout

/** Three-state machine per the Wave 15C design memo. */
export type ExportCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Initial backoff timer applied on the first OPEN transition. Doubled
 * on each successive HALF_OPEN→OPEN transition until {@link MAX_BACKOFF_MS}.
 *
 * @drift-check ../glasstrace-product/docs/task-briefs/SDK-circuit-breaker-design.md §Decision 3 (T₀ = 30s)
 */
export const INITIAL_BACKOFF_MS = 30_000;

/**
 * Backoff doubling factor between successive OPEN states. Pure
 * exponential — no jitter (single-process probe rate poses no
 * thundering-herd risk; jitter can be added if observability shows
 * synchronized retries from many SDK instances).
 *
 * @drift-check ../glasstrace-product/docs/task-briefs/SDK-circuit-breaker-design.md §Decision 3 (factor = 2.0)
 */
export const BACKOFF_FACTOR = 2;

/**
 * Maximum backoff timer; capped after six doublings
 * (30s → 60s → 120s → 240s → 480s → 960s → 1800s). After this point a
 * persistently broken key produces one probe per 30 minutes.
 *
 * @drift-check ../glasstrace-product/docs/task-briefs/SDK-circuit-breaker-design.md §Decision 3 (T_MAX = 30 min)
 */
export const MAX_BACKOFF_MS = 30 * 60 * 1000; // 1_800_000

/**
 * Number of consecutive non-success export results required to trip
 * the breaker from CLOSED to OPEN. Successive successes reset the
 * counter; no sliding window — see memo §Decision 2 for the rationale.
 *
 * @drift-check ../glasstrace-product/docs/task-briefs/SDK-circuit-breaker-design.md §Decision 2 (threshold = 5)
 */
export const FAILURE_THRESHOLD = 5;

/**
 * Lifecycle-event payload shapes the breaker hands back to the caller
 * via the `events` callback. Each shape mirrors the corresponding
 * entry in `SdkLifecycleEvents` exactly (see `lifecycle.ts`). The
 * indirection keeps the breaker module free of a direct lifecycle
 * import so it remains pure-logic.
 */
export interface ExportCircuitOpenedPayload {
  category: ExportCircuitFailureCategory;
  message: string;
  timestamp: string;
  consecutiveFailures: number;
  nextProbeMs: number;
}

export interface ExportCircuitHalfOpenPayload {
  timestamp: string;
  previousTimerMs: number;
}

export interface ExportCircuitClosedPayload {
  timestamp: string;
  outageDurationMs: number;
}

/** Sink for the breaker's three lifecycle events. */
export interface ExportCircuitEventSink {
  emitOpened(payload: ExportCircuitOpenedPayload): void;
  emitHalfOpen(payload: ExportCircuitHalfOpenPayload): void;
  emitClosed(payload: ExportCircuitClosedPayload): void;
}

/** Optional FSM-coupling hooks invoked on circuit transitions. */
export interface ExportCircuitFsmHooks {
  /**
   * Called when the breaker trips OPEN. Implementations should set
   * `CoreState.ACTIVE_DEGRADED` (no-op when the SDK is already
   * degraded by another source).
   */
  onCircuitOpened(): void;
  /**
   * Called when the breaker recovers to CLOSED. Implementations
   * should re-evaluate whether the SDK can return to `CoreState.ACTIVE`
   * without clobbering an unrelated degradation source (e.g.,
   * `OtelState.COEXISTENCE_FAILED`).
   */
  onCircuitClosed(): void;
}

/** Failure shape passed into {@link ExportCircuitBreaker.recordFailure}. */
export interface ExportFailureInfo {
  /** HTTP status code if the underlying transport surfaced one. */
  status?: number;
  /**
   * Free-form error object from the export pipeline. Inspected only
   * for shape signals (status property, error name) that drive
   * category classification.
   */
  error?: unknown;
}

/** Options accepted by {@link createExportCircuitBreaker}. */
export interface ExportCircuitBreakerOptions {
  /** Lifecycle event sink. Required. */
  events: ExportCircuitEventSink;
  /**
   * Health-collector hook. Called every time spans are dropped while
   * the breaker is OPEN. Required so the existing health surface
   * (`recordSpansDropped`) reflects circuit-induced drops without the
   * module taking a direct import on the collector.
   */
  recordDropped: (count: number) => void;
  /** Optional FSM-coupling hooks. */
  fsm?: ExportCircuitFsmHooks;
  /**
   * Time source override for tests. Defaults to {@link Date.now}.
   */
  now?: () => number;
  /**
   * Timer factory override for tests. Defaults to `setTimeout`.
   * Returns a handle accepted by the matching {@link ExportCircuitBreakerOptions.clearTimer}.
   */
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  /** Timer disposal counterpart to {@link ExportCircuitBreakerOptions.setTimer}. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * The public-facing breaker handle. Returned by
 * {@link createExportCircuitBreaker}. Methods are documented at the
 * factory call site.
 */
export interface ExportCircuitBreaker {
  /**
   * Returns true when the breaker permits a real export attempt.
   * `false` when OPEN; the caller MUST drop the spans (call
   * {@link onSpansDropped}) and complete the BSP callback with a
   * success result so the BSP does not retry.
   */
  shouldExport(): boolean;
  /** Records a successful export result. Resets the failure counter to zero. */
  recordSuccess(): void;
  /** Records a failed export result. Trips OPEN on the Nth consecutive failure. */
  recordFailure(info: ExportFailureInfo): void;
  /**
   * Counts dropped spans while OPEN. Forwards to the
   * {@link ExportCircuitBreakerOptions.recordDropped} hook the caller
   * provided.
   */
  onSpansDropped(count: number): void;
  /** Read-only snapshot of internal state for tests and observability. */
  getState(): ExportCircuitState;
  /**
   * Resets the breaker to CLOSED, clears the failure counter and the
   * pending probe timer, and emits `otel:circuit_closed` if the
   * breaker was non-CLOSED. Bumps the generation counter so any
   * in-flight HALF_OPEN probe completion handler is observed as
   * stale and discarded.
   *
   * Called on credential rotation per memo §Decision 7.
   */
  resetForKeyRotation(): void;
  /**
   * Returns the current generation counter. The HALF_OPEN probe
   * captures this value at probe-issue time and compares it on
   * completion to detect a credential rotation that fired mid-probe
   * (memo §Decision 7 edge case).
   */
  getGeneration(): number;
}

/**
 * Maps a transport result into a {@link ExportCircuitFailureCategory}
 * using the precedence in memo §Decision 1: explicit auth status (401,
 * 403) → rate limit (429) → server error (5xx) → other client error
 * (4xx) → network. Unknown shapes default to `"network"` since the
 * OTLP exporter surfaces transport-layer failures (DNS, TCP, TLS,
 * timeout) without a status code.
 */
export function classifyExportFailure(info: ExportFailureInfo): ExportCircuitFailureCategory {
  const status = readStatus(info);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 500 && status <= 599) return "server_error";
  if (typeof status === "number" && status >= 400 && status <= 499) return "client_error";
  return "network";
}

/**
 * Best-effort extraction of an HTTP status code from the failure
 * shape. The OTLP exporter wraps responses through several layers and
 * different OTel SDK versions surface the status via slightly
 * different property paths; we probe the well-known shapes without
 * dereferencing untrusted data.
 */
function readStatus(info: ExportFailureInfo): number | undefined {
  if (typeof info.status === "number") return info.status;
  const err = info.error;
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;

  const direct = record.status;
  if (typeof direct === "number") return direct;

  // OTLP exporter surfaces status as a string in some Node versions
  // (e.g. `"401"`); coerce defensively. The same coercion applies to
  // the nested `response.status` path (Copilot review 2026-05-08;
  // discovered by inspection; no in-the-wild repro yet but the cost
  // of the extra check is negligible).
  if (typeof direct === "string") {
    const parsed = Number.parseInt(direct, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const nested = record.response;
  if (nested && typeof nested === "object") {
    const nestedStatus = (nested as Record<string, unknown>).status;
    if (typeof nestedStatus === "number") return nestedStatus;
    if (typeof nestedStatus === "string") {
      const parsed = Number.parseInt(nestedStatus, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

/**
 * Builds a fixed-template, PII-safe summary string for the
 * `otel:circuit_opened` payload. Mirrors the DISC-1556 `otel:failed`
 * contract: no URLs, no headers, no payload bodies — only the closed
 * category enum and the consecutive-failure count.
 */
function buildOpenedMessage(category: ExportCircuitFailureCategory, count: number): string {
  return (
    `[glasstrace] Export circuit opened after ${count} consecutive failures ` +
    `(category: ${category}). Subsequent spans dropped until probe succeeds.`
  );
}

/**
 * Module-level singleton for the production export pipeline. Lazily
 * constructed on first {@link getExportCircuitBreaker} call so module
 * loading remains side-effect-free (matching the broader SDK
 * convention).
 *
 * Tests must call {@link _resetExportCircuitBreakerForTesting} in
 * `afterEach` to drop the singleton; alternative tests that need an
 * isolated breaker can call {@link createExportCircuitBreaker}
 * directly with their own sinks.
 */
let _singleton: ExportCircuitBreaker | null = null;

/**
 * Returns the production export circuit breaker singleton, lazily
 * constructing it on first call with the supplied options. Subsequent
 * calls return the same instance regardless of the options passed —
 * the production pipeline owns a single breaker for the OTLP export
 * path.
 */
export function getExportCircuitBreaker(
  options: ExportCircuitBreakerOptions,
): ExportCircuitBreaker {
  if (_singleton === null) {
    _singleton = createExportCircuitBreaker(options);
  }
  return _singleton;
}

/**
 * Returns the current singleton without constructing it. Used by call
 * sites that need to reset the breaker on credential rotation (e.g.,
 * `init-client.ts`'s `_setCurrentConfig`) — they should not construct
 * a breaker with stale options just to call `resetForKeyRotation()`.
 */
export function peekExportCircuitBreaker(): ExportCircuitBreaker | null {
  return _singleton;
}

/**
 * Reset the production singleton. **Test-only.** Mirrors
 * `_resetConfigForTesting()` in init-client.ts.
 */
export function _resetExportCircuitBreakerForTesting(): void {
  _singleton = null;
}

/**
 * Factory: builds a breaker bound to the provided sinks and hooks.
 * Returned object encapsulates all mutable state — the module itself
 * holds none, so multiple breakers can coexist (e.g., tests run in
 * parallel with isolated instances).
 */
export function createExportCircuitBreaker(
  options: ExportCircuitBreakerOptions,
): ExportCircuitBreaker {
  const events = options.events;
  const recordDropped = options.recordDropped;
  const fsm = options.fsm;
  const now = options.now ?? (() => Date.now());
  // Default timer wiring uses globalThis.setTimeout. We unref() the
  // returned handle when supported so a pending probe timer never
  // prevents process exit (the breaker is best-effort recovery — if
  // the host process is exiting, an outstanding probe must not keep
  // the event loop alive).
  const setTimer =
    options.setTimer ??
    ((fn: () => void, delayMs: number) => {
      const handle = setTimeout(fn, delayMs);
      if (typeof handle === "object" && handle && "unref" in handle) {
        (handle as { unref: () => void }).unref();
      }
      return handle;
    });
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // ---- Internal mutable state ----------------------------------------------
  let state: ExportCircuitState = "CLOSED";
  let consecutiveFailures = 0;
  let currentBackoffMs = INITIAL_BACKOFF_MS;
  let openedAtMs: number | null = null;
  let pendingTimer: unknown = null;
  /**
   * HALF_OPEN single-probe gate. The contract is that exactly one
   * batch is admitted while the circuit is HALF_OPEN; if multiple
   * concurrent `export()` callers arrived in the same tick they would
   * all see `state === "HALF_OPEN"` and `shouldExport()` would return
   * `true` for each, sending parallel probes that race the recorded
   * outcome (Codex P1 + Copilot, 2026-05-08). The flag is set when
   * `shouldExport()` admits a HALF_OPEN probe and cleared by
   * `recordSuccess()` / `recordFailure()` (or any state transition).
   */
  let halfOpenProbeInFlight = false;
  /**
   * Generation counter. Incremented on every credential rotation
   * (memo §Decision 7) so a HALF_OPEN probe completion handler that
   * captured the previous generation can detect the rotation and
   * become a no-op.
   */
  let generation = 0;

  // ---- Helpers -------------------------------------------------------------

  function clearPendingTimer(): void {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
  }

  function scheduleHalfOpen(delayMs: number): void {
    clearPendingTimer();
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      // The breaker may have transitioned out of OPEN since the timer
      // was scheduled (e.g., credential rotation). Only HALF_OPEN if
      // we are still OPEN.
      if (state !== "OPEN") return;
      transitionToHalfOpen(delayMs);
    }, delayMs);
  }

  function transitionToOpen(category: ExportCircuitFailureCategory): void {
    const wasNonOpen = state !== "OPEN";
    state = "OPEN";
    halfOpenProbeInFlight = false;
    if (openedAtMs === null) {
      openedAtMs = now();
    }
    if (wasNonOpen) {
      const timestamp = new Date(now()).toISOString();
      const message = buildOpenedMessage(category, consecutiveFailures);
      // Lifecycle event first, FSM coupling second. Listeners may
      // observe the OPEN transition via the lifecycle bus
      // independently of the FSM.
      try {
        events.emitOpened({
          category,
          message,
          timestamp,
          consecutiveFailures,
          nextProbeMs: currentBackoffMs,
        });
      } catch {
        // event sink errors must not block the state machine
      }
      try {
        fsm?.onCircuitOpened();
      } catch {
        // FSM hook errors must not block the state machine
      }
    }
    scheduleHalfOpen(currentBackoffMs);
  }

  function transitionToHalfOpen(previousTimerMs: number): void {
    state = "HALF_OPEN";
    halfOpenProbeInFlight = false;
    try {
      events.emitHalfOpen({
        timestamp: new Date(now()).toISOString(),
        previousTimerMs,
      });
    } catch {
      // best-effort
    }
  }

  /**
   * Transition the breaker to CLOSED and emit `otel:circuit_closed`
   * with `outageDurationMs` measured from the original OPEN moment.
   * Resets failure counter, backoff timer, and pending probe timer.
   */
  function transitionToClosed(): void {
    const startedAt = openedAtMs;
    state = "CLOSED";
    consecutiveFailures = 0;
    currentBackoffMs = INITIAL_BACKOFF_MS;
    openedAtMs = null;
    halfOpenProbeInFlight = false;
    clearPendingTimer();
    try {
      events.emitClosed({
        timestamp: new Date(now()).toISOString(),
        outageDurationMs: startedAt === null ? 0 : Math.max(0, now() - startedAt),
      });
    } catch {
      // best-effort
    }
    try {
      fsm?.onCircuitClosed();
    } catch {
      // best-effort
    }
  }

  // ---- Public API ----------------------------------------------------------

  return {
    shouldExport(): boolean {
      if (state === "OPEN") return false;
      if (state === "HALF_OPEN") {
        // Single-probe gate: only the first concurrent caller is
        // admitted while a probe is in flight. Subsequent callers see
        // `false` and their spans are dropped (same as OPEN). The flag
        // clears on probe-result record or any state transition.
        if (halfOpenProbeInFlight) return false;
        halfOpenProbeInFlight = true;
        return true;
      }
      return true; // CLOSED
    },

    recordSuccess(): void {
      if (state === "HALF_OPEN") {
        // Probe succeeded → close. Counter and backoff reset inside
        // transitionToClosed; the in-flight gate also clears.
        halfOpenProbeInFlight = false;
        transitionToClosed();
        return;
      }
      // CLOSED or OPEN-without-permission (defensive). Reset counter
      // — a 2xx mid-streak indicates the backend is healthy again.
      consecutiveFailures = 0;
    },

    recordFailure(info: ExportFailureInfo): void {
      const category = classifyExportFailure(info);

      if (state === "HALF_OPEN") {
        // Probe failed → re-open with doubled timer (capped at T_MAX).
        currentBackoffMs = Math.min(currentBackoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
        // consecutiveFailures stays at THRESHOLD-or-above; we do not
        // re-emit `otel:circuit_opened` for the same outage. The
        // caller's lifecycle stream sees a single open / many half-
        // open / one close.
        halfOpenProbeInFlight = false;
        state = "OPEN";
        scheduleHalfOpen(currentBackoffMs);
        return;
      }

      if (state === "CLOSED") {
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURE_THRESHOLD) {
          // First trip → backoff is INITIAL_BACKOFF_MS (set above).
          transitionToOpen(category);
        }
        return;
      }

      // state === "OPEN" — should not normally happen because
      // shouldExport() returns false in OPEN, but if a caller routes a
      // failure through the breaker anyway (e.g., a stale callback
      // arriving after a probe timer scheduled the next half-open),
      // we keep the counter monotonic without re-tripping.
    },

    onSpansDropped(count: number): void {
      if (!Number.isFinite(count) || count <= 0) return;
      try {
        recordDropped(count);
      } catch {
        // health collector errors must not block the export path
      }
    },

    getState(): ExportCircuitState {
      return state;
    },

    resetForKeyRotation(): void {
      generation += 1;
      const wasNonClosed = state !== "CLOSED";
      // Always reset counters on rotation regardless of state.
      consecutiveFailures = 0;
      currentBackoffMs = INITIAL_BACKOFF_MS;
      clearPendingTimer();
      if (wasNonClosed) {
        transitionToClosed();
      }
    },

    getGeneration(): number {
      return generation;
    },
  };
}
