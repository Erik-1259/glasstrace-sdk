/**
 * SDK Lifecycle State Machine
 *
 * Provides a single source of truth for SDK state across three runtime
 * layers: core, auth, and OTel coexistence. (The CLI layer is handled
 * separately via the runtime state file bridge.)
 *
 * The core layer provides a shared typed event emitter that other layers
 * and SDK modules use for cross-layer communication.
 *
 * This module imports only from `./signal-handler.js`, which itself has no
 * imports, so the dependency graph remains acyclic. The logger is still
 * injected via initLifecycle() to avoid coupling to console-capture.
 *
 * @see docs/component-designs/sdk-lifecycle.md
 */

import { EventEmitter } from "node:events";
import { getCoexistenceState } from "./signal-handler.js";
import {
  _registerLifecycleEmitForBridge,
  _clearLifecycleEmitForBridge,
} from "./optional-lifecycle.js";

// ---------------------------------------------------------------------------
// State Enums
// ---------------------------------------------------------------------------

export const CoreState = {
  IDLE: "IDLE",
  REGISTERING: "REGISTERING",
  KEY_PENDING: "KEY_PENDING",
  KEY_RESOLVED: "KEY_RESOLVED",
  ACTIVE: "ACTIVE",
  ACTIVE_DEGRADED: "ACTIVE_DEGRADED",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  SHUTDOWN: "SHUTDOWN",
  PRODUCTION_DISABLED: "PRODUCTION_DISABLED",
  REGISTRATION_FAILED: "REGISTRATION_FAILED",
} as const;
export type CoreState = (typeof CoreState)[keyof typeof CoreState];

export const AuthState = {
  ANONYMOUS: "ANONYMOUS",
  AUTHENTICATED: "AUTHENTICATED",
  CLAIMING: "CLAIMING",
  CLAIMED: "CLAIMED",
} as const;
export type AuthState = (typeof AuthState)[keyof typeof AuthState];

export const OtelState = {
  UNCONFIGURED: "UNCONFIGURED",
  CONFIGURING: "CONFIGURING",
  OWNS_PROVIDER: "OWNS_PROVIDER",
  AUTO_ATTACHED: "AUTO_ATTACHED",
  PROCESSOR_PRESENT: "PROCESSOR_PRESENT",
  COEXISTENCE_FAILED: "COEXISTENCE_FAILED",
} as const;
export type OtelState = (typeof OtelState)[keyof typeof OtelState];

// ---------------------------------------------------------------------------
// Valid Transitions
// ---------------------------------------------------------------------------

/**
 * Valid transitions for the core SDK lifecycle state machine.
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-lifecycle.md §4.2 Transition Rules
 */
const VALID_CORE_TRANSITIONS: Record<CoreState, readonly CoreState[]> = {
  [CoreState.IDLE]: [CoreState.REGISTERING, CoreState.REGISTRATION_FAILED, CoreState.SHUTTING_DOWN],
  [CoreState.REGISTERING]: [
    CoreState.KEY_PENDING,
    CoreState.PRODUCTION_DISABLED,
    CoreState.REGISTRATION_FAILED,
    CoreState.SHUTTING_DOWN,
  ],
  [CoreState.KEY_PENDING]: [
    CoreState.KEY_RESOLVED,
    CoreState.REGISTRATION_FAILED,
    CoreState.SHUTTING_DOWN,
  ],
  [CoreState.KEY_RESOLVED]: [
    CoreState.ACTIVE,
    CoreState.ACTIVE_DEGRADED,
    CoreState.SHUTTING_DOWN,
  ],
  [CoreState.ACTIVE]: [
    CoreState.ACTIVE_DEGRADED,
    CoreState.SHUTTING_DOWN,
  ],
  [CoreState.ACTIVE_DEGRADED]: [
    CoreState.ACTIVE,
    CoreState.SHUTTING_DOWN,
  ],
  [CoreState.SHUTTING_DOWN]: [CoreState.SHUTDOWN],
  [CoreState.SHUTDOWN]: [],
  [CoreState.PRODUCTION_DISABLED]: [],
  [CoreState.REGISTRATION_FAILED]: [],
};

/**
 * Valid transitions for the auth state machine.
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-lifecycle.md §5.2 Transitions
 */
const VALID_AUTH_TRANSITIONS: Record<AuthState, readonly AuthState[]> = {
  [AuthState.ANONYMOUS]: [AuthState.CLAIMING],
  [AuthState.AUTHENTICATED]: [AuthState.CLAIMING],
  [AuthState.CLAIMING]: [AuthState.CLAIMED],
  [AuthState.CLAIMED]: [AuthState.CLAIMING],
};

/**
 * Valid transitions for the OTel coexistence state machine.
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-lifecycle.md §6 Layer 3: OTel Coexistence Lifecycle
 */
const VALID_OTEL_TRANSITIONS: Record<OtelState, readonly OtelState[]> = {
  [OtelState.UNCONFIGURED]: [OtelState.CONFIGURING],
  [OtelState.CONFIGURING]: [
    OtelState.OWNS_PROVIDER,
    OtelState.AUTO_ATTACHED,
    OtelState.PROCESSOR_PRESENT,
    OtelState.COEXISTENCE_FAILED,
  ],
  [OtelState.OWNS_PROVIDER]: [],
  [OtelState.AUTO_ATTACHED]: [],
  [OtelState.PROCESSOR_PRESENT]: [],
  [OtelState.COEXISTENCE_FAILED]: [],
};

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

export interface SdkLifecycleEvents {
  "core:state_changed": { from: CoreState; to: CoreState };
  "core:ready": Record<string, never>;
  "core:shutdown_started": Record<string, never>;
  "core:shutdown_completed": Record<string, never>;
  /**
   * The boundary-masked-error heuristic fired for an HTTP server span
   * (same-span scope). Emitted from the enriching
   * exporter when ALL of the following hold for an HTTP server span:
   *
   *   1. At least one error signal is present on the span — any of:
   *      `span.status.code === SpanStatusCode.ERROR`, an `exception`
   *      event from `recordException()`, OR an `exception.type` /
   *      `exception.message` span attribute.
   *   2. `http.status_code` is in the trigger set `{200, 0, undefined}`.
   *   3. `span.status.code` is not explicitly `OK`.
   *
   * When all three hold, the SDK promotes the inferred
   * `glasstrace.http.status_code` (typically to 500, or to a value
   * parsed from a numeric `error.type` attribute when present) and
   * fires this event. Informational only — subscribers MAY use it for
   * observability (e.g., heuristic activation rate dashboards) but the
   * heuristic's behavior does NOT depend on subscribers.
   *
   * **Same-span scope:** this event fires when the HTTP server span
   * itself carries the error signal (the case the existing
   * inference block already handled). Descendant-traversal detection
   * (the page-route boundary case where the exception lives in a
   * child span) is tracked separately and does NOT emit this event
   * today.
   *
   * **PII-safety:** `exceptionMessage` is truncated to 256 characters
   * and is the same content already present on the span's exception
   * event or `exception.message` attribute — no new disclosure surface
   * beyond what already ships in the trace itself. `exceptionMessage`
   * is OMITTED from the payload entirely when no exception event /
   * attribute is present (the `status.code === ERROR`-only case).
   * `spanId` is the OTel span identifier for the HTTP server span
   * where the heuristic fired.
   */
  "core:error_boundary_detected": {
    spanId: string;
    inferredStatus: number;
    exceptionMessage?: string;
  };
  /**
   * An instrumented SDK config-decision point was decided while decision
   * tracing is enabled. This is the structured, programmatically-capturable
   * counterpart of the `[glasstrace] decision:` console line: a validator or
   * test subscribes with `onLifecycleEvent("core:decision", ...)` and asserts
   * the `{ point, outcome }` sequence for a scenario instead of scraping
   * console text.
   *
   * **Firing condition.** Emitted for every instrumented decision when
   * decision tracing is enabled (the `decisionTrace` option, the
   * `GLASSTRACE_DECISION_TRACE` env var, or `verbose`). When tracing is OFF —
   * the default — this event is **never** emitted, even to a registered
   * subscriber: the off-by-default guarantee mirrors the log channel exactly,
   * and gating is on the toggle, never on subscriber count.
   *
   * **Payload semantics.** `point` is a stable, dot-separated decision id
   * (for example `capture.sideEffectEvidence` or `config.tier`); it is typed
   * as a plain `string` on the event so a future point can ride the bus before
   * the internal id union is widened. `outcome` is the closed per-point
   * outcome (for example `enabled` / `disabled`, `in_memory` / `file_cache` /
   * `defaults`). `reason` is an optional, bounded, allowlisted reason.
   * `inputs` is an optional, bounded, safe disambiguation subset — the same
   * tokens the log line renders (for example the capture-gate `surface`
   * token, which is the only field distinguishing the `recordSideEffect`,
   * `capture`, and `prismaAdapter` surfaces' otherwise-identical events).
   *
   * **No-secret / no-rejected-value contract.** The payload carries flags and
   * enums only: never a raw secret, never a rejected key or value, never
   * nested producer input. API keys appear only masked; a key-shaped config
   * value is reported as `present` / `absent`, never as its value.
   *
   * @example
   * ```ts
   * onLifecycleEvent("core:decision", (e) => {
   *   console.log(e.point, e.outcome, e.inputs?.surface);
   * });
   * ```
   */
  "core:decision": {
    point: string;
    outcome: string;
    reason?: string;
    inputs?: Record<string, string | number | boolean>;
  };

  "auth:key_resolved": { key: string; mode: "anonymous" | "dev" };
  "auth:claim_started": { accountId: string };
  "auth:claim_completed": { newKey: string; accountId: string };

  "otel:configured": { state: OtelState; scenario?: string };
  "otel:injection_succeeded": { method: string };
  "otel:injection_failed": { reason: string };
  /**
   * Structured fail-loud diagnostic emitted when the OTel coexistence
   * path observes an unrecoverable auto-attach failure.
   * Distinct from `otel:injection_failed` (which carries a free-form
   * `reason` string for logging) — `otel:failed` carries a
   * machine-readable payload destined for the runtime-state CLI bridge.
   *
   * **PII-safety:** the payload's `message` is built from a fixed
   * template; `providerClass` is a sanitized constructor name. See
   * `RuntimeStateLastError` in `runtime-state.ts` for the full contract.
   */
  "otel:failed": {
    category: "auto-attach-returned-null";
    message: string;
    timestamp: string;
    providerClass?: string;
  };
  /**
   * The export-path circuit breaker has tripped from CLOSED to OPEN.
   * Fired exactly once per outage; the
   * `category` discriminates the failure class that crossed the
   * consecutive-failure threshold and `nextProbeMs` reports the
   * scheduled HALF_OPEN delay.
   *
   * **PII-safety:** the payload's `message` is built from a fixed
   * template and references only the closed `category` enum and the
   * failure count; never URLs, headers, payload bodies, or the
   * underlying error message text. Mirrors the `otel:failed`
   * contract.
   */
  "otel:circuit_opened": {
    category:
      | "auth"
      | "client_error"
      | "rate_limit"
      | "server_error"
      | "network";
    message: string;
    timestamp: string;
    consecutiveFailures: number;
    nextProbeMs: number;
  };
  /**
   * The breaker's backoff timer expired and the next real export
   * batch is being permitted as a probe. `previousTimerMs`
   * reports the timer that just elapsed; useful for surfacing a
   * recovery-attempt diagnostic in the CLI bridge.
   */
  "otel:circuit_half_open": {
    timestamp: string;
    previousTimerMs: number;
  };
  /**
   * The breaker has transitioned back to CLOSED, either because a
   * probe succeeded or because credential rotation reset the breaker.
   * `outageDurationMs` reports the wall-clock duration
   * the breaker spent in OPEN+HALF_OPEN; `0` when the close was a
   * defensive no-op (already CLOSED).
   */
  "otel:circuit_closed": {
    timestamp: string;
    outageDurationMs: number;
  };
  /**
   * `tracedMiddleware` ran for a procedure invocation under a
   * `wrapBatchedHttpHandler` batch envelope but could not resolve
   * the invocation to a positional batch member (the
   * `procedureName` does not appear in the envelope's procedure
   * list, OR the per-name occurrence count exceeds the positional
   * matches available). The middleware emits the span as today
   * (no batch attributes); this event is informational only — the
   * trace shape is preserved.
   *
   * **PII-safety:** `procedureName` and `batchMembers` are tRPC
   * procedure names already on the trace; no new disclosure
   * surface. `spanId` is the OTel span identifier of the
   * unmatched member span.
   */
  "otel:trpc_batch_member_mismatch": {
    procedureName: string;
    batchMembers: ReadonlyArray<string>;
    spanId: string;
  };
  "otel:shutdown_started": Record<string, never>;
  "otel:shutdown_completed": Record<string, never>;

  "health:init_succeeded": Record<string, never>;
  "health:init_failed": { error: string };
  "health:heartbeat_tick": Record<string, never>;
  "health:config_refreshed": Record<string, never>;

  /**
   * `tracedRequestMiddleware` from `@glasstrace/sdk/middleware` was
   * invoked but the SDK is not registered (early-init race or
   * `OtelState.UNCONFIGURED`). The wrapped middleware still runs;
   * the span landed on the OTel API's noop tracer and was discarded.
   *
   * Emitted at most once per process by the wrapper to avoid log
   * floods on a hot request path; a single signal is sufficient to
   * surface the misconfiguration.
   *
   * **PII-safety:** payload is empty by construction.
   */
  "middleware:skipped_uninstalled": Record<string, never>;
  /**
   * `withAsyncCausality` from `@glasstrace/sdk/async-context` was
   * invoked outside an active request span (no captured
   * `SpanContext` at call time). The continuation still runs; the
   * resulting span has no `glasstrace.causal.post_response_async`
   * link.
   *
   * Emitted at most once per process. **PII-safety:** payload is
   * empty by construction.
   */
  "async:no_originating_context": Record<string, never>;
  /**
   * `withAsyncCausality` continuation fired but the SDK is not
   * registered. The continuation still runs; the span landed on the
   * noop tracer.
   *
   * Emitted at most once per process. **PII-safety:** payload is
   * empty by construction.
   */
  "async:skipped_uninstalled": Record<string, never>;
}

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let _coreState: CoreState = CoreState.IDLE;
let _authState: AuthState = AuthState.ANONYMOUS;
let _otelState: OtelState = OtelState.UNCONFIGURED;
let _emitter: EventEmitter = new EventEmitter();
let _logger: ((level: "warn" | "info" | "error", message: string) => void) | null = null;
let _initialized = false;
let _initWarned = false;
let _coreReadyEmitted = false;
let _authInitialized = false;
let _emitting = false;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the lifecycle module. Must be called before any state
 * transitions. Accepts a logger function to avoid importing SDK modules.
 *
 * Calling this twice logs a warning and is ignored.
 */
export function initLifecycle(options: {
  logger: (level: "warn" | "info" | "error", message: string) => void;
}): void {
  if (_initialized) {
    options.logger("warn", "[glasstrace] initLifecycle() called twice — ignored.");
    return;
  }
  _logger = options.logger;
  _initialized = true;

  // Register the lifecycle-emit bridge so edge-safe wrappers
  // (`./middleware/index.ts`, `./async-context/index.ts`) can emit
  // lifecycle events without a static import on this Node-only
  // module. See `./optional-lifecycle.ts` for the contract.
  _registerLifecycleEmitForBridge((event, payload) => {
    emitLifecycleEvent(
      event as keyof SdkLifecycleEvents,
      payload as SdkLifecycleEvents[keyof SdkLifecycleEvents],
    );
  });
}

// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------

/** Warn once if lifecycle functions are called before initLifecycle(). */
function warnIfNotInitialized(): void {
  if (!_initialized && !_initWarned) {
    _initWarned = true;
    // Use console.warn directly since _logger is null
    console.warn(
      "[glasstrace] Lifecycle state changed before initLifecycle() was called. " +
      "Logger not available — errors will be silent.",
    );
  }
}

/**
 * Transition the core lifecycle state. Invalid transitions are logged
 * and ignored — the state does not change.
 *
 * Guards against reentrant calls: if a listener calls setCoreState()
 * during emission, the inner transition completes first. The outer
 * call's post-transition events (core:ready, shutdown) check the
 * current state before emitting to avoid stale signals.
 */
export function setCoreState(to: CoreState): void {
  warnIfNotInitialized();

  const from = _coreState;
  if (from === to) return;

  const valid = VALID_CORE_TRANSITIONS[from];
  if (!valid.includes(to)) {
    _logger?.(
      "warn",
      `[glasstrace] Invalid core state transition: ${from} → ${to}. Ignored.`,
    );
    return;
  }

  _coreState = to;

  // Guard against reentrant emission: if a listener calls setCoreState(),
  // the inner call will complete (including its own events). The outer call
  // skips its post-transition events to avoid stale/duplicate signals.
  if (_emitting) return;

  _emitting = true;
  try {
    emitSafe("core:state_changed", { from, to });

    // Check current state (not `to`) in case a listener changed it
    const current = _coreState;

    if (!_coreReadyEmitted && (current === CoreState.ACTIVE || current === CoreState.ACTIVE_DEGRADED)) {
      _coreReadyEmitted = true;
      emitSafe("core:ready", {});
    }

    if (current === CoreState.SHUTTING_DOWN) {
      emitSafe("core:shutdown_started", {});
    }
    if (current === CoreState.SHUTDOWN) {
      emitSafe("core:shutdown_completed", {});
    }
  } finally {
    _emitting = false;
  }

  // Catch-up after entering ACTIVE: if a degradation source was
  // pushed while core was still in a pre-ACTIVE state
  // (KEY_PENDING/KEY_RESOLVED), `recomputeCoreFromDegradationSources()`
  // no-op'd at push time because the guard said "only act if core is
  // ACTIVE". Now that we've reached ACTIVE, re-evaluate so the
  // registry's truth wins (Codex P1, 2026-05-08; covers the export
  // circuit + future degradation sources uniformly).
  if (to === CoreState.ACTIVE && _degradationSources.size > 0) {
    recomputeCoreFromDegradationSources();
  }
}

/**
 * Set the initial auth state. Must be called exactly once during
 * registration, before any auth transitions. This bypasses transition
 * validation because the initial state (ANONYMOUS vs AUTHENTICATED)
 * is determined by configuration, not by a runtime transition.
 *
 * Subsequent calls log a warning and are ignored.
 */
export function initAuthState(state: AuthState): void {
  if (_authInitialized) {
    _logger?.(
      "warn",
      "[glasstrace] initAuthState() called after auth state already initialized. Ignored.",
    );
    return;
  }
  _authInitialized = true;
  _authState = state;
}

/**
 * Transition the auth lifecycle state. Invalid transitions are logged
 * and ignored.
 */
export function setAuthState(to: AuthState): void {
  warnIfNotInitialized();

  const from = _authState;
  if (from === to) return;

  const valid = VALID_AUTH_TRANSITIONS[from];
  if (!valid.includes(to)) {
    _logger?.(
      "warn",
      `[glasstrace] Invalid auth state transition: ${from} → ${to}. Ignored.`,
    );
    return;
  }

  _authState = to;
}

/**
 * Transition the OTel coexistence state. Invalid transitions are logged
 * and ignored.
 */
export function setOtelState(to: OtelState): void {
  warnIfNotInitialized();

  const from = _otelState;
  if (from === to) return;

  const valid = VALID_OTEL_TRANSITIONS[from];
  if (!valid.includes(to)) {
    _logger?.(
      "warn",
      `[glasstrace] Invalid OTel state transition: ${from} → ${to}. Ignored.`,
    );
    return;
  }

  _otelState = to;
}

// ---------------------------------------------------------------------------
// Degradation Source Registry (DISC-1568 / Wave 15C)
//
// Multiple subsystems can independently push the SDK into
// `CoreState.ACTIVE_DEGRADED`. Each source registers a key here when
// it goes degraded and clears the same key when it recovers.
// `recomputeCoreFromDegradationSources()` reads the registry and
// transitions `ACTIVE ↔ ACTIVE_DEGRADED` only when the SDK is in one
// of those two states — `OtelState.COEXISTENCE_FAILED` and other
// pre-`ACTIVE` states are untouched.
//
// Keys are namespaced strings (e.g., `"export-circuit"`) so multiple
// sources can coexist without clobbering each other. Centralising the
// recompute prevents the "two sources of truth" bug where one source
// thinks the SDK is healthy but another still has it degraded.
// ---------------------------------------------------------------------------

const _degradationSources = new Set<string>();

/**
 * Register a subsystem-specific degradation source. Idempotent — calling
 * twice with the same key has no additional effect. After updating the
 * registry the function calls {@link recomputeCoreFromDegradationSources}
 * so a transition fires immediately when appropriate.
 */
export function pushDegradationSource(key: string): void {
  _degradationSources.add(key);
  recomputeCoreFromDegradationSources();
}

/**
 * Clear a previously-registered degradation source. Triggers a
 * recompute so the SDK can return to `CoreState.ACTIVE` if no other
 * source remains.
 */
export function clearDegradationSource(key: string): void {
  _degradationSources.delete(key);
  recomputeCoreFromDegradationSources();
}

/**
 * Re-evaluate the core state against the degradation registry:
 *
 * - At least one source AND core is `ACTIVE` → transition to
 *   `ACTIVE_DEGRADED`.
 * - Zero sources AND core is `ACTIVE_DEGRADED` → transition to
 *   `ACTIVE`.
 * - Otherwise: no-op. We do not push a pre-ACTIVE state forward and
 *   we do not transition out of terminal/shutdown states.
 *
 * Centralised so a future degradation source (e.g., heartbeat
 * failures) can reuse the same path without duplicating the guard.
 */
export function recomputeCoreFromDegradationSources(): void {
  const hasDegradation = _degradationSources.size > 0;
  if (hasDegradation && _coreState === CoreState.ACTIVE) {
    setCoreState(CoreState.ACTIVE_DEGRADED);
    return;
  }
  if (!hasDegradation && _coreState === CoreState.ACTIVE_DEGRADED) {
    setCoreState(CoreState.ACTIVE);
  }
}

// ---------------------------------------------------------------------------
// State Queries
// ---------------------------------------------------------------------------

/** Returns the current core lifecycle state. */
export function getCoreState(): CoreState {
  return _coreState;
}

/** Returns the current auth lifecycle state. */
export function getAuthState(): AuthState {
  return _authState;
}

/** Returns the current OTel coexistence state. */
export function getOtelState(): OtelState {
  return _otelState;
}

/** Returns the full internal state across all layers. */
export function getSdkState(): {
  core: CoreState;
  auth: AuthState;
  otel: OtelState;
} {
  return {
    core: _coreState,
    auth: _authState,
    otel: _otelState,
  };
}

// ---------------------------------------------------------------------------
// Event Emitter
// ---------------------------------------------------------------------------

/**
 * Subscribe to a lifecycle event. The listener is synchronous.
 * Errors in listeners are caught and logged.
 */
export function onLifecycleEvent<K extends keyof SdkLifecycleEvents>(
  event: K,
  listener: (payload: SdkLifecycleEvents[K]) => void,
): void {
  _emitter.on(event, listener);
}

/**
 * Emit a typed lifecycle event. Exported so that other SDK modules
 * (auth, OTel, health) can emit their layer-specific events through
 * the shared emitter with type safety.
 */
export function emitLifecycleEvent<K extends keyof SdkLifecycleEvents>(
  event: K,
  payload: SdkLifecycleEvents[K],
): void {
  emitSafe(event, payload);
}

/**
 * Unsubscribe from a lifecycle event.
 */
export function offLifecycleEvent<K extends keyof SdkLifecycleEvents>(
  event: K,
  listener: (payload: SdkLifecycleEvents[K]) => void,
): void {
  _emitter.off(event, listener);
}

/**
 * Emit a lifecycle event. Each listener is called individually so that
 * an error in one listener does not prevent subsequent listeners from
 * running. Both synchronous throws and async rejections are caught and
 * logged via the lifecycle logger.
 */
function emitSafe<K extends keyof SdkLifecycleEvents>(
  event: K,
  payload: SdkLifecycleEvents[K],
): void {
  const listeners = _emitter.listeners(event);
  for (const listener of listeners) {
    try {
      const result = (listener as (p: SdkLifecycleEvents[K]) => unknown)(payload);
      // Catch async listeners that return a rejected promise
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((err: unknown) => {
          _logger?.(
            "error",
            `[glasstrace] Async error in lifecycle event listener for "${event}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    } catch (err) {
      _logger?.(
        "error",
        `[glasstrace] Error in lifecycle event listener for "${event}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Readiness API
// ---------------------------------------------------------------------------

/**
 * Returns true when the SDK is in ACTIVE or ACTIVE_DEGRADED state.
 */
export function isReady(): boolean {
  return _coreState === CoreState.ACTIVE || _coreState === CoreState.ACTIVE_DEGRADED;
}

/**
 * Resolves when the SDK reaches ACTIVE or ACTIVE_DEGRADED.
 * Rejects on PRODUCTION_DISABLED, REGISTRATION_FAILED, or timeout.
 *
 * Checks current state synchronously first — resolves/rejects immediately
 * if the SDK has already reached a terminal or ready state.
 */
export function waitForReady(timeoutMs = 30000): Promise<void> {
  // Check current state synchronously
  if (isReady()) {
    return Promise.resolve();
  }
  if (
    _coreState === CoreState.PRODUCTION_DISABLED ||
    _coreState === CoreState.REGISTRATION_FAILED ||
    _coreState === CoreState.SHUTTING_DOWN ||
    _coreState === CoreState.SHUTDOWN
  ) {
    return Promise.reject(new Error(`SDK is in terminal state: ${_coreState}`));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const listener = ({ to }: { from: CoreState; to: CoreState }) => {
      if (settled) return;
      if (to === CoreState.ACTIVE || to === CoreState.ACTIVE_DEGRADED) {
        settled = true;
        offLifecycleEvent("core:state_changed", listener);
        resolve();
      } else if (
        to === CoreState.PRODUCTION_DISABLED ||
        to === CoreState.REGISTRATION_FAILED ||
        to === CoreState.SHUTTING_DOWN ||
        to === CoreState.SHUTDOWN
      ) {
        settled = true;
        offLifecycleEvent("core:state_changed", listener);
        reject(new Error(`SDK reached terminal state: ${to}`));
      }
    };

    onLifecycleEvent("core:state_changed", listener);

    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        offLifecycleEvent("core:state_changed", listener);
        reject(new Error(`waitForReady timed out after ${timeoutMs}ms (state: ${_coreState})`));
      }, timeoutMs);
      // unref() so this timer doesn't prevent process exit
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    }
  });
}

/**
 * Simplified public state query for external consumers.
 * Hides implementation details like coexistence scenarios.
 *
 * The returned `tracing` field is the canonical user-observable signal
 * for OTel coexistence outcomes:
 *
 * - `"active"` — the SDK owns the OTel provider and is exporting spans.
 * - `"coexistence"` — another OTel provider was detected and the SDK
 *   either auto-attached its span processor or found one already
 *   present. Spans are exported through the existing pipeline.
 * - `"degraded"` — the SDK is exporting but the core lifecycle entered
 *   `ACTIVE_DEGRADED` (e.g., a non-fatal export failure).
 * - `"not-configured"` — the SDK could not configure tracing. Covers
 *   `OtelState.UNCONFIGURED`, `OtelState.CONFIGURING`, and
 *   `OtelState.COEXISTENCE_FAILED` (the Next 16 production
 *   "auto-attach returned null" path). When the value is
 *   `"not-configured"` after `registerGlasstrace()` has resolved,
 *   spans are NOT reaching the Glasstrace exporter and the manual
 *   `createGlasstraceSpanProcessor()` workaround should be applied.
 *   See `runtime-state.json`'s `lastError` field for the structured
 *   failure record.
 */
export function getStatus(): {
  ready: boolean;
  mode: "anonymous" | "authenticated" | "claiming" | "disabled";
  tracing: "active" | "degraded" | "not-configured" | "coexistence";
} {
  let mode: "anonymous" | "authenticated" | "claiming" | "disabled";
  if (_coreState === CoreState.PRODUCTION_DISABLED) {
    mode = "disabled";
  } else if (_authState === AuthState.CLAIMING || _authState === AuthState.CLAIMED) {
    mode = "claiming";
  } else if (_authState === AuthState.AUTHENTICATED) {
    mode = "authenticated";
  } else {
    mode = "anonymous";
  }

  let tracing: "active" | "degraded" | "not-configured" | "coexistence";
  if (_otelState === OtelState.COEXISTENCE_FAILED || _otelState === OtelState.UNCONFIGURED || _otelState === OtelState.CONFIGURING) {
    tracing = "not-configured";
  } else if (_coreState === CoreState.ACTIVE_DEGRADED) {
    tracing = "degraded";
  } else if (_otelState === OtelState.AUTO_ATTACHED || _otelState === OtelState.PROCESSOR_PRESENT) {
    tracing = "coexistence";
  } else {
    tracing = "active";
  }

  return {
    ready: isReady(),
    mode,
    tracing,
  };
}

// ---------------------------------------------------------------------------
// Shutdown Coordinator
//
// IMPORTANT: The shutdown system has two parts that must stay in sync:
//   1. HOOKS — registered via registerShutdownHook() by each module
//   2. TRIGGERS — registerSignalHandlers() for signal-based exit, or
//      registerBeforeExitTrigger() for event-loop-drain exit. Both
//      call executeShutdown() which is idempotent.
//
// Rules for agents modifying shutdown behavior:
//   - When registering a hook, verify its trigger exists in the same PR.
//     A hook without a trigger is dead code.
//   - When removing a trigger, verify no hooks depend on it.
//     A trigger removal without hook cleanup drops spans on exit.
//   - Scenario A (bare path): register BOTH signal handlers AND
//     beforeExit trigger. Signals cover SIGTERM/SIGINT, beforeExit
//     covers clean event loop drain (all timers unref'd).
//   - Scenario B (coexistence): signal handlers are ALWAYS installed
//     (DISC-1265) but do NOT re-raise (coexistenceState="coexisting").
//     The beforeExit trigger also fires for event-loop-drain exit.
//     The existing provider owns signal re-raise and its own flush.
// ---------------------------------------------------------------------------

export interface ShutdownHook {
  name: string;
  priority: number;
  fn: () => Promise<void>;
}

let _shutdownHooks: ShutdownHook[] = [];
let _signalHandlersRegistered = false;
let _signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
let _beforeExitRegistered = false;
let _beforeExitHandler: (() => void) | null = null;
let _shutdownExecuted = false;

/**
 * Register a shutdown hook. Hooks are executed in priority order
 * (lower number = earlier execution) during shutdown.
 */
export function registerShutdownHook(hook: ShutdownHook): void {
  _shutdownHooks.push(hook);
  _shutdownHooks.sort((a, b) => a.priority - b.priority);
}

/**
 * Execute all registered shutdown hooks in priority order.
 * Each hook runs with a timeout. Errors in individual hooks are caught
 * and logged — remaining hooks still execute.
 *
 * Idempotent: calling this multiple times has no effect after the first.
 */
export async function executeShutdown(timeoutMs = 5000): Promise<void> {
  if (_shutdownExecuted) return;
  _shutdownExecuted = true;

  setCoreState(CoreState.SHUTTING_DOWN);

  for (const hook of _shutdownHooks) {
    try {
      // Suppress unhandled rejection on the hook promise if the timeout wins the race.
      const hookPromise = hook.fn();
      hookPromise.catch(() => {});

      await Promise.race([
        hookPromise,
        new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`Shutdown hook "${hook.name}" timed out`)), timeoutMs);
          if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
          }
        }),
      ]);
    } catch (err) {
      _logger?.(
        "warn",
        `[glasstrace] Shutdown hook "${hook.name}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  setCoreState(CoreState.SHUTDOWN);
}

/**
 * Register SIGTERM and SIGINT handlers that trigger the shutdown coordinator.
 * Always installed by registerGlasstrace(), regardless of whether another
 * OTel provider exists. The re-raise decision is deferred to
 * delivery time: the handler checks coexistenceState (set by configureOtel()
 * once its async provider probe completes) and only re-raises when NOT
 * "coexisting". In coexistence mode, hooks still run but the existing
 * provider is responsible for re-raising the signal.
 */
export function registerSignalHandlers(): void {
  if (_signalHandlersRegistered) return;
  if (typeof process === "undefined" || typeof process.once !== "function") return;

  _signalHandlersRegistered = true;

  // Snapshot listener counts BEFORE we install our own handlers. A non-zero
  // count means another party (Sentry, Datadog, the existing provider) already
  // owns SIGTERM/SIGINT and will re-raise when it is done flushing. Zero means
  // nobody else handles the signal — if we don't re-raise, the process hangs.
  // This check is needed because `coexistenceState === "coexisting"` only tells
  // us that ANOTHER OTEL PROVIDER exists, not that it installed signal handlers.
  // A bare BasicTracerProvider has no signal handlers, so we must still re-raise.
  const otherSigtermListeners = process.listenerCount("SIGTERM");
  const otherSigintListeners = process.listenerCount("SIGINT");

  const handler = (signal: NodeJS.Signals) => {
    void executeShutdown().finally(() => {
      // Remove our handler to avoid re-entry on re-raise.
      if (_signalHandler) {
        process.removeListener("SIGTERM", _signalHandler);
        process.removeListener("SIGINT", _signalHandler);
      }
      // Re-raise the signal to restore default OS behavior UNLESS we are in
      // coexistence mode AND the other provider had its own signal handlers at
      // registration time. When both conditions hold, that provider owns signal
      // re-raise and will terminate the process on its own schedule; re-raising
      // here would race against its async flush and could kill the process
      // before buffered spans are delivered.
      //
      // When coexisting but NO pre-existing signal listeners were detected, we
      // must still re-raise — the other provider (e.g. a bare BasicTracerProvider)
      // has no signal ownership, so OS default termination will not happen
      // otherwise and the process would hang indefinitely.
      //
      // During the async-window ("unknown"), re-raise is the safe default because
      // it preserves standard process termination semantics when we have no
      // information about provider ownership.
      const otherListeners = signal === "SIGTERM" ? otherSigtermListeners : otherSigintListeners;
      const otherProviderOwnsSignal = getCoexistenceState() === "coexisting" && otherListeners > 0;
      if (!otherProviderOwnsSignal) {
        process.kill(process.pid, signal);
      }
    });
  };

  _signalHandler = handler;
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

/**
 * Register a beforeExit handler that triggers the shutdown coordinator.
 * beforeExit fires when the event loop drains (not on signals).
 *
 * For Scenario B (coexistence): Glasstrace installs signal handlers
 * but does not re-raise — the existing provider owns signal re-raise. This
 * beforeExit trigger covers the edge case where the process exits without
 * signals (event loop drains naturally).
 *
 * Both signal handlers and beforeExit triggers call the same executeShutdown(),
 * which is idempotent — if signals already ran shutdown, beforeExit is a no-op.
 */
export function registerBeforeExitTrigger(): void {
  if (_beforeExitRegistered) return;
  if (typeof process === "undefined" || typeof process.once !== "function") return;

  _beforeExitRegistered = true;

  const handler = () => {
    void executeShutdown();
  };

  _beforeExitHandler = handler;
  process.once("beforeExit", handler);
}

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

/**
 * Reset all lifecycle state to initial values. For testing only.
 * Removes all event listeners, resets all state enums, and clears
 * the initialized flag.
 */
export function resetLifecycleForTesting(): void {
  _coreState = CoreState.IDLE;
  _authState = AuthState.ANONYMOUS;
  _otelState = OtelState.UNCONFIGURED;
  _emitter.removeAllListeners();
  _emitter = new EventEmitter();
  _logger = null;
  _initialized = false;
  _initWarned = false;
  _coreReadyEmitted = false;
  _authInitialized = false;
  _emitting = false;
  _shutdownHooks = [];
  _shutdownExecuted = false;
  _degradationSources.clear();
  if (_signalHandler && typeof process !== "undefined") {
    process.removeListener("SIGTERM", _signalHandler);
    process.removeListener("SIGINT", _signalHandler);
  }
  _signalHandler = null;
  _signalHandlersRegistered = false;
  if (_beforeExitHandler && typeof process !== "undefined") {
    process.removeListener("beforeExit", _beforeExitHandler);
  }
  _beforeExitHandler = null;
  _beforeExitRegistered = false;
  _clearLifecycleEmitForBridge();
}
