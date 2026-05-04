/**
 * Runtime State Bridge
 *
 * Writes the SDK's lifecycle state to `.glasstrace/runtime-state.json`
 * so that CLI commands (npx @glasstrace/sdk status) can report runtime
 * state without a live process connection.
 *
 * Design: sdk-lifecycle.md Section 14 (Runtime State File)
 * Task brief: SDK-026
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getSdkState,
  onLifecycleEvent,
  CoreState,
} from "./lifecycle.js";
import { sdkLog } from "./console-capture.js";
import { atomicWriteFileSync, isSyncFsAvailable } from "./atomic-write.js";

/** Schema for the runtime state file. */
export interface RuntimeState {
  updatedAt: string;
  pid: number;
  sdkVersion: string;
  core: { state: string };
  auth: { state: string };
  otel: { state: string; scenario?: string };
}

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let _projectRoot: string | null = null;
let _sdkVersion: string = "unknown";
let _lastScenario: string | undefined;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start writing runtime state to disk on every lifecycle state transition.
 * Must be called after initLifecycle() and after the project root is known.
 *
 * Writes are debounced to max once per second. The final SHUTDOWN state
 * bypasses debounce to ensure it's always persisted.
 *
 * Probes synchronous `node:fs` availability once before registering any
 * listeners. When the probe fails — for example, when the SDK is loaded as
 * an ESM module under a Next.js dev/start server, where tsup's bundled
 * `__require` shim cannot resolve `require("node:fs")` from an ESM scope
 * (DISC-1555) — registration is skipped silently. The runtime-state file
 * is a best-effort CLI bridge; trace capture continues unaffected. A
 * later `npx @glasstrace/sdk status` call falls back to its existing
 * "no runtime state available" path, matching the behavior on a project
 * that has not yet run the SDK. The skip is intentional and not surfaced
 * even under `verbose` because "synchronous node:fs is unreachable here"
 * is not an actionable debug signal in production.
 */
export function startRuntimeStateWriter(options: {
  projectRoot: string;
  sdkVersion: string;
}): void {
  if (_started) return;

  // Probe synchronous `node:fs` availability once. atomicWriteFileSync()
  // calls the same loader internally; calling it here lets a single
  // probe gate every subsequent write without paying for repeated
  // try/catch on each lifecycle event. The cache is shared with
  // atomic-write, so the probe also primes the loader for downstream
  // CLI sites in the rare case they run in the same process.
  if (!isSyncFsAvailable()) {
    _started = true;
    return;
  }

  _started = true;

  _projectRoot = options.projectRoot;
  _sdkVersion = options.sdkVersion;

  // Listen for state changes across all layers
  onLifecycleEvent("core:state_changed", ({ to }) => {
    if (to === CoreState.SHUTDOWN) {
      // Bypass debounce for terminal state — write immediately
      writeStateNow();
    } else {
      debouncedWrite();
    }
  });

  onLifecycleEvent("otel:configured", ({ scenario }) => {
    _lastScenario = scenario;
    debouncedWrite();
  });

  // Auth events — write when key resolves or claim transitions occur
  onLifecycleEvent("auth:key_resolved", () => debouncedWrite());
  onLifecycleEvent("auth:claim_started", () => debouncedWrite());
  onLifecycleEvent("auth:claim_completed", () => debouncedWrite());

  // No shutdown hook needed — the SHUTDOWN bypass in the core:state_changed
  // listener writes the final state synchronously during setCoreState(SHUTDOWN).
  // A hook would write SHUTTING_DOWN (before SHUTDOWN) and be immediately
  // overwritten by the listener. The listener is simpler and correct.

  // Write initial state immediately
  writeStateNow();
}

/**
 * Reset runtime state writer. For testing only.
 */
export function _resetRuntimeStateForTesting(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _projectRoot = null;
  _sdkVersion = "unknown";
  _lastScenario = undefined;
  _started = false;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function debouncedWrite(): void {
  if (_debounceTimer) return; // Already scheduled

  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    writeStateNow();
  }, 1000);

  // unref so the timer doesn't prevent process exit
  if (typeof _debounceTimer === "object" && "unref" in _debounceTimer) {
    _debounceTimer.unref();
  }
}

function writeStateNow(): void {
  if (!_projectRoot) return;

  try {
    const state = getSdkState();
    const runtimeState: RuntimeState = {
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      sdkVersion: _sdkVersion,
      core: { state: state.core },
      auth: { state: state.auth },
      otel: { state: state.otel, scenario: _lastScenario },
    };

    const dir = join(_projectRoot, ".glasstrace");
    const filePath = join(dir, "runtime-state.json");

    // Ensure directory exists (may not if uninit deleted it)
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Atomic write per SDK 2.0 §4.3: tmp + fsync(tmp) + rename +
    // fsync(parent). The sync variant is used because this writer
    // runs from a signal handler that cannot await.
    atomicWriteFileSync(filePath, JSON.stringify(runtimeState, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    // Fire-and-forget — never block state transitions for a file write failure
    sdkLog(
      "warn",
      `[glasstrace] Failed to write runtime state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
