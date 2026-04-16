declare const __SDK_VERSION__: string;

import type { GlasstraceOptions, AnonApiKey } from "@glasstrace/protocol";
import { resolveConfig, isProductionDisabled, isAnonymousMode } from "./env-detection.js";
import type { ResolvedConfig } from "./env-detection.js";
import { SessionManager } from "./session.js";
import { getOrCreateAnonKey, readAnonKey } from "./anon-key.js";
import { loadCachedConfig, performInit, _setCurrentConfig, getActiveConfig, getLinkedAccountId, getClaimResult, didLastInitSucceed } from "./init-client.js";
import { createDiscoveryHandler } from "./discovery-endpoint.js";
import { configureOtel, setResolvedApiKey, getResolvedApiKey, notifyApiKeyResolved, resetOtelConfigForTesting } from "./otel-config.js";
import { installContextManager } from "./context-manager.js";
import * as otelApi from "@opentelemetry/api";
import { installConsoleCapture, uninstallConsoleCapture, sdkLog } from "./console-capture.js";
import { collectHealthReport, _resetHealthForTesting } from "./health-collector.js";
import { startHeartbeat, _resetHeartbeatForTesting } from "./heartbeat.js";
import { initLifecycle, setCoreState, CoreState, getCoreState, initAuthState, AuthState, setAuthState, emitLifecycleEvent, resetLifecycleForTesting } from "./lifecycle.js";
import { startRuntimeStateWriter, _resetRuntimeStateForTesting } from "./runtime-state.js";

/** Mask an API key for safe event emission — shows prefix + last 4 chars. */
function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "...";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

/** Whether console capture has been installed in this registration cycle. */
let consoleCaptureInstalled = false;

/** Module-level state tracking for the registered discovery handler. */
let discoveryHandler: ((request: Request) => Promise<Response | null>) | null = null;

/** Generation counter to invalidate stale background promises after reset. */
let registrationGeneration = 0;

/**
 * The primary SDK entry point called by developers in their `instrumentation.ts`.
 * Orchestrates OTel setup, span processor, init client, anon key, and discovery endpoint.
 *
 * This function is synchronous and MUST NOT throw. The developer's server is never blocked.
 * Background work (key resolution, init call) happens via fire-and-forget promises.
 *
 * @param options - Optional SDK configuration. Environment variables are used as fallbacks.
 *
 * @example
 * ```ts
 * // instrumentation.ts
 * import { registerGlasstrace } from "@glasstrace/sdk";
 * registerGlasstrace(); // uses env vars
 * ```
 */
export function registerGlasstrace(options?: GlasstraceOptions): void {
  try {
    // Prevent double registration (lifecycle state check replaces isRegistered flag)
    if (getCoreState() !== CoreState.IDLE) {
      return;
    }

    // Initialize lifecycle state machine before any state transitions.
    initLifecycle({ logger: sdkLog });

    // Guard: SDK requires Node.js runtime. Some environments (e.g. Bun,
    // Deno with partial Node compat) resolve node: imports but lack full
    // Node.js APIs. This guard prevents cryptic failures deeper in the
    // SDK by detecting these environments early and returning a no-op.
    //
    // Note: environments that cannot resolve node: imports at all (pure
    // Edge Runtime, Cloudflare Workers) will fail at module evaluation
    // before this guard runs. Those cases are mitigated by the package's
    // `sideEffects: false` flag and bundler externalization of node: modules.
    if (typeof process === "undefined" || typeof process.versions?.node !== "string") {
      console.warn(
        "[glasstrace] SDK requires a Node.js runtime. " +
        "Edge Runtime, browser, and Deno without Node compat are not supported. " +
        "Glasstrace is disabled in this environment.",
      );
      return;
    }

    setCoreState(CoreState.REGISTERING);

    // Start runtime state writer — writes lifecycle state to
    // .glasstrace/runtime-state.json for CLI status reporting (SDK-026).
    // Must be after initLifecycle() and Node.js guard.
    startRuntimeStateWriter({
      projectRoot: process.cwd(),
      sdkVersion: __SDK_VERSION__,
    });

    // Resolve config
    const config = resolveConfig(options);
    if (config.verbose) {
      console.info("[glasstrace] Config resolved.");
    }

    // Production check
    if (isProductionDisabled(config)) {
      setCoreState(CoreState.PRODUCTION_DISABLED);
      console.warn(
        "[glasstrace] Disabled in production. Set GLASSTRACE_FORCE_ENABLE=true to override.",
      );
      return;
    }
    if (config.verbose) {
      console.info("[glasstrace] Not production-disabled.");
    }

    // Determine auth mode
    const anonymous = isAnonymousMode(config);
    let effectiveKey: string | undefined = config.apiKey;

    // Set initial auth lifecycle state based on configuration
    initAuthState(anonymous ? AuthState.ANONYMOUS : AuthState.AUTHENTICATED);

    if (effectiveKey) {
      setResolvedApiKey(effectiveKey);
      emitLifecycleEvent("auth:key_resolved", {
        key: maskKey(effectiveKey),
        mode: anonymous ? "anonymous" : "dev",
      });
    }

    if (config.verbose) {
      console.info(
        `[glasstrace] Auth mode = ${anonymous ? "anonymous" : "dev-key"}.`,
      );
    }

    // Load cached config and apply to in-memory store
    const cachedInitResponse = loadCachedConfig();
    if (cachedInitResponse) {
      _setCurrentConfig(cachedInitResponse);
    }
    if (config.verbose) {
      console.info(
        `[glasstrace] Cached config ${cachedInitResponse ? "loaded and applied" : "not found"}.`,
      );
    }

    // Create SessionManager
    const sessionManager = new SessionManager();
    if (config.verbose) {
      console.info("[glasstrace] SessionManager created.");
    }

    setCoreState(CoreState.KEY_PENDING);
    const currentGeneration = registrationGeneration;

    // Check for an existing OTel provider BEFORE installing the context
    // manager. If another tracing tool (Datadog, Sentry, New Relic) has
    // already registered a provider, the SDK must NOT claim the global
    // context manager slot — doing so would break the other tool's
    // context propagation. The ProxyTracer check is synchronous.
    const existingProbe = otelApi.trace.getTracerProvider().getTracer("glasstrace-probe");
    const anotherProviderRegistered = existingProbe.constructor.name !== "ProxyTracer";

    if (anotherProviderRegistered) {
      if (config.verbose) {
        console.info("[glasstrace] Another OTel provider detected — using existing context manager.");
      }
    } else {
      // Register the context manager SYNCHRONOUSLY before any spans are
      // created. Without this, each span starts a new root trace with a
      // fresh traceId because there's no parent context to inherit from.
      // Must happen before configureOtel (which is async) — Next.js may
      // create spans between registerGlasstrace() returning and
      // configureOtel() completing (DISC-1183).
      const contextManagerInstalled = installContextManager();
      if (config.verbose) {
        console.info(
          contextManagerInstalled
            ? "[glasstrace] Context manager installed."
            : "[glasstrace] Context manager not available — trace context propagation disabled.",
        );
      }
    }

    // Configure OTel IMMEDIATELY in all modes.
    // OTel is registered before the anon key resolves so that
    // spans are captured from cold start. GlasstraceExporter buffers spans
    // while the key is "pending" and flushes them once notifyApiKeyResolved()
    // is called after anonymous key resolution.
    // This is fire-and-forget -- OTel failure must not block init.
    void configureOtel(config, sessionManager).then(
      () => {
        // Check cached config for consoleErrors (may be stale or absent).
        // Re-checked after performInit completes with the authoritative config.
        maybeInstallConsoleCapture();

        if (config.verbose) {
          console.info("[glasstrace] OTel configured.");
        }
      },
      (err: unknown) => {
        console.warn(
          `[glasstrace] Failed to configure OTel: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );

    // Background work: anonymous key resolution, discovery endpoint, init
    if (anonymous) {
      // Register discovery endpoint IMMEDIATELY with async key resolution
      if (isDiscoveryEnabled(config)) {
        let resolvedAnonKey: AnonApiKey | null = null;
        const anonKeyPromise = getOrCreateAnonKey();

        // Derive claim state from the init response.
        // Called on every discovery request so it reflects the latest state.
        // Two sources indicate a claimed account:
        //   1. linkedAccountId — key was already linked to an account
        //   2. claimResult — a claim just completed during this init call
        const getClaimState = () => {
          if (getLinkedAccountId()) return { claimed: true as const };
          if (getClaimResult()) return { claimed: true as const };
          return null;
        };

        // Use getResolvedApiKey() for session ID instead of
        // capturing the mutable effectiveKey closure variable.
        discoveryHandler = createDiscoveryHandler(
          async () => resolvedAnonKey,
          () => sessionManager.getSessionId(getResolvedApiKey()),
          getClaimState,
        );

        if (config.verbose) {
          console.info("[glasstrace] Discovery endpoint registered (key pending).");
        }

        // Background: resolve key, update API key, then init
        void (async () => {
          try {
            if (currentGeneration !== registrationGeneration) return;

            const anonKey = await anonKeyPromise;
            resolvedAnonKey = anonKey;
            setResolvedApiKey(anonKey);
            notifyApiKeyResolved();
            emitLifecycleEvent("auth:key_resolved", { key: maskKey(anonKey), mode: "anonymous" });
            effectiveKey = anonKey;

            if (currentGeneration !== registrationGeneration) return;

            // Update the discovery handler to serve the resolved key
            // Use getResolvedApiKey() for canonical key state
            discoveryHandler = createDiscoveryHandler(
              () => Promise.resolve(anonKey),
              () => sessionManager.getSessionId(getResolvedApiKey()),
              getClaimState,
            );

            await backgroundInit(config, anonKey, currentGeneration);
          } catch (err) {
            console.warn(
              `[glasstrace] Background init failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      } else {
        // Anonymous + non-dev: no discovery endpoint, just background init
        void (async () => {
          try {
            if (currentGeneration !== registrationGeneration) return;

            const anonKey = await getOrCreateAnonKey();
            setResolvedApiKey(anonKey);
            notifyApiKeyResolved();
            emitLifecycleEvent("auth:key_resolved", { key: maskKey(anonKey), mode: "anonymous" });
            effectiveKey = anonKey;

            if (currentGeneration !== registrationGeneration) return;

            await backgroundInit(config, anonKey, currentGeneration);
          } catch (err) {
            console.warn(
              `[glasstrace] Background init failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })();
      }
    } else {
      // Dev key mode: read straggler anon key, then fire init
      void (async () => {
        try {
          if (currentGeneration !== registrationGeneration) return;

          let anonKeyForInit: AnonApiKey | null = null;
          try {
            anonKeyForInit = await readAnonKey();
          } catch {
            // Expected when no prior anon key file exists on disk (first run).
          }

          if (currentGeneration !== registrationGeneration) return;

          await backgroundInit(config, anonKeyForInit, currentGeneration);
        } catch (err) {
          console.warn(
            `[glasstrace] Background init failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }

    // Import graph (coverageMapEnabled) -- placeholder
    if (config.coverageMapEnabled && config.verbose) {
      console.info("[glasstrace] Import graph building skipped.");
    }
  } catch (err) {
    setCoreState(CoreState.REGISTRATION_FAILED);
    console.warn(
      `[glasstrace] Registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Shared background init logic for all auth modes.
 *
 * Fires the init request, handles account claim transitions (updating
 * the exporter key), and re-checks console capture config. The anonymous
 * paths pass the anon key as `anonKeyForInit`; the dev-key path passes
 * the straggler anon key (or null).
 */
async function backgroundInit(
  config: ResolvedConfig,
  anonKeyForInit: AnonApiKey | null,
  generation: number,
): Promise<void> {
  if (config.verbose) {
    console.info("[glasstrace] Background init firing.");
  }

  const healthReport = collectHealthReport(__SDK_VERSION__);
  const initResult = await performInit(config, anonKeyForInit, __SDK_VERSION__, healthReport);

  if (generation !== registrationGeneration) return;

  // Bail if shutdown was initiated while backgroundInit was in flight.
  const currentState = getCoreState();
  if (currentState === CoreState.SHUTTING_DOWN || currentState === CoreState.SHUTDOWN) {
    return;
  }

  // Advance core lifecycle: KEY_PENDING → KEY_RESOLVED → ACTIVE/ACTIVE_DEGRADED.
  // In the full lifecycle (SDK-024), KEY_RESOLVED is triggered by auth:key_resolved.
  // For now, drive both transitions here since the auth layer isn't wired yet.
  if (currentState === CoreState.KEY_PENDING) {
    setCoreState(CoreState.KEY_RESOLVED);
  }
  if (getCoreState() === CoreState.KEY_RESOLVED) {
    setCoreState(didLastInitSucceed() ? CoreState.ACTIVE : CoreState.ACTIVE_DEGRADED);
  }

  // If the backend reported an account claim, update the exporter
  // key so subsequent span exports authenticate with the dev key.
  if (initResult?.claimResult) {
    const { newApiKey, accountId } = initResult.claimResult;
    setAuthState(AuthState.CLAIMING);
    emitLifecycleEvent("auth:claim_started", { accountId });
    setResolvedApiKey(newApiKey);
    notifyApiKeyResolved();
    setAuthState(AuthState.CLAIMED);
    emitLifecycleEvent("auth:claim_completed", { newKey: maskKey(newApiKey), accountId });
  }

  // Re-check consoleErrors with the authoritative init response config
  maybeInstallConsoleCapture();

  // Start the periodic health heartbeat if init succeeded.
  // The heartbeat re-calls performInit every 5 minutes to report health
  // metrics and refresh config. Only starts after first successful init.
  if (didLastInitSucceed()) {
    startHeartbeat(config, anonKeyForInit, __SDK_VERSION__, generation, (newApiKey, accountId) => {
      setAuthState(AuthState.CLAIMING);
      emitLifecycleEvent("auth:claim_started", { accountId });
      setResolvedApiKey(newApiKey);
      notifyApiKeyResolved();
      setAuthState(AuthState.CLAIMED);
      emitLifecycleEvent("auth:claim_completed", { newKey: maskKey(newApiKey), accountId });
    });
  }
}

/**
 * Returns the registered discovery handler, or null if not registered.
 */
export function getDiscoveryHandler(): ((request: Request) => Promise<Response | null>) | null {
  return discoveryHandler;
}

/**
 * Checks the active config and installs console capture if enabled.
 * Idempotent — safe to call multiple times (after OTel config, after init).
 * This ensures console capture is installed whenever authoritative config
 * becomes available, whether from the file cache or the init response.
 */
function maybeInstallConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  if (getActiveConfig().consoleErrors) {
    consoleCaptureInstalled = true;
    void installConsoleCapture();
  }
}

/**
 * Returns `true` if the discovery endpoint should be enabled for this environment.
 *
 * Tightened from "not production" to explicit development conditions:
 * 1. `GLASSTRACE_DISCOVERY_ENABLED=true` -- explicit override (highest priority)
 * 2. `GLASSTRACE_DISCOVERY_ENABLED=false` -- explicit disable (highest priority)
 * 3. `NODE_ENV` is `"development"` or unset, AND `VERCEL_ENV` is not `"production"`
 *
 * Environments like `staging`, `test`, and `ci` do not expose the discovery
 * endpoint by default, since it serves the anonymous API key over CORS.
 *
 * @param config - The resolved SDK configuration.
 * @returns Whether the discovery endpoint should be registered.
 */
function isDiscoveryEnabled(config: ResolvedConfig): boolean {
  // Explicit flag takes precedence
  if (process.env.GLASSTRACE_DISCOVERY_ENABLED === "true") return true;
  if (process.env.GLASSTRACE_DISCOVERY_ENABLED === "false") return false;

  // Block production environments
  if (config.nodeEnv === "production") return false;
  if (config.vercelEnv === "production") return false;

  // Only allow in development or when NODE_ENV is unset
  if (config.nodeEnv === "development" || config.nodeEnv === undefined) return true;

  return false;
}

/**
 * Resets registration state. For testing only.
 */
export function _resetRegistrationForTesting(): void {
  discoveryHandler = null;
  consoleCaptureInstalled = false;
  registrationGeneration++;
  _resetHealthForTesting();
  _resetHeartbeatForTesting();
  uninstallConsoleCapture();
  resetOtelConfigForTesting();
  _resetRuntimeStateForTesting();
  resetLifecycleForTesting();
}
