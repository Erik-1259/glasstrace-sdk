import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let _resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let _activeExporter: GlasstraceExporter | null = null;

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

  // Build the exporter factory from the optional OTLP peer dependency
  let createOtlpExporter: ((url: string, headers: Record<string, string>) => SpanExporter) | null = null;
  const otlpModule = await tryImport("@opentelemetry/exporter-trace-otlp-http");
  if (otlpModule && typeof otlpModule.OTLPTraceExporter === "function") {
    const OTLPTraceExporter = otlpModule.OTLPTraceExporter as new (opts: {
      url: string;
      headers: Record<string, string>;
    }) => SpanExporter;
    createOtlpExporter = (url: string, headers: Record<string, string>) =>
      new OTLPTraceExporter({ url, headers });
  }

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
    if (!createOtlpExporter) {
      console.warn(
        "[glasstrace] @opentelemetry/exporter-trace-otlp-http not found for @vercel/otel path. Trace export disabled.",
      );
    }

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

  // Fallback: bare OTel SDK with BasicTracerProvider
  try {
    const otelSdk = await import("@opentelemetry/sdk-trace-base");
    const otelApi = await import("@opentelemetry/api");

    if (!createOtlpExporter) {
      // No OTLP exporter available -- rebuild GlasstraceExporter with a
      // ConsoleSpanExporter delegate so spans still get glasstrace.* enrichment.
      const consoleExporter = new otelSdk.ConsoleSpanExporter();
      const consoleGlasstraceExporter = new GlasstraceExporter({
        getApiKey: getResolvedApiKey,
        sessionManager,
        getConfig: () => getActiveConfig(),
        environment: config.environment,
        endpointUrl: exporterUrl,
        createDelegate: () => consoleExporter,
      });
      _activeExporter = consoleGlasstraceExporter;

      console.warn(
        "[glasstrace] @opentelemetry/exporter-trace-otlp-http not found. Using ConsoleSpanExporter.",
      );

      const processor = new otelSdk.SimpleSpanProcessor(consoleGlasstraceExporter);
      const provider = new otelSdk.BasicTracerProvider({
        spanProcessors: [processor],
      });
      otelApi.trace.setGlobalTracerProvider(provider);
      return;
    }

    const processor = new otelSdk.SimpleSpanProcessor(glasstraceExporter);
    const provider = new otelSdk.BasicTracerProvider({
      spanProcessors: [processor],
    });

    // Warn if another OTel provider is already registered to avoid
    // silently overwriting existing tracing (e.g., Datadog, New Relic).
    const existingProvider = otelApi.trace.getTracerProvider();
    if (existingProvider && existingProvider.constructor.name !== "ProxyTracerProvider") {
      console.warn(
        "[glasstrace] An existing OpenTelemetry TracerProvider was detected and will be replaced. " +
        "If you use another tracing tool, configure Glasstrace as an additional exporter instead.",
      );
    }

    otelApi.trace.setGlobalTracerProvider(provider);
  } catch {
    console.warn(
      "[glasstrace] Neither @vercel/otel nor @opentelemetry/sdk-trace-base available. Tracing disabled.",
    );
  }
}
