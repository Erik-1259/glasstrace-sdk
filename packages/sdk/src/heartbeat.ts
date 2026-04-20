import type { AnonApiKey } from "@glasstrace/protocol";
import type { ResolvedConfig } from "./env-detection.js";
import { collectHealthReport } from "./health-collector.js";
import { performInit, consumeRateLimitFlag } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { registerShutdownHook, executeShutdown } from "./lifecycle.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const BACKOFF_BASE_MS = HEARTBEAT_INTERVAL_MS;   // 5 minutes
const BACKOFF_MAX_MS = 30 * 60 * 1000;           // 30 minutes
const BACKOFF_JITTER = 0.2;                       // ±20%

/**
 * Shutdown hook priority for the final heartbeat report.
 *
 * Per docs/component-designs/sdk-lifecycle.md Section 8.3:
 *   0  — OTel flush (must run first so spans are exported)
 *   10 — Heartbeat final report (includes final span counts)
 *   20 — Runtime state write (terminal state persisted last)
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-lifecycle.md §8.3 Shutdown Sequence
 */
const HEARTBEAT_SHUTDOWN_PRIORITY = 10;

const SHUTDOWN_MARKER_RELPATH = ".glasstrace/shutdown-requested";

// --- Module-level state ---

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatGeneration = 0;
let backoffAttempts = 0;
let backoffUntil = 0;
let tickInProgress = false;

/**
 * Ensures the shutdown hook is only registered once per process and that
 * the final report is only sent once even if the hook runs more than once.
 */
let shutdownHookRegistered = false;
let shutdownFired = false;

// --- Public API ---

/**
 * Starts the periodic health heartbeat after successful init.
 * Timer is unref()'d so it doesn't prevent process exit.
 *
 * Registers a shutdown hook with the lifecycle coordinator (priority 10)
 * so the final health report runs after OTel flush (priority 0) and before
 * runtime state write (priority 20). The hook is registered once per
 * process; subsequent `startHeartbeat` calls do not re-register.
 *
 * @param onClaimTransition - Callback for claim key rotation, avoiding
 *   circular dependency with otel-config.ts.
 */
export function startHeartbeat(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
  generation: number,
  onClaimTransition: (newApiKey: string, accountId: string) => void,
): void {
  // Prevent double-start
  if (heartbeatTimer !== null) return;

  heartbeatGeneration = generation;

  heartbeatTimer = setInterval(() => {
    void heartbeatTick(config, anonKey, sdkVersion, generation, onClaimTransition);
  }, HEARTBEAT_INTERVAL_MS);

  // unref() so the timer doesn't prevent Node.js process exit
  heartbeatTimer.unref();

  // Register the final health-report hook with the lifecycle coordinator.
  // Signal handling is owned by the coordinator (registerSignalHandlers in
  // otel-config.ts), so the heartbeat module no longer attaches directly to
  // SIGTERM/SIGINT.
  registerHeartbeatShutdownHook(config, anonKey, sdkVersion);

  if (config.verbose) {
    sdkLog("info", "[glasstrace] Heartbeat started (5-minute interval).");
  }
}

/**
 * Stops the heartbeat timer.
 *
 * The shutdown hook is intentionally not unregistered — the lifecycle
 * coordinator does not expose a removal API. Stopping the heartbeat here
 * suppresses future periodic ticks by clearing the timer, but it does not
 * prevent the already-registered shutdown hook from sending its final
 * health report once during process shutdown. The hook's internal
 * `shutdownFired` guard ensures it runs at most once regardless.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Resets all heartbeat state. For testing only.
 */
export function _resetHeartbeatForTesting(): void {
  stopHeartbeat();
  heartbeatGeneration = 0;
  backoffAttempts = 0;
  backoffUntil = 0;
  tickInProgress = false;
  shutdownHookRegistered = false;
  shutdownFired = false;
}

/**
 * Checks for the presence of the `.glasstrace/shutdown-requested` marker
 * file and, if present, triggers the lifecycle shutdown coordinator and
 * removes the marker (DISC-1247 Scenario 1).
 *
 * Returns `true` when the marker was found and the shutdown coordinator
 * was scheduled, `false` otherwise. The marker is removed synchronously
 * BEFORE executeShutdown() is scheduled so a crash during shutdown does
 * not cause the marker to be re-detected on restart.
 *
 * The filesystem lookup itself is synchronous, but `node:fs`/`node:path`
 * are loaded lazily via `require()` inside this helper rather than via
 * top-level imports. This keeps the helper usable from fake-timer-driven
 * heartbeat ticks without introducing extra microtask boundaries, while
 * also avoiding unconditional top-level built-in imports on module
 * load. The downstream `executeShutdown()` call can be awaited by the
 * caller when desired.
 *
 * Self-contained so it can be called from either the heartbeat tick
 * (current location) or a dedicated lifecycle hook after DISC-1248 lands.
 *
 * @param projectRoot - Optional project root; defaults to `process.cwd()`.
 * @returns An object describing the outcome. When `triggered` is true,
 *   `shutdown` is the promise returned by `executeShutdown()` so the
 *   caller can optionally await full shutdown completion.
 */
export function checkShutdownMarker(projectRoot?: string): {
  triggered: boolean;
  shutdown?: Promise<void>;
} {
  // node:fs and node:path are imported lazily via require to remain
  // compatible with non-Node bundlers that externalize node:* modules.
  // Errors are swallowed — a non-Node environment simply reports
  // "no marker".
  let fsSync: typeof import("node:fs") | null = null;
  let pathSync: typeof import("node:path") | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fsSync = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pathSync = require("node:path") as typeof import("node:path");
  } catch {
    return { triggered: false };
  }

  const root = projectRoot ?? (typeof process !== "undefined" ? process.cwd() : ".");
  const markerPath = pathSync.join(root, SHUTDOWN_MARKER_RELPATH);

  if (!fsSync.existsSync(markerPath)) return { triggered: false };

  // Remove the marker BEFORE scheduling shutdown. If we removed it
  // afterwards, a crashed process would leave the marker in place and
  // cause the next start to shut down immediately.
  try {
    fsSync.unlinkSync(markerPath);
  } catch {
    // Best-effort — proceed with shutdown even if removal fails.
  }

  // executeShutdown is idempotent and never throws; fire-and-track the
  // returned promise so the caller can optionally await completion.
  const shutdown = executeShutdown().catch(() => {
    // executeShutdown is designed not to throw; swallow defensively.
  });
  return { triggered: true, shutdown };
}

// --- Internal: heartbeat tick ---

async function heartbeatTick(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
  generation: number,
  onClaimTransition: (newApiKey: string, accountId: string) => void,
): Promise<void> {
  // Prevent concurrent ticks (setInterval doesn't await async callbacks)
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    // Generation check — stop if registration was reset
    if (generation !== heartbeatGeneration) {
      stopHeartbeat();
      return;
    }

    // DISC-1247 Scenario 1: check for the shutdown-requested marker at
    // the top of each tick. If `sdk uninit` has been run, the marker
    // exists and we trigger shutdown immediately. Moved into a dedicated
    // lifecycle hook once DISC-1248 lands — the helper is module-exported
    // to keep that migration mechanical.
    //
    // The check itself is synchronous (fs.existsSync) so fake-timer tests
    // stay deterministic; we do await the shutdown promise once it has
    // been scheduled so the tick does not race its own cleanup.
    const markerResult = checkShutdownMarker();
    if (markerResult.triggered) {
      stopHeartbeat();
      if (markerResult.shutdown) {
        await markerResult.shutdown;
      }
      return;
    }

    // Backoff check — skip this tick if in backoff window
    if (Date.now() < backoffUntil) {
      if (config.verbose) {
        sdkLog("info", "[glasstrace] Heartbeat skipped (rate-limit backoff).");
      }
      return;
    }

    // Collect and send health report (same pattern as backgroundInit)
    const healthReport = collectHealthReport(sdkVersion);
    const initResult = await performInit(config, anonKey, sdkVersion, healthReport);

    // Generation re-check after async work
    if (generation !== heartbeatGeneration) return;

    // Handle 429 backoff via consumeRateLimitFlag
    if (initResult === null && consumeRateLimitFlag()) {
      backoffAttempts++;
      const delay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, backoffAttempts - 1),
        BACKOFF_MAX_MS,
      );
      const jitter = delay * BACKOFF_JITTER * (Math.random() * 2 - 1);
      backoffUntil = Date.now() + delay + jitter;
      if (config.verbose) {
        sdkLog("info", `[glasstrace] Heartbeat backing off for ${Math.round((delay + jitter) / 1000)}s.`);
      }
    } else {
      // Success or non-429 failure — reset backoff
      backoffAttempts = 0;
      backoffUntil = 0;
    }

    // Handle claim transition via callback (no otel-config import needed)
    if (initResult?.claimResult) {
      onClaimTransition(initResult.claimResult.newApiKey, initResult.claimResult.accountId);
    }

    if (config.verbose) {
      sdkLog("info", "[glasstrace] Heartbeat completed.");
    }
  } finally {
    tickInProgress = false;
  }
}

// --- Internal: shutdown health report ---

/**
 * Registers the heartbeat's final-report hook exactly once per process.
 *
 * The hook:
 *   - Is idempotent (`shutdownFired` guard) so a duplicate invocation by
 *     the coordinator cannot double-report.
 *   - Stops the timer first so no further ticks race with the final report.
 *   - Preserves the exact payload that the previous direct-handler code
 *     sent (`collectHealthReport` + `performInit`), so consumers observe
 *     identical shutdown telemetry before and after this refactor.
 *   - Does NOT re-raise the signal. The lifecycle coordinator's signal
 *     handler owns signal propagation and calls process.kill() after all
 *     hooks complete.
 */
function registerHeartbeatShutdownHook(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
): void {
  if (shutdownHookRegistered) return;
  shutdownHookRegistered = true;

  registerShutdownHook({
    name: "heartbeat-final-report",
    priority: HEARTBEAT_SHUTDOWN_PRIORITY,
    fn: async () => {
      if (shutdownFired) return;
      shutdownFired = true;

      // Stop the heartbeat timer — no more ticks after this
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // Best-effort final report. Errors are swallowed so they don't
      // prevent the remainder of the shutdown sequence from completing.
      try {
        const healthReport = collectHealthReport(sdkVersion);
        await performInit(config, anonKey, sdkVersion, healthReport);
      } catch {
        // Intentionally swallow final-report failures to avoid adding
        // shutdown noise or interrupting the remaining shutdown hooks.
      }
    },
  });
}
