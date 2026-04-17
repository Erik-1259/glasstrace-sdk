import type { AnonApiKey } from "@glasstrace/protocol";
import type { ResolvedConfig } from "./env-detection.js";
import { collectHealthReport } from "./health-collector.js";
import { performInit, consumeRateLimitFlag } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { executeShutdown } from "./lifecycle.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const BACKOFF_BASE_MS = HEARTBEAT_INTERVAL_MS;   // 5 minutes
const BACKOFF_MAX_MS = 30 * 60 * 1000;           // 30 minutes
const BACKOFF_JITTER = 0.2;                       // ±20%

const SHUTDOWN_MARKER_RELPATH = ".glasstrace/shutdown-requested";

// --- Module-level state ---

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatGeneration = 0;
let backoffAttempts = 0;
let backoffUntil = 0;
let tickInProgress = false;

/** Stored reference for clean removal via process.removeListener. */
let _shutdownHandler: ((signal: NodeJS.Signals) => void) | null = null;


// --- Public API ---

/**
 * Starts the periodic health heartbeat after successful init.
 * Timer is unref()'d so it doesn't prevent process exit.
 * Registers its own SIGTERM/SIGINT handlers for the shutdown health report.
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

  // Register shutdown handlers for the final health report
  registerShutdownHandlers(config, anonKey, sdkVersion);

  if (config.verbose) {
    sdkLog("info", "[glasstrace] Heartbeat started (5-minute interval).");
  }
}

/**
 * Stops the heartbeat timer and removes shutdown handlers.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  removeShutdownHandlers();
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

function registerShutdownHandlers(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
): void {
  if (typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }

  let shutdownFired = false;

  const handler = (signal: NodeJS.Signals) => {
    if (shutdownFired) return;
    shutdownFired = true;

    // Stop the heartbeat timer — no more ticks after this
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    // Send final health report, then re-raise the signal so the process
    // exits. Without re-raising, Node suppresses default termination
    // when a signal handler is present, which can cause stuck pods.
    const healthReport = collectHealthReport(sdkVersion);
    void performInit(config, anonKey, sdkVersion, healthReport)
      .catch(() => { /* best-effort */ })
      .finally(() => {
        // Remove our handlers before re-raising to avoid re-entry
        removeShutdownHandlers();
        process.kill(process.pid, signal);
      });
  };

  _shutdownHandler = handler;
  process.once("SIGTERM", _shutdownHandler);
  process.once("SIGINT", _shutdownHandler);
}

function removeShutdownHandlers(): void {
  if (_shutdownHandler && typeof process !== "undefined") {
    process.removeListener("SIGTERM", _shutdownHandler);
    process.removeListener("SIGINT", _shutdownHandler);
    _shutdownHandler = null;
  }
}
