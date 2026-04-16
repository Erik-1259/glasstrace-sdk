/**
 * OTel Coexistence Public API
 *
 * Provides createGlasstraceSpanProcessor() for developers who want to
 * manually integrate Glasstrace with their existing OTel provider
 * (e.g., Sentry's openTelemetrySpanProcessors config option).
 *
 * Also provides nudge messaging that guides developers toward this
 * clean integration path when auto-attach is used.
 *
 * Design: sdk-otel-coexistence.md Sections 3, 5, 6
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { GlasstraceOptions } from "@glasstrace/protocol";
import { GlasstraceExporter } from "./enriching-exporter.js";
import { getResolvedApiKey, registerExporterForKeyNotification } from "./otel-config.js";
import { getActiveConfig } from "./init-client.js";
import { getSessionManager } from "./register.js";
import { resolveConfig } from "./env-detection.js";
import { getOtelState, OtelState } from "./lifecycle.js";
import { sdkLog } from "./console-capture.js";

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
  });

  // Register for key-resolution notification so buffered spans flush
  // immediately when the key resolves (not waiting for BSP timer tick).
  registerExporterForKeyNotification(exporter);

  return new BatchSpanProcessor(exporter, {
    scheduledDelayMillis: 1000,
  });
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
