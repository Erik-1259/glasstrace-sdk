/**
 * Export-Path Circuit Breaker
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

// ---------------------------------------------------------------------------
// Per-trace boundary-masked error tracking
//
// The descendant boundary-masked-error detection in `enriching-exporter.ts`
// needs to correlate an exception recorded on a transitive child span with
// the HTTP server span that rendered it — and the two can arrive in
// different export batches. The breaker singleton hosts this per-trace
// state so it survives multiple `createGlasstraceSpanProcessor()` calls in
// one process and shares the singleton's key-rotation lifecycle.
//
// Memory is bounded three ways: per-trace caps on the recorded parent links
// (`MAX_LINKS_PER_TRACE`) and the recorded exception entries
// (`MAX_EXCEPTIONS_PER_TRACE`), plus a process-wide cap on tracked traces
// (`MAX_TRACKED_TRACES`) with TTL-then-LRU eviction. Every bound degrades
// to a documented detection miss (the parent stays at its original status),
// never a false promotion: a dropped link, dropped exception entry, or evicted
// entry can only *prevent* a promotion, never fabricate one.
// ---------------------------------------------------------------------------

/**
 * One exception-bearing span recorded in a trace, used to confirm a
 * candidate is a transitive descendant of an HTTP server span and to pick
 * the deterministic earliest-exception span.
 */
export interface ExceptionLineageEntry {
  /** The descendant span that recorded the exception. */
  spanId: string;
  /** Parent span id for the ancestor walk; undefined for a trace root. */
  parentSpanId?: string;
  /** hrTime → ms; used for the deterministic earliest-exception tie-break. */
  startTimeMs: number;
  /** First 256 chars of the exception message, pre-truncated at write time. */
  message?: string;
  /** The exception type string, when present. */
  type?: string;
  /** The descendant's `next.span_type` attribute, when present (render-route detection). */
  nextSpanType?: string;
  /**
   * True when the descendant span carried `glasstrace.error.expected === true`.
   * An expected boundary is never promotable — the escape hatch must be honored
   * on the exception-bearer itself, not only on the HTTP server span.
   */
  expected?: boolean;
}

/**
 * Aggregated per-trace state used by descendant boundary-masked detection.
 */
export interface TraceErrorState {
  /**
   * All exception-bearing spans in this trace, keyed by spanId for O(1)
   * lineage lookup. Capped at {@link MAX_EXCEPTIONS_PER_TRACE}; overflow drops
   * further entries and sets {@link lineageOverflow} (a documented miss).
   */
  lineageBySpanId: Map<string, ExceptionLineageEntry>;
  /**
   * parentSpanId for EVERY span seen in this trace (error AND non-error),
   * keyed by spanId, so the ancestor walk can bridge a non-error
   * intermediate span that ended in an earlier batch. Capped at
   * {@link MAX_LINKS_PER_TRACE}.
   */
  parentLinks: Map<string, string | undefined>;
  /** spanId of the earliest exception span (smallest startTimeMs; tie-break smallest spanId). */
  firstExceptionSpanId?: string;
  /** Start time (ms) of the earliest exception span — the tie-break key. */
  firstExceptionStartMs?: number;
  /** Message of the earliest exception span, pre-truncated to 256 chars at write time. */
  firstExceptionMessage?: string;
  /** Whether the per-trace parentLinks cap has been hit (a documented miss). */
  parentLinkOverflow: boolean;
  /** Whether the per-trace lineage cap has been hit (a documented miss). */
  lineageOverflow: boolean;
  createdAtMs: number;
  lastAccessedAtMs: number;
}

/** Counters exposed for observability and tests. */
export interface TraceErrorCounters {
  evictions: number;
  keyValidationFailures: number;
  parentLinkOverflow: number;
  lineageOverflow: number;
}

/**
 * Per-trace boundary-masked error store hosted on the breaker singleton.
 * Pure in-memory logic (no I/O); shares the singleton's lifecycle so a
 * credential rotation drops stale `${traceId}#${sessionId}` entries.
 */
export interface TraceErrorStore {
  /** Records a span's parent link (every span — error and non-error). */
  recordParentLink(key: string, spanId: string, parentSpanId: string | undefined, nowMs: number): void;
  /** Records an exception-bearing span and updates the earliest-exception bookkeeping. */
  recordException(key: string, entry: ExceptionLineageEntry, nowMs: number): void;
  /** Reads a trace's state, touching its LRU timestamp. Returns undefined if absent. */
  consult(key: string, nowMs: number): TraceErrorState | undefined;
  /** Empties the whole store (key rotation / test reset). */
  clear(): void;
  /** Current number of tracked traces. */
  size(): number;
  /** Reads (without touching LRU) for tests/observability. */
  peek(key: string): TraceErrorState | undefined;
  /** Increments the key-validation-failure counter. */
  recordKeyValidationFailure(): void;
  /** Snapshot of the counters. */
  getCounters(): TraceErrorCounters;
}

/**
 * Maximum number of `parentLinks` entries kept per trace. Bounds worst-case
 * per-trace link memory; covers normal page-route depths
 * (SERVER → route/component → ORM exception is depth 3). Overflow drops
 * further links and increments the `parentLinkOverflow` counter — a dropped
 * link can only suppress a promotion, never cause one.
 */
export const MAX_LINKS_PER_TRACE = 512;

/**
 * Maximum number of exception-lineage entries kept per trace. Bounds worst-case
 * per-trace exception memory independently of {@link MAX_LINKS_PER_TRACE}
 * (a trace can record far more parent links than exceptions). Overflow drops
 * further exception entries and increments the `exceptionOverflow` counter
 * while preserving the earliest-exception bookkeeping — a dropped entry can
 * only suppress a promotion, never cause one.
 */
export const MAX_EXCEPTIONS_PER_TRACE = 256;

/**
 * Maximum number of distinct traces tracked at once. Sized to the concurrent
 * in-flight trace cardinality. On overflow the store evicts by TTL first,
 * then LRU (tie-broken by oldest-inserted) — both deterministic.
 */
export const MAX_TRACKED_TRACES = 1024;

/**
 * How long (ms) a trace's error state is retained before it ages out. Generous
 * enough that a normal late descendant is still present when the parent server
 * span is consulted, while error-only traces with no server span age out.
 */
export const TRACE_ERROR_TTL_MS = 300_000;

/** Message-storage cap shared with the lifecycle emit boundary. */
const MAX_EXCEPTION_MESSAGE_CHARS = 256;

function createTraceErrorStore(): TraceErrorStore {
  const traces = new Map<string, TraceErrorState>();
  let evictions = 0;
  let keyValidationFailures = 0;
  let parentLinkOverflow = 0;
  let lineageOverflow = 0;

  function isStale(state: TraceErrorState, nowMs: number): boolean {
    return nowMs - state.createdAtMs > TRACE_ERROR_TTL_MS;
  }

  function makeFreshState(nowMs: number): TraceErrorState {
    return {
      lineageBySpanId: new Map(),
      parentLinks: new Map(),
      parentLinkOverflow: false,
      lineageOverflow: false,
      createdAtMs: nowMs,
      lastAccessedAtMs: nowMs,
    };
  }

  function expireAndEvict(nowMs: number): void {
    // TTL sweep first: drop entries older than the TTL regardless of size.
    for (const [key, state] of traces) {
      if (isStale(state, nowMs)) {
        traces.delete(key);
        evictions += 1;
      }
    }
    // LRU eviction if still over the cap: evict least-recently-accessed,
    // tie-broken by oldest-inserted (smallest createdAtMs) so the order is
    // deterministic and tests cannot flake.
    while (traces.size > MAX_TRACKED_TRACES) {
      let victimKey: string | undefined;
      let victim: TraceErrorState | undefined;
      for (const [key, state] of traces) {
        if (
          victim === undefined ||
          state.lastAccessedAtMs < victim.lastAccessedAtMs ||
          (state.lastAccessedAtMs === victim.lastAccessedAtMs &&
            state.createdAtMs < victim.createdAtMs)
        ) {
          victim = state;
          victimKey = key;
        }
      }
      if (victimKey === undefined) break;
      traces.delete(victimKey);
      evictions += 1;
    }
  }

  function getOrCreate(key: string, nowMs: number): TraceErrorState {
    const existing = traces.get(key);
    if (existing !== undefined && !isStale(existing, nowMs)) {
      existing.lastAccessedAtMs = nowMs;
      return existing;
    }
    // Either no entry, or the existing one has aged past the TTL but was not
    // yet swept (TTL eviction runs lazily, on new-key inserts). Reusing the
    // same `${traceId}#${sessionId}` after the TTL — a traceId collision, a
    // long-delayed retry, or a deterministic fixture — must NOT resurrect a
    // stale descendant exception to promote a fresh server span (a false 500).
    // Evict the aged entry and start fresh so old lineage can only be dropped,
    // never reused (fail-open).
    if (existing !== undefined) {
      evictions += 1;
    }
    const state = makeFreshState(nowMs);
    traces.set(key, state);
    expireAndEvict(nowMs);
    // expireAndEvict cannot drop the entry just inserted (createdAtMs === nowMs
    // so it is not stale, and it is the most-recently-accessed so never the LRU
    // victim). Re-read to stay correct if that invariant ever changes.
    return traces.get(key) ?? state;
  }

  return {
    recordParentLink(key, spanId, parentSpanId, nowMs): void {
      const state = getOrCreate(key, nowMs);
      if (state.parentLinks.has(spanId)) return;
      if (state.parentLinks.size >= MAX_LINKS_PER_TRACE) {
        if (!state.parentLinkOverflow) {
          state.parentLinkOverflow = true;
        }
        parentLinkOverflow += 1;
        return;
      }
      state.parentLinks.set(spanId, parentSpanId);
    },

    recordException(key, entry, nowMs): void {
      const state = getOrCreate(key, nowMs);
      const stored: ExceptionLineageEntry = {
        ...entry,
        message:
          entry.message !== undefined
            ? entry.message.slice(0, MAX_EXCEPTION_MESSAGE_CHARS)
            : undefined,
      };
      // Per-trace lineage cap: a new spanId past the cap is dropped (and the
      // overflow counter bumped) rather than admitted. Re-recording an already
      // tracked spanId always overwrites in place — it never counts against the
      // cap. A dropped entry can only suppress a promotion, never cause one.
      if (
        !state.lineageBySpanId.has(entry.spanId) &&
        state.lineageBySpanId.size >= MAX_EXCEPTIONS_PER_TRACE
      ) {
        if (!state.lineageOverflow) state.lineageOverflow = true;
        lineageOverflow += 1;
        return;
      }
      state.lineageBySpanId.set(entry.spanId, stored);
      // Also record its parent link so the walk can traverse it.
      if (!state.parentLinks.has(entry.spanId)) {
        if (state.parentLinks.size < MAX_LINKS_PER_TRACE) {
          state.parentLinks.set(entry.spanId, entry.parentSpanId);
        } else {
          if (!state.parentLinkOverflow) state.parentLinkOverflow = true;
          parentLinkOverflow += 1;
        }
      }
      // Update earliest-exception bookkeeping (smallest startTimeMs, tie-break
      // smallest spanId lexicographically) — deterministic across runs.
      const isEarlier =
        state.firstExceptionStartMs === undefined ||
        entry.startTimeMs < state.firstExceptionStartMs ||
        (entry.startTimeMs === state.firstExceptionStartMs &&
          (state.firstExceptionSpanId === undefined ||
            entry.spanId < state.firstExceptionSpanId));
      if (isEarlier) {
        state.firstExceptionSpanId = entry.spanId;
        state.firstExceptionStartMs = entry.startTimeMs;
        state.firstExceptionMessage = stored.message;
      }
    },

    consult(key, nowMs): TraceErrorState | undefined {
      const state = traces.get(key);
      if (state === undefined) return undefined;
      // Evict-on-access: an entry aged past the TTL but not yet swept must not
      // promote a fresh server span from stale lineage (a false 500). Drop it
      // and report no lineage (fail-open) rather than returning stale state.
      if (isStale(state, nowMs)) {
        traces.delete(key);
        evictions += 1;
        return undefined;
      }
      state.lastAccessedAtMs = nowMs;
      return state;
    },

    clear(): void {
      traces.clear();
    },

    size(): number {
      return traces.size;
    },

    peek(key): TraceErrorState | undefined {
      return traces.get(key);
    },

    recordKeyValidationFailure(): void {
      keyValidationFailures += 1;
    },

    getCounters(): TraceErrorCounters {
      return { evictions, keyValidationFailures, parentLinkOverflow, lineageOverflow };
    },
  };
}

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
   * stale and discarded. Also clears the per-trace boundary-masked
   * error store — key rotation changes the session id, so stale
   * `${traceId}#${sessionId}` entries must drop (an old-session
   * descendant error must not promote a new-context server span).
   *
   * Called on credential rotation per memo §Decision 7.
   */
  resetForKeyRotation(): void;
  /**
   * The per-trace boundary-masked error store used by descendant
   * status inference. Hosted on the breaker singleton so it survives
   * multiple span-processor constructions in one process and shares
   * this breaker's key-rotation lifecycle.
   */
  readonly traceErrors: TraceErrorStore;
  /** Empties the per-trace boundary-masked error store. */
  clearTraceErrors(): void;
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
 * `otel:circuit_opened` payload. Mirrors the `otel:failed`
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
  const traceErrors = createTraceErrorStore();
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
      // Drop stale per-trace boundary-masked entries: rotation changes
      // the session id, so an old-session descendant error must not
      // promote a new-context server span.
      traceErrors.clear();
      if (wasNonClosed) {
        transitionToClosed();
      }
    },

    getGeneration(): number {
      return generation;
    },

    traceErrors,

    clearTraceErrors(): void {
      traceErrors.clear();
    },
  };
}
