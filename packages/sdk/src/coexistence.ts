/**
 * OTel Coexistence Public API
 *
 * Provides createGlasstraceSpanProcessor() for developers who want to
 * manually integrate Glasstrace with their existing OTel provider
 * (e.g., Sentry's openTelemetrySpanProcessors config option).
 *
 * Also provides the auto-attach path (tryAutoAttachGlasstraceProcessor)
 * that configureOtel() uses when it detects a pre-registered provider
 * at runtime (Next.js 16 production, Sentry, Datadog, New Relic). Both
 * entry points reuse the same span-processor factory so the manual and
 * automatic paths stay in lockstep.
 *
 * Design: sdk-otel-coexistence.md Sections 3, 4, 5, 6
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type * as otelApi from "@opentelemetry/api";
import type { GlasstraceOptions } from "@glasstrace/protocol";
import { GlasstraceExporter } from "./enriching-exporter.js";
import { getResolvedApiKey, registerExporterForKeyNotification } from "./otel-config.js";
import { getActiveConfig } from "./init-client.js";
import { getSessionManager } from "./register.js";
import { resolveConfig } from "./env-detection.js";
import { getOtelState, OtelState } from "./lifecycle.js";
import { sdkLog } from "./console-capture.js";

/** Branded symbol used to identify Glasstrace's exporter across bundled copies. */
const GLASSTRACE_EXPORTER_BRAND = Symbol.for("glasstrace.exporter");

/**
 * Creates a Glasstrace span processor for manual integration with an
 * existing OTel provider.
 *
 * Use this when another tool (e.g., Sentry) owns the OTel provider and
 * you want to add Glasstrace to their processor list:
 *
 * @example
 * ```ts
 * import * as Sentry from "@sentry/nextjs";
 * import { createGlasstraceSpanProcessor } from "@glasstrace/sdk";
 *
 * Sentry.init({
 *   dsn: "...",
 *   openTelemetrySpanProcessors: [createGlasstraceSpanProcessor()],
 * });
 * ```
 *
 * **Important:** `registerGlasstrace()` is still required even when using
 * this function. The processor handles span transport (enrichment and
 * export). `registerGlasstrace()` handles everything else: init calls,
 * config sync, session management, anonymous key generation, discovery
 * endpoint, and health reporting.
 *
 * @param options - Optional SDK configuration. If omitted, uses the same
 *   config as registerGlasstrace() (environment variables).
 * @returns A BatchSpanProcessor wrapping a GlasstraceExporter with the
 *   branded Symbol.for('glasstrace.exporter') for coexistence detection.
 */
export function createGlasstraceSpanProcessor(
  options?: GlasstraceOptions,
): SpanProcessor {
  const config = resolveConfig(options);
  const exporterUrl = `${config.endpoint}/v1/traces`;

  const createOtlpExporter = (url: string, headers: Record<string, string>) =>
    new OTLPTraceExporter({ url, headers });

  const exporter = new GlasstraceExporter({
    getApiKey: getResolvedApiKey,
    sessionManager: getSessionManager(),
    getConfig: () => getActiveConfig(),
    environment: config.environment,
    endpointUrl: exporterUrl,
    createDelegate: createOtlpExporter,
    // Propagate verbose so exporter-level enrichment and export logs
    // stay observable whether the processor is built automatically by
    // the coexistence path or wired manually by the developer.
    verbose: config.verbose,
  });

  // Register for key-resolution notification so buffered spans flush
  // immediately when the key resolves (not waiting for BSP timer tick).
  registerExporterForKeyNotification(exporter);

  return new BatchSpanProcessor(exporter, {
    scheduledDelayMillis: 1000,
  });
}

/**
 * Result returned by {@link tryAutoAttachGlasstraceProcessor}.
 *
 * - `{ method, processor }` — a Glasstrace span processor was successfully
 *   injected into the existing provider's processor list. The caller MUST
 *   retain the returned processor so it can be flushed on shutdown.
 * - `"already_present"` — a Glasstrace-branded processor was already in
 *   the provider's list (e.g., the developer already registered one via
 *   `createGlasstraceSpanProcessor()`). No additional processor was added.
 * - `null` — injection was not possible (provider internals inaccessible
 *   or `addSpanProcessor` threw). The caller should emit guidance.
 */
export type AutoAttachResult =
  | { method: "v1_public" | "v2_private"; processor: SpanProcessor }
  | "already_present"
  | null;

/**
 * Checks whether a Glasstrace-branded span processor is already present
 * in the existing provider's processor list.
 *
 * Uses the branded symbol {@link GLASSTRACE_EXPORTER_BRAND} so detection
 * works across bundled copies of `@glasstrace/sdk` (hoisted vs. nested
 * `node_modules`). `Symbol.for()` uses a global registry, so every copy
 * resolves to the same symbol.
 *
 * Fully defensive — any error or missing internal structure returns
 * `false` and lets the caller fall through to injection or guidance.
 */
export function isGlasstraceProcessorPresent(
  tracerProvider: otelApi.TracerProvider,
): boolean {
  try {
    const proxy = tracerProvider as unknown as { getDelegate?: () => unknown };
    const delegate = typeof proxy.getDelegate === "function"
      ? proxy.getDelegate()
      : tracerProvider;

    // Path 1: v2 internal (_activeSpanProcessor._spanProcessors)
    const v2 = delegate as unknown as {
      _activeSpanProcessor?: {
        _spanProcessors?: Array<{ _exporter?: unknown }>;
      };
    };
    const v2Processors = v2._activeSpanProcessor?._spanProcessors;
    if (Array.isArray(v2Processors) && hasBrandedProcessor(v2Processors)) {
      return true;
    }

    // Path 2: v1 getActiveSpanProcessor()
    const v1 = delegate as unknown as {
      getActiveSpanProcessor?: () => { _spanProcessors?: Array<{ _exporter?: unknown }> };
    };
    if (typeof v1.getActiveSpanProcessor === "function") {
      const active = v1.getActiveSpanProcessor();
      const processors = active?._spanProcessors;
      if (Array.isArray(processors) && hasBrandedProcessor(processors)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Attempts to inject a Glasstrace span processor into an existing
 * provider's processor pipeline.
 *
 * Tiered approach:
 *   1. Feature-detect `addSpanProcessor` (OTel v1 public API) → call it
 *   2. Feature-detect `_activeSpanProcessor._spanProcessors` (OTel v2
 *      internal) → push the processor
 *
 * The processor is constructed via {@link createGlasstraceSpanProcessor}
 * so the auto-attach path and the manual integration path share identical
 * configuration (including the branded exporter for
 * {@link isGlasstraceProcessorPresent} detection and key-notification
 * registration).
 *
 * **Idempotence:** {@link isGlasstraceProcessorPresent} is consulted
 * before construction; if a Glasstrace-branded processor is already
 * attached, this function returns `"already_present"` without creating
 * a second exporter.
 *
 * **Defensive:** all errors are swallowed and return `null`. The SDK
 * falls back to emitting guidance rather than crashing.
 *
 * @param tracerProvider - The existing global provider returned by
 *   `otelApi.trace.getTracerProvider()`.
 * @param options - Optional SDK configuration passed through to
 *   `createGlasstraceSpanProcessor()`.
 * @returns See {@link AutoAttachResult}.
 */
export function tryAutoAttachGlasstraceProcessor(
  tracerProvider: otelApi.TracerProvider,
  options?: GlasstraceOptions,
): AutoAttachResult {
  try {
    // Short-circuit: if a Glasstrace-branded processor is already present,
    // never create a second exporter. Covers the duplicate
    // registerGlasstrace() case (idempotence) and the B-clean scenario
    // where the user wired createGlasstraceSpanProcessor() into their
    // provider config manually.
    if (isGlasstraceProcessorPresent(tracerProvider)) {
      return "already_present";
    }

    // Unwrap ProxyTracerProvider to reach the concrete delegate.
    const proxy = tracerProvider as unknown as { getDelegate?: () => unknown };
    const delegate = typeof proxy.getDelegate === "function"
      ? proxy.getDelegate()
      : tracerProvider;

    // Attempt 1: OTel v1 public API (addSpanProcessor).
    const withAdd = delegate as unknown as {
      addSpanProcessor?: (p: SpanProcessor) => void;
    };
    if (typeof withAdd.addSpanProcessor === "function") {
      const processor = createGlasstraceSpanProcessor(options);
      withAdd.addSpanProcessor(processor);
      return { method: "v1_public", processor };
    }

    // Attempt 2: OTel v2 internals (_activeSpanProcessor._spanProcessors).
    // Accessing a private field is justified in the design doc
    // (sdk-otel-coexistence.md Section 4). Same pattern Sentry uses.
    const v2 = delegate as unknown as {
      _activeSpanProcessor?: { _spanProcessors?: unknown[] };
    };
    const multiProcessor = v2._activeSpanProcessor;
    if (!multiProcessor || !Array.isArray(multiProcessor._spanProcessors)) {
      return null;
    }

    const processor = createGlasstraceSpanProcessor(options);
    multiProcessor._spanProcessors.push(processor);
    return { method: "v2_private", processor };
  } catch {
    return null;
  }
}

/**
 * Emits a nudge message guiding the developer toward the clean
 * createGlasstraceSpanProcessor() integration path.
 *
 * Called by configureOtel() when auto-attach succeeds (Scenarios B-auto, D1, D2).
 * NOT called when the processor is already present (Scenario B-clean).
 */
export function emitNudgeMessage(): void {
  const isSentry = detectSentry();

  if (isSentry) {
    sdkLog("info",
      `[glasstrace] Detected existing OTel provider — auto-attached Glasstrace span processor.\n` +
      `For a cleaner setup, add Glasstrace to your Sentry config:\n\n` +
      `  import { createGlasstraceSpanProcessor } from '@glasstrace/sdk';\n\n` +
      `  Sentry.init({\n` +
      `    dsn: '...',\n` +
      `    openTelemetrySpanProcessors: [createGlasstraceSpanProcessor()],\n` +
      `  });\n\n` +
      `This message will not appear once Glasstrace is added to your provider config.`,
    );
  } else {
    sdkLog("info",
      `[glasstrace] Detected existing OTel provider — auto-attached Glasstrace span processor.\n` +
      `For a cleaner setup, add Glasstrace to your provider config:\n\n` +
      `  import { createGlasstraceSpanProcessor } from '@glasstrace/sdk';\n\n` +
      `  const provider = new BasicTracerProvider({\n` +
      `    spanProcessors: [\n` +
      `      // ... your existing processors,\n` +
      `      createGlasstraceSpanProcessor(),\n` +
      `    ],\n` +
      `  });\n\n` +
      `This message will not appear once Glasstrace is added to your provider config.`,
    );
  }
}

/**
 * Emits a guidance message when auto-attach fails (Scenarios C, F).
 */
export function emitGuidanceMessage(): void {
  const isSentry = detectSentry();

  if (isSentry) {
    sdkLog("warn",
      `[glasstrace] An existing OTel TracerProvider is registered but Glasstrace ` +
      `could not auto-attach its span processor.\n` +
      `Add Glasstrace to your Sentry config:\n\n` +
      `  import { createGlasstraceSpanProcessor } from '@glasstrace/sdk';\n\n` +
      `  Sentry.init({\n` +
      `    dsn: '...',\n` +
      `    openTelemetrySpanProcessors: [createGlasstraceSpanProcessor()],\n` +
      `  });`,
    );
  } else {
    sdkLog("warn",
      `[glasstrace] An existing OTel TracerProvider is registered but Glasstrace ` +
      `could not auto-attach its span processor.\n` +
      `Add Glasstrace to your provider configuration:\n\n` +
      `  import { createGlasstraceSpanProcessor } from '@glasstrace/sdk';\n\n` +
      `  const provider = new BasicTracerProvider({\n` +
      `    spanProcessors: [\n` +
      `      // ... your existing processors,\n` +
      `      createGlasstraceSpanProcessor(),\n` +
      `    ],\n` +
      `  });`,
    );
  }
}

/**
 * Returns true if the nudge message should be shown.
 * Only show when auto-attach was used (not when the user already
 * configured the processor manually).
 */
export function shouldShowNudge(): boolean {
  return getOtelState() === OtelState.AUTO_ATTACHED;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Scans a processor list for one whose exporter carries the Glasstrace
 * brand symbol. Defensive — missing fields or non-object exporters return
 * `false`.
 */
function hasBrandedProcessor(
  processors: Array<{ _exporter?: unknown }>,
): boolean {
  return processors.some((p) => {
    const exporter = p._exporter as Record<symbol, unknown> | undefined;
    return exporter?.[GLASSTRACE_EXPORTER_BRAND] === true;
  });
}

function detectSentry(): boolean {
  try {
    // Check if @sentry/node or @sentry/nextjs is installed
    // Use require.resolve which checks module resolution without importing
    require.resolve("@sentry/node");
    return true;
  } catch {
    try {
      require.resolve("@sentry/nextjs");
      return true;
    } catch {
      return false;
    }
  }
}
