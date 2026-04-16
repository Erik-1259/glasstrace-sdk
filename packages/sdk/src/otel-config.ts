import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { setOtelState, OtelState } from "./lifecycle.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let _resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let _activeExporter: GlasstraceExporter | null = null;

/** Registered shutdown handler, tracked so it can be removed on reset. */
let _shutdownHandler: ((signal: NodeJS.Signals) => void) | null = null;

/** Registered beforeExit handler for coexistence mode, tracked for cleanup. */
let _beforeExitHandler: (() => void) | null = null;

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
  if (_shutdownHandler && typeof process !== "undefined") {
    process.removeListener("SIGTERM", _shutdownHandler);
    process.removeListener("SIGINT", _shutdownHandler);
    _shutdownHandler = null;
  }
  if (_beforeExitHandler && typeof process !== "undefined") {
    process.removeListener("beforeExit", _beforeExitHandler);
    _beforeExitHandler = null;
  }
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
 * Registers process shutdown hooks that flush and shut down the OTel provider.
 * Uses `process.once()` to avoid stacking handlers on repeated calls.
 * Guarded for non-Node environments where `process` may not exist.
 */
function registerShutdownHooks(provider: { shutdown: () => Promise<void> }): void {
  if (typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }

  // Remove any previously registered handler before adding a new one
  if (_shutdownHandler) {
    process.removeListener("SIGTERM", _shutdownHandler);
    process.removeListener("SIGINT", _shutdownHandler);
  }

  let shutdownCalled = false;

  const shutdown = (signal: string) => {
    if (shutdownCalled) return;
    shutdownCalled = true;

    void provider.shutdown()
      .catch((err: unknown) => {
        console.warn(
          `[glasstrace] Error during OTel shutdown: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        // Re-raise the signal so Node's default termination behavior proceeds.
        // Remove our listeners first to avoid re-entering this handler.
        process.removeListener("SIGTERM", _shutdownHandler!);
        process.removeListener("SIGINT", _shutdownHandler!);
        process.kill(process.pid, signal);
      });
  };

  const handler = (signal: NodeJS.Signals) => shutdown(signal);
  _shutdownHandler = handler;
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

/**
 * Attempts to inject a BatchSpanProcessor into an existing provider's
 * processor pipeline. Uses a tiered approach:
 *   1. Feature-detect `addSpanProcessor` (OTel v1 public API)
 *   2. Feature-detect `_activeSpanProcessor._spanProcessors` (OTel v2 internal)
 *
 * Returns true if the processor was successfully added, false otherwise.
 * Fully defensive — any error returns false.
 */
function tryInjectProcessor(
  tracerProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
  glasstraceExporter: GlasstraceExporter,
): boolean {
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
          return true; // Already present — skip injection
        }
      }

      const processor = new BatchSpanProcessor(glasstraceExporter, {
        scheduledDelayMillis: 1000,
      });
      withAdd.addSpanProcessor(processor);
      _injectedProcessor = processor;
      return true;
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
      return false;
    }

    const processor = new BatchSpanProcessor(glasstraceExporter, {
      scheduledDelayMillis: 1000,
    });
    multiProcessor._spanProcessors.push(processor);
    _injectedProcessor = processor;
    return true;
  } catch {
    return false;
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
 * Registers a `beforeExit` handler that flushes the injected
 * BatchSpanProcessor (which in turn flushes the GlasstraceExporter).
 *
 * In coexistence mode, the existing provider owns shutdown hooks (SIGTERM,
 * SIGINT). This handler fires when the event loop drains, giving us a
 * chance to flush buffered spans without interfering with signal-based
 * shutdown from the other tool.
 *
 * Flushes the BSP (not just the exporter) because spans are queued in
 * the BSP before reaching the exporter. If the host provider doesn't call
 * shutdown on exit, those queued spans would otherwise be lost.
 */
function registerCoexistenceFlushOnExit(): void {
  if (typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }

  // Remove any previously registered handler
  if (_beforeExitHandler) {
    process.removeListener("beforeExit", _beforeExitHandler);
  }

  const handler = () => {
    if (_injectedProcessor) {
      void _injectedProcessor.forceFlush().catch((err: unknown) => {
        console.warn(
          `[glasstrace] Error flushing processor on exit: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };

  _beforeExitHandler = handler;
  process.once("beforeExit", handler);
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
      return;
    }

    // Attempt to inject our processor (Scenarios D1, B-auto/D2)
    const injected = tryInjectProcessor(existingProvider, glasstraceExporter);

    if (injected) {
      if (config.verbose) {
        sdkLog("info", "[glasstrace] Existing provider detected — auto-attaching Glasstrace processor.");
      }
      // Register beforeExit handler to flush the injected processor.
      // Do NOT register SIGTERM/SIGINT — existing provider owns those.
      registerCoexistenceFlushOnExit();
      setOtelState(OtelState.AUTO_ATTACHED);
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
  registerShutdownHooks(provider);
  setOtelState(OtelState.OWNS_PROVIDER);
}
