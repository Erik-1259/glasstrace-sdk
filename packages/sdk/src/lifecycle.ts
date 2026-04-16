/**
 * SDK Lifecycle State Machine
 *
 * Provides a single source of truth for SDK state across three runtime
 * layers: core, auth, and OTel coexistence. (The CLI layer is handled
 * separately via the runtime state file bridge in SDK-026.)
 *
 * The core layer provides a shared typed event emitter that other layers
 * and SDK modules use for cross-layer communication.
 *
 * This module has NO imports from other SDK modules. It accepts a logger
 * function via initLifecycle() to avoid circular dependencies.
 *
 * @see docs/component-designs/sdk-lifecycle.md
 */

import { EventEmitter } from "node:events";

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

const VALID_AUTH_TRANSITIONS: Record<AuthState, readonly AuthState[]> = {
  [AuthState.ANONYMOUS]: [AuthState.CLAIMING],
  [AuthState.AUTHENTICATED]: [AuthState.CLAIMING],
  [AuthState.CLAIMING]: [AuthState.CLAIMED],
  [AuthState.CLAIMED]: [AuthState.CLAIMING],
};

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

  "auth:key_resolved": { key: string; mode: "anonymous" | "dev" };
  "auth:claim_started": { accountId: string };
  "auth:claim_completed": { newKey: string; accountId: string };

  "otel:configured": { state: OtelState; scenario?: string };
  "otel:injection_succeeded": { method: string };
  "otel:injection_failed": { reason: string };
  "otel:shutdown_started": Record<string, never>;
  "otel:shutdown_completed": Record<string, never>;

  "health:init_succeeded": Record<string, never>;
  "health:init_failed": { error: string };
  "health:heartbeat_tick": Record<string, never>;
  "health:config_refreshed": Record<string, never>;
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
//   2. TRIGGERS — signal handlers (registerSignalHandlers) or direct
//      beforeExit handlers that call executeShutdown() or flush directly
//
// Rules for agents modifying shutdown behavior:
//   - When registering a hook, verify its trigger exists in the same PR.
//     A hook without a trigger is dead code.
//   - When removing a trigger, verify no hooks depend on it.
//     A trigger removal without hook cleanup drops spans on exit.
//   - In coexistence mode, the existing provider owns signals. Use
//     direct beforeExit handlers (not the coordinator) for safety-net
//     flush because executeShutdown() is only triggered by OUR signal
//     handlers, which aren't registered in coexistence mode.
// ---------------------------------------------------------------------------

export interface ShutdownHook {
  name: string;
  priority: number;
  fn: () => Promise<void>;
}

let _shutdownHooks: ShutdownHook[] = [];
let _signalHandlersRegistered = false;
let _signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
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
 * Register SIGTERM and SIGINT handlers that trigger the shutdown
 * coordinator. Called by the core lifecycle setup, not by individual
 * layers. Re-raises the signal after shutdown completes.
 */
export function registerSignalHandlers(): void {
  if (_signalHandlersRegistered) return;
  if (typeof process === "undefined" || typeof process.once !== "function") return;

  _signalHandlersRegistered = true;

  const handler = (signal: NodeJS.Signals) => {
    void executeShutdown().finally(() => {
      // Remove our handler and re-raise the signal for default behavior
      if (_signalHandler) {
        process.removeListener("SIGTERM", _signalHandler);
        process.removeListener("SIGINT", _signalHandler);
      }
      process.kill(process.pid, signal);
    });
  };

  _signalHandler = handler;
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
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
  if (_signalHandler && typeof process !== "undefined") {
    process.removeListener("SIGTERM", _signalHandler);
    process.removeListener("SIGINT", _signalHandler);
  }
  _signalHandler = null;
  _signalHandlersRegistered = false;
}
