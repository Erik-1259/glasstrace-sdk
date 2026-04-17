import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { setOtelState, OtelState, getCoreState, CoreState, setCoreState, emitLifecycleEvent, registerShutdownHook, registerBeforeExitTrigger } from "./lifecycle.js";
import {
  emitNudgeMessage,
  emitGuidanceMessage,
  tryAutoAttachGlasstraceProcessor,
} from "./coexistence.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let _resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let _activeExporter: GlasstraceExporter | null = null;

/** Additional exporters that need key-resolution notification (from createGlasstraceSpanProcessor). */
const _additionalExporters: GlasstraceExporter[] = [];

/** Injected processor in coexistence mode, tracked for flush on exit. */
let _injectedProcessor: SpanProcessor | null = null;

/**
 * Sets the resolved API key for OTel export authentication.
 * Called once the anonymous key or dev key is available.
 * @param key - The resolved API key (anonymous or developer).
 */
export function setResolvedApiKey(key: string): void {
  _resolvedApiKey = key;
}

/**
 * Returns the current resolved API key.
 * Returns the {@link API_KEY_PENDING} sentinel if the key has not yet resolved.
 */
export function getResolvedApiKey(): string {
  return _resolvedApiKey;
}

/**
 * Notifies the active exporter that the API key has transitioned from
 * "pending" to a resolved value. This triggers flushing of any buffered spans.
 */
export function notifyApiKeyResolved(): void {
  _activeExporter?.notifyKeyResolved();
  for (const exporter of _additionalExporters) {
    exporter.notifyKeyResolved();
  }
}

/**
 * Register an additional exporter for key-resolution notification.
 * Used by createGlasstraceSpanProcessor() so its exporter gets notified
 * when the API key resolves (flushing buffered spans immediately rather
 * than waiting for the next BSP timer tick).
 */
export function registerExporterForKeyNotification(exporter: GlasstraceExporter): void {
  _additionalExporters.push(exporter);
}

/**
 * Resets OTel configuration state to initial values. For testing only.
 */
export function resetOtelConfigForTesting(): void {
  _resolvedApiKey = API_KEY_PENDING;
  _activeExporter = null;
  _injectedProcessor = null;
  _additionalExporters.length = 0;
  // Signal and beforeExit handler cleanup is handled by resetLifecycleForTesting()
  // via the shutdown coordinator.
}

/**
 * Dynamically imports an optional peer dependency at runtime.
 *
 * Uses `Function()` constructor to build the `import()` expression so that
 * bundlers (webpack, esbuild, turbopack) do not attempt to resolve the module
 * at compile time. This is intentional -- the SDK's peer dependencies are
 * optional, and static analysis would cause missing-module build errors for
 * users who have not installed them.
 *
 * **CSP note:** The `Function()` constructor is semantically equivalent to
 * `eval()` and will trigger Content Security Policy violations in environments
 * that disallow `unsafe-eval`. If your CSP blocks this, install the OTel peer
 * dependencies explicitly so they resolve via normal `import` statements, or
 * use the `@vercel/otel` path which does not rely on `tryImport` for its own
 * module.
 *
 * @param moduleId - The npm package name to import (e.g. "@vercel/otel").
 * @returns The module namespace object, or `null` if the module is not installed.
 */
async function tryImport(moduleId: string): Promise<Record<string, unknown> | null> {
  try {
    return await (Function("id", "return import(id)")(moduleId) as Promise<Record<string, unknown>>);
  } catch {
    return null;
  }
}

/**
 * Configures OpenTelemetry with the GlasstraceExporter.
 *
 * Detection flow (per sdk-otel-coexistence.md v8+):
 *   1. Yield one tick (let synchronous Sentry.init() complete)
 *   2. Probe for existing provider
 *   3. If provider exists → shared coexistence path via
 *      {@link tryAutoAttachGlasstraceProcessor} (resolves DISC-493 Issues 2
 *      and 4 — Next.js 16 production pre-registration and Sentry hoisting)
 *   4. If no provider → registration path (Vercel or bare)
 */
export async function configureOtel(
  config: ResolvedConfig,
  sessionManager: SessionManager,
): Promise<void> {
  setOtelState(OtelState.CONFIGURING);

  // Step 1: Yield one tick to let synchronous Sentry.init() (or other tools)
  // complete before probing for an existing provider (DISC-1202).
  await new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });

  // Step 2: Probe for an existing OTel provider BEFORE the Vercel/bare split.
  // This unified detection ensures coexistence works regardless of whether
  // @vercel/otel is installed (sdk-otel-coexistence.md Section 2.4).
  const existingProvider = otelApi.trace.getTracerProvider();
  const probeTracer = existingProvider.getTracer("glasstrace-probe");
  const anotherProviderRegistered = probeTracer.constructor.name !== "ProxyTracer";

  // Step 3: If another provider exists → shared coexistence path.
  // This is the DISC-493 Issues 2 and 4 fix: instead of silently giving up
  // when a Next.js 16 production build or a Sentry import has already
  // registered a provider, auto-attach our span processor onto it.
  if (anotherProviderRegistered) {
    await runCoexistencePath(existingProvider, config);
    return;
  }

  // Step 4: No existing provider → registration path.
  await runRegistrationPath(config, sessionManager);
}

/**
 * Shared coexistence path for DISC-493 Issues 2 and 4.
 *
 * Used whenever `configureOtel()` detects a pre-registered OTel provider.
 * Delegates processor construction to {@link tryAutoAttachGlasstraceProcessor}
 * which reuses the `createGlasstraceSpanProcessor()` public primitive, so
 * the auto-attach path and the manual integration path stay in lockstep.
 *
 * Idempotence: if a Glasstrace-branded processor is already attached (from
 * a prior `registerGlasstrace()` call or a manual `createGlasstraceSpanProcessor()`
 * wiring), the auto-attach path returns `"already_present"` and no second
 * processor is created.
 */
async function runCoexistencePath(
  existingProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
  config: ResolvedConfig,
): Promise<void> {
  // Attempt to auto-attach via the shared primitive.
  //
  // tryAutoAttachGlasstraceProcessor() performs its own "already present"
  // check against the branded Symbol BEFORE constructing an exporter, so
  // idempotent registration does not create a wasted exporter instance.
  // It also reuses createGlasstraceSpanProcessor() for construction, so
  // the processor wiring (branded exporter, key-notification registration,
  // BSP flush interval) matches the documented manual path exactly.
  //
  // Pass through the subset of resolved config that `GlasstraceOptions`
  // accepts. `environment` is not in `GlasstraceOptions` (it's derived
  // from env vars inside `resolveConfig`), so the primitive picks it up
  // from the same environment variables `configureOtel()` sees.
  const result = tryAutoAttachGlasstraceProcessor(existingProvider, {
    endpoint: config.endpoint,
    verbose: config.verbose,
  });

  if (result === "already_present") {
    if (config.verbose) {
      sdkLog("info", "[glasstrace] Existing provider detected — Glasstrace processor already present.");
    }
    setOtelState(OtelState.PROCESSOR_PRESENT);
    emitLifecycleEvent("otel:configured", { state: OtelState.PROCESSOR_PRESENT, scenario: "B-clean" });
    return;
  }

  if (result !== null) {
    // Success: processor was attached. Retain a reference for the
    // coexistence flush hook (Section 7.2) so beforeExit drains buffered
    // spans even if the existing provider's shutdown does not propagate.
    _injectedProcessor = result.processor;

    if (config.verbose) {
      sdkLog(
        "info",
        "[glasstrace] Existing provider detected — auto-attached Glasstrace span processor.",
      );
    }

    // Register coexistence flush hook via the lifecycle coordinator, and
    // wire the beforeExit trigger so the coordinator runs on event loop drain.
    // The existing provider handles signal-based shutdown (its MultiSpanProcessor
    // propagates shutdown() to our injected processor). The beforeExit trigger
    // covers the edge case where the process exits without signals. Both
    // triggers (signals and beforeExit) call executeShutdown() which is
    // idempotent — if one already ran, the other is a no-op.
    registerShutdownHook({
      name: "coexistence-flush",
      priority: 5,
      fn: async () => {
        if (_injectedProcessor) {
          await _injectedProcessor.forceFlush();
        }
      },
    });
    registerBeforeExitTrigger();

    const scenario = result.method === "v1_public" ? "D1" : "B-auto";
    setOtelState(OtelState.AUTO_ATTACHED);
    emitLifecycleEvent("otel:configured", { state: OtelState.AUTO_ATTACHED, scenario });
    emitLifecycleEvent("otel:injection_succeeded", { method: result.method });
    emitNudgeMessage();
    return;
  }

  // Injection failed (Scenario C/F) — emit guidance.
  if (config.verbose) {
    sdkLog("info", "[glasstrace] Existing provider detected — could not auto-attach.");
  }
  emitGuidanceMessage();
  setOtelState(OtelState.COEXISTENCE_FAILED);
  emitLifecycleEvent("otel:configured", { state: OtelState.COEXISTENCE_FAILED, scenario: "C/F" });
  emitLifecycleEvent("otel:injection_failed", { reason: "provider internals inaccessible" });
  // Cross-layer effect: trigger ACTIVE_DEGRADED if core state permits it
  // (per DISC-1247, KEY_PENDING → ACTIVE_DEGRADED is not valid, so we guard).
  const coreState = getCoreState();
  if (coreState === CoreState.ACTIVE || coreState === CoreState.KEY_RESOLVED) {
    setCoreState(CoreState.ACTIVE_DEGRADED);
  }
}

/**
 * Registration path when no existing OTel provider is detected.
 *
 * Tries `@vercel/otel` first (Scenario E). Falls back to constructing a
 * bare `BasicTracerProvider` (Scenario A). In both sub-scenarios,
 * Glasstrace owns the provider and installs its own shutdown hooks.
 */
async function runRegistrationPath(
  config: ResolvedConfig,
  sessionManager: SessionManager,
): Promise<void> {
  // Build OTLP exporter configuration
  const exporterUrl = `${config.endpoint}/v1/traces`;

  // OTLP exporter factory — always available since OTel is bundled.
  const createOtlpExporter = (url: string, headers: Record<string, string>) =>
    new OTLPTraceExporter({ url, headers });

  // Create the GlasstraceExporter that enriches + buffers + delegates
  const glasstraceExporter = new GlasstraceExporter({
    getApiKey: getResolvedApiKey,
    sessionManager,
    getConfig: () => getActiveConfig(),
    environment: config.environment,
    endpointUrl: exporterUrl,
    createDelegate: createOtlpExporter,
    verbose: config.verbose,
  });
  _activeExporter = glasstraceExporter;

  // Try @vercel/otel first (Scenario E)
  const vercelOtel = await tryImport("@vercel/otel");
  if (vercelOtel && typeof vercelOtel.registerOTel === "function") {
    const otelConfig: Record<string, unknown> = {
      serviceName: "glasstrace-sdk",
      traceExporter: glasstraceExporter,
    };

    // Try @prisma/instrumentation
    const prismaModule = await tryImport("@prisma/instrumentation");
    if (prismaModule) {
      const PrismaInstrumentation = prismaModule.PrismaInstrumentation as
        (new () => unknown) | undefined;
      if (PrismaInstrumentation) {
        otelConfig.instrumentations = [new PrismaInstrumentation()];
      }
    }

    (vercelOtel.registerOTel as (opts: Record<string, unknown>) => void)(otelConfig);
    setOtelState(OtelState.OWNS_PROVIDER);
    emitLifecycleEvent("otel:configured", { state: OtelState.OWNS_PROVIDER, scenario: "E" });
    return;
  }

  // Bare OTel SDK fallback (Scenario A)

  // Enable OTel diagnostic logging in verbose mode so OTLP exporter
  // errors (auth failures, network issues) are surfaced to the developer.
  // Routes through sdkLog to avoid console-capture recording OTel internals.
  if (config.verbose) {
    otelApi.diag.setLogger(
      {
        verbose: (msg) => sdkLog("info", `[otel] ${msg}`),
        debug: (msg) => sdkLog("info", `[otel] ${msg}`),
        info: (msg) => sdkLog("info", `[otel] ${msg}`),
        warn: (msg) => sdkLog("warn", `[otel] ${msg}`),
        error: (msg) => sdkLog("error", `[otel] ${msg}`),
      },
      otelApi.DiagLogLevel.WARN,
    );
  }

  const processor = new BatchSpanProcessor(glasstraceExporter, {
    scheduledDelayMillis: 1000,
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  // Context manager is registered synchronously in registerGlasstrace()
  // before configureOtel() is called (DISC-1183). By this point, it's
  // already active and propagating trace context across async boundaries.

  otelApi.trace.setGlobalTracerProvider(provider);

  // Register OTel shutdown via lifecycle coordinator.
  // Signal handlers are installed upfront by registerGlasstrace() so they
  // exist during this async setup window (DISC-1249). beforeExit is still
  // wired here because Scenario A owns the provider and the coexistence
  // path registers its own beforeExit trigger independently.
  registerShutdownHook({
    name: "otel-provider-shutdown",
    priority: 0,
    fn: async () => {
      await provider.shutdown();
    },
  });
  registerBeforeExitTrigger();

  // Register Prisma instrumentation on the bare path (DISC-1223).
  // The Vercel path handles this via registerOTel({ instrumentations: [...] }).
  // The coexistence path gets Prisma from the existing provider (e.g., Sentry).
  // Only the bare path was missing it.
  const prismaModule = await tryImport("@prisma/instrumentation");
  if (prismaModule) {
    const PrismaInstrumentation = prismaModule.PrismaInstrumentation as
      (new () => unknown & { setTracerProvider: (p: unknown) => void; enable: () => void }) | undefined;
    if (PrismaInstrumentation) {
      try {
        const inst = new PrismaInstrumentation();
        inst.setTracerProvider(provider);
        inst.enable();
      } catch {
        // Prisma instrumentation is optional — failure is not fatal
      }
    }
  }

  setOtelState(OtelState.OWNS_PROVIDER);
  emitLifecycleEvent("otel:configured", { state: OtelState.OWNS_PROVIDER, scenario: "A" });
}
