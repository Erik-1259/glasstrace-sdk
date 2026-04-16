import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { setOtelState, OtelState, getCoreState, CoreState, setCoreState, emitLifecycleEvent, registerShutdownHook, registerSignalHandlers, registerBeforeExitTrigger } from "./lifecycle.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let _resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let _activeExporter: GlasstraceExporter | null = null;

/** Injected BatchSpanProcessor in coexistence mode, tracked for flush on exit. */
let _injectedProcessor: BatchSpanProcessor | null = null;

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
}

/**
 * Resets OTel configuration state to initial values. For testing only.
 */
export function resetOtelConfigForTesting(): void {
  _resolvedApiKey = API_KEY_PENDING;
  _activeExporter = null;
  _injectedProcessor = null;
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
 * Attempts to inject a BatchSpanProcessor into an existing provider's
 * processor pipeline. Uses a tiered approach:
 *   1. Feature-detect `addSpanProcessor` (OTel v1 public API)
 *   2. Feature-detect `_activeSpanProcessor._spanProcessors` (OTel v2 internal)
 *
 * Returns the method used ("v1_public" | "v2_private"), "already_present" if
 * the branded processor was found, or null if injection failed.
 * Fully defensive — any error returns null.
 */
function tryInjectProcessor(
  tracerProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
  glasstraceExporter: GlasstraceExporter,
): "v1_public" | "v2_private" | "already_present" | null {
  try {
    // Unwrap the ProxyTracerProvider to get the delegate.
    const proxy = tracerProvider as unknown as { getDelegate?: () => unknown };
    const delegate = typeof proxy.getDelegate === "function"
      ? proxy.getDelegate()
      : tracerProvider;

    // Attempt 1: OTel v1 public API (addSpanProcessor)
    const withAdd = delegate as unknown as {
      addSpanProcessor?: (p: unknown) => void;
      getActiveSpanProcessor?: () => { _spanProcessors?: Array<{ _exporter?: unknown }> };
    };
    if (typeof withAdd.addSpanProcessor === "function") {
      // Guard against duplicate injection: v1 providers expose
      // getActiveSpanProcessor() which may let us check for an existing
      // Glasstrace processor before adding another.
      if (typeof withAdd.getActiveSpanProcessor === "function") {
        const active = withAdd.getActiveSpanProcessor();
        const brand = Symbol.for("glasstrace.exporter");
        const processors = active?._spanProcessors;
        if (Array.isArray(processors) && processors.some((p) => {
          const exp = p._exporter as Record<symbol, unknown> | undefined;
          return exp?.[brand] === true;
        })) {
          return "already_present"; // Skip injection — branded processor found
        }
      }

      const processor = new BatchSpanProcessor(glasstraceExporter, {
        scheduledDelayMillis: 1000,
      });
      withAdd.addSpanProcessor(processor);
      _injectedProcessor = processor;
      return "v1_public";
    }

    // Attempt 2: OTel v2 internals (_activeSpanProcessor._spanProcessors)
    // This accesses a private field — justified in the design doc
    // (sdk-otel-coexistence.md Section 4). Same pattern Sentry uses.
    const provider = delegate as unknown as {
      _activeSpanProcessor?: {
        _spanProcessors?: unknown[];
      };
    };
    const multiProcessor = provider._activeSpanProcessor;
    if (!multiProcessor || !Array.isArray(multiProcessor._spanProcessors)) {
      return null;
    }

    const processor = new BatchSpanProcessor(glasstraceExporter, {
      scheduledDelayMillis: 1000,
    });
    multiProcessor._spanProcessors.push(processor);
    _injectedProcessor = processor;
    return "v2_private";
  } catch {
    return null;
  }
}

/**
 * Checks if a Glasstrace processor is already present in the existing
 * provider's processor list. Uses the branded Symbol to detect our exporter
 * across bundled copies.
 */
function isGlasstraceProcessorPresent(
  tracerProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
): boolean {
  try {
    const proxy = tracerProvider as unknown as { getDelegate?: () => unknown };
    const delegate = typeof proxy.getDelegate === "function"
      ? proxy.getDelegate()
      : tracerProvider;

    const provider = delegate as unknown as {
      _activeSpanProcessor?: {
        _spanProcessors?: Array<{ _exporter?: unknown }>;
      };
    };
    const processors = provider._activeSpanProcessor?._spanProcessors;
    if (!Array.isArray(processors)) {
      return false;
    }

    const brand = Symbol.for("glasstrace.exporter");
    return processors.some((p) => {
      const exporter = p._exporter as Record<symbol, unknown> | undefined;
      return exporter?.[brand] === true;
    });
  } catch {
    return false;
  }
}


/**
 * Configures OpenTelemetry with the GlasstraceExporter.
 *
 * Detection flow (per sdk-otel-coexistence.md v8):
 *   1. Yield one tick (let synchronous Sentry.init() complete)
 *   2. Probe for existing provider
 *   3. If provider exists → shared coexistence path
 *   4. If no provider → registration path (Vercel or bare)
 */
export async function configureOtel(
  config: ResolvedConfig,
  sessionManager: SessionManager,
): Promise<void> {
  setOtelState(OtelState.CONFIGURING);

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

  // Step 3: If another provider exists → shared coexistence path
  if (anotherProviderRegistered) {
    // Check if our processor is already present (Scenario B-clean)
    if (isGlasstraceProcessorPresent(existingProvider)) {
      if (config.verbose) {
        sdkLog("info", "[glasstrace] Existing provider detected — Glasstrace processor already present.");
      }
      // The newly created exporter is unused — the existing one handles spans.
      _activeExporter = null;
      setOtelState(OtelState.PROCESSOR_PRESENT);
      emitLifecycleEvent("otel:configured", { state: OtelState.PROCESSOR_PRESENT, scenario: "B-clean" });
      return;
    }

    // Attempt to inject our processor (Scenarios D1, B-auto/D2)
    const injectionMethod = tryInjectProcessor(existingProvider, glasstraceExporter);

    if (injectionMethod === "already_present") {
      // Found via v1 getActiveSpanProcessor — same as B-clean
      if (config.verbose) {
        sdkLog("info", "[glasstrace] Existing provider detected — Glasstrace processor already present (v1 check).");
      }
      _activeExporter = null;
      setOtelState(OtelState.PROCESSOR_PRESENT);
      emitLifecycleEvent("otel:configured", { state: OtelState.PROCESSOR_PRESENT, scenario: "B-clean" });
      return;
    }

    if (injectionMethod) {
      if (config.verbose) {
        sdkLog("info", "[glasstrace] Existing provider detected — auto-attaching Glasstrace processor.");
      }
      // Register coexistence flush hook via the lifecycle coordinator, and
      // wire the beforeExit trigger so the coordinator runs on event loop drain.
      // The existing provider handles signal-based shutdown (its MultiSpanProcessor
      // propagates shutdown() to our injected BSP). The beforeExit trigger covers
      // the edge case where the process exits without signals.
      // Both triggers (signals and beforeExit) call executeShutdown() which is
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
      const scenario = injectionMethod === "v1_public" ? "D1" : "B-auto";
      setOtelState(OtelState.AUTO_ATTACHED);
      emitLifecycleEvent("otel:configured", { state: OtelState.AUTO_ATTACHED, scenario });
      emitLifecycleEvent("otel:injection_succeeded", { method: injectionMethod });
      return;
    }

    // Injection failed (Scenario C/F) — emit guidance
    if (config.verbose) {
      sdkLog("info", "[glasstrace] Existing provider detected — could not auto-attach.");
    }
    console.warn(
      "[glasstrace] An existing OpenTelemetry TracerProvider is registered but Glasstrace " +
      "could not auto-attach its span processor. To use Glasstrace alongside another " +
      "tracing tool, add a Glasstrace span processor to your provider configuration.",
    );
    _activeExporter = null;
    setOtelState(OtelState.COEXISTENCE_FAILED);
    emitLifecycleEvent("otel:configured", { state: OtelState.COEXISTENCE_FAILED, scenario: "C/F" });
    emitLifecycleEvent("otel:injection_failed", { reason: "provider internals inaccessible" });
    // Cross-layer effect: trigger ACTIVE_DEGRADED if core state permits it
    // (per DISC-1247, KEY_PENDING → ACTIVE_DEGRADED is not valid, so we guard)
    const coreState = getCoreState();
    if (coreState === CoreState.ACTIVE || coreState === CoreState.KEY_RESOLVED) {
      setCoreState(CoreState.ACTIVE_DEGRADED);
    }
    return;
  }

  // Step 4: No existing provider → registration path

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

  // Register OTel shutdown via lifecycle coordinator instead of direct signal handlers.
  // Also register signal handlers since the SDK owns this provider (Scenario A).
  // In coexistence mode, the existing provider owns signals — we don't register there.
  registerShutdownHook({
    name: "otel-provider-shutdown",
    priority: 0,
    fn: async () => {
      await provider.shutdown();
    },
  });
  registerSignalHandlers();
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
