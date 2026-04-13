import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";
import { sdkLog } from "./console-capture.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let _resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let _activeExporter: GlasstraceExporter | null = null;

/** Registered shutdown handler, tracked so it can be removed on reset. */
let _shutdownHandler: ((signal: NodeJS.Signals) => void) | null = null;

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
  if (_shutdownHandler && typeof process !== "undefined") {
    process.removeListener("SIGTERM", _shutdownHandler);
    process.removeListener("SIGINT", _shutdownHandler);
    _shutdownHandler = null;
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
 * Configures OpenTelemetry with the GlasstraceExporter.
 * The exporter handles all span enrichment (glasstrace.* attributes) at
 * export time, solving buffering, no-onEnding,
 * and session-ID-uses-resolved-key concerns.
 *
 * Attempts to use `@vercel/otel` first, falls back to bare OTel SDK.
 *
 * @param config - The resolved SDK configuration (endpoint, environment, etc.).
 * @param sessionManager - Provides session IDs for span enrichment.
 */
export async function configureOtel(
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
  });
  _activeExporter = glasstraceExporter;

  // Try @vercel/otel first
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
    return;
  }

  // Fallback: bare OTel SDK with BasicTracerProvider + manual context manager
  // Check for an existing OTel provider before registering.
  // If another tool (Datadog, Sentry, New Relic) already registered a provider,
  // skip Glasstrace registration to avoid silently breaking their tracing.
  // OTel wraps the global provider in a ProxyTracerProvider, so we probe for a
  // real provider by requesting a tracer and checking if it's a "ProxyTracer"
  // (the no-op default) or a real Tracer from a registered provider.
  const existingProvider = otelApi.trace.getTracerProvider();
  const probeTracer = existingProvider.getTracer("glasstrace-probe");
  if (probeTracer.constructor.name !== "ProxyTracer") {
    console.warn(
      "[glasstrace] An existing OpenTelemetry TracerProvider is already registered. " +
      "Glasstrace will not overwrite it. To use Glasstrace alongside another " +
      "tracing tool, add GlasstraceExporter as an additional span processor " +
      "on your existing provider.",
    );
    _activeExporter = null;
    return;
  }

  // Enable OTel diagnostic logging in verbose mode so OTLP exporter
  // errors (auth failures, network issues) are surfaced to the developer.
  // Set AFTER coexistence check to avoid mutating global diag state when
  // Glasstrace is not the active tracer. Routes through sdkLog to avoid
  // console-capture recording OTel internals as user span events.
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

  // Use BatchSpanProcessor for production OTLP exports to avoid blocking
  // the event loop on every span.end() call.
  const processor = new BatchSpanProcessor(glasstraceExporter, {
    scheduledDelayMillis: 1000,
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  // Register an AsyncLocalStorage-based context manager so trace context
  // propagates across async boundaries. Without this, each span starts a
  // new root trace with a fresh traceId (DISC-1183).
  // Uses Node.js built-in AsyncLocalStorage directly to avoid importing
  // @opentelemetry/context-async-hooks (which uses require("async_hooks")
  // and breaks when bundled as ESM by tsup). Dynamic import keeps
  // node:async_hooks out of the module graph for browser bundlers.
  const asyncHooks = await tryImport("node:async_hooks") as { AsyncLocalStorage: typeof import("node:async_hooks").AsyncLocalStorage } | null;
  if (!asyncHooks) {
    // Cannot set up context propagation without async_hooks (non-Node env).
    // Spans will still be captured but without parent-child relationships.
    otelApi.trace.setGlobalTracerProvider(provider);
    registerShutdownHooks(provider);
    return;
  }
  const { AsyncLocalStorage } = asyncHooks;
  const als = new AsyncLocalStorage<otelApi.Context>();
  const contextManager: otelApi.ContextManager = {
    active: () => als.getStore() ?? otelApi.ROOT_CONTEXT,
    with: <A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      context: otelApi.Context,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> => als.run(context, () => fn.apply(thisArg, args)),
    bind: <T>(context: otelApi.Context, target: T): T => {
      if (typeof target === "function") {
        const bound = (...args: unknown[]) =>
          als.run(context, () => (target as (...a: unknown[]) => unknown)(...args));
        return bound as T;
      }
      return target;
    },
    enable: () => contextManager,
    disable: () => contextManager,
  };
  otelApi.context.setGlobalContextManager(contextManager);

  otelApi.trace.setGlobalTracerProvider(provider);
  registerShutdownHooks(provider);
}
