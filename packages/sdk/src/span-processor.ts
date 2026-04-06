import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/sdk-trace-base";
import type { CaptureConfig } from "@glasstrace/protocol";
import type { SessionManager } from "./session.js";

/**
 * Lightweight SpanProcessor that delegates to a wrapped processor.
 *
 * All glasstrace.* attribute enrichment has been moved to {@link GlasstraceExporter}
 * (see enriching-exporter.ts), which enriches spans at export time. This resolves:
 * - Cold-start spans are buffered in the exporter, not dropped
 * - Vercel's CompositeSpanProcessor skips onEnding(); the exporter doesn't need it
 * - Session ID is computed at export time with the resolved API key
 *
 * This class is retained for backward compatibility. New code should use
 * GlasstraceExporter directly.
 *
 * @deprecated Use GlasstraceExporter for span enrichment. This processor is now a pass-through.
 */
export class GlasstraceSpanProcessor implements SpanProcessor {
  private readonly wrappedProcessor: SpanProcessor;

  /* eslint-disable @typescript-eslint/no-unused-vars -- backward compat signature */
  constructor(
    wrappedProcessor: SpanProcessor,
    _sessionManager?: SessionManager,
    _apiKey?: string | (() => string),
    _getConfig?: () => CaptureConfig,
    _environment?: string,
  ) {
    /* eslint-enable @typescript-eslint/no-unused-vars */
    this.wrappedProcessor = wrappedProcessor;
  }

  onStart(span: Span, parentContext: Parameters<SpanProcessor["onStart"]>[1]): void {
    this.wrappedProcessor.onStart(span, parentContext);
  }

  onEnd(readableSpan: ReadableSpan): void {
    this.wrappedProcessor.onEnd(readableSpan);
  }

  async shutdown(): Promise<void> {
    return this.wrappedProcessor.shutdown();
  }

  async forceFlush(): Promise<void> {
    return this.wrappedProcessor.forceFlush();
  }
}
