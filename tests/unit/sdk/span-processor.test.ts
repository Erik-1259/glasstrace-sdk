import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from "@opentelemetry/sdk-trace-base";
import type { CaptureConfig } from "@glasstrace/protocol";
import { GlasstraceSpanProcessor } from "../../../packages/sdk/src/span-processor.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

function createTestSetup(opts?: {
  config?: CaptureConfig;
  apiKey?: string;
  environment?: string;
}) {
  const exporter = new InMemorySpanExporter();
  const innerProcessor = new SimpleSpanProcessor(exporter);
  const sessionManager = new SessionManager();
  const apiKey = opts?.apiKey ?? "gt_dev_" + "a".repeat(48);
  const getConfig = () => opts?.config ?? DEFAULT_CONFIG;

  const processor = new GlasstraceSpanProcessor(
    innerProcessor,
    sessionManager,
    apiKey,
    getConfig,
    opts?.environment,
  );

  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer("test");

  return { exporter, provider, tracer, processor };
}

describe("GlasstraceSpanProcessor (pass-through)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Delegation", () => {
    it("forwards spans to the wrapped processor", async () => {
      const { tracer, exporter, provider } = createTestSetup();

      const span = tracer.startSpan("test-operation");
      span.end();
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("test-operation");
    });

    it("delegates shutdown to wrapped processor", async () => {
      const { processor } = createTestSetup();
      await expect(processor.shutdown()).resolves.toBeUndefined();
    });

    it("delegates forceFlush to wrapped processor", async () => {
      const { processor } = createTestSetup();
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe("Enrichment pass-through", () => {
    it("passes span attributes through to the inner processor", async () => {
      const { tracer, exporter, provider } = createTestSetup({
        environment: "staging",
      });

      const span = tracer.startSpan("enriched-op");
      span.setAttribute("custom.attr", "value");
      span.end();
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes["custom.attr"]).toBe("value");
    });
  });

  describe("Error propagation", () => {
    it("propagates inner processor errors (does not silently swallow)", () => {
      // GlasstraceSpanProcessor is a thin pass-through. Inner processor
      // errors should propagate naturally — the processor should not add
      // its own error swallowing layer.
      const brokenProcessor = {
        onStart: () => {},
        onEnd: () => {
          throw new Error("inner processor exploded");
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      };

      const sessionManager = new SessionManager();
      const processor = new GlasstraceSpanProcessor(
        brokenProcessor,
        sessionManager,
        "gt_dev_" + "a".repeat(48),
        () => DEFAULT_CONFIG,
        "test",
      );

      // Call processor.onEnd directly to test the wrapper behavior without
      // relying on BasicTracerProvider's exception propagation semantics.
      const provider = new BasicTracerProvider();
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("safe-op");

      expect(() => processor.onEnd(span as never)).toThrow(
        "inner processor exploded",
      );
    });
  });

  describe("Backward compatibility", () => {
    it("accepts the same constructor arguments as the original", () => {
      const sessionManager = new SessionManager();
      const getConfig = () => DEFAULT_CONFIG;

      // Should not throw with all original arguments
      expect(
        () =>
          new GlasstraceSpanProcessor(
            {
              onStart: () => {},
              onEnd: () => {},
              shutdown: () => Promise.resolve(),
              forceFlush: () => Promise.resolve(),
            },
            sessionManager,
            "gt_dev_" + "a".repeat(48),
            getConfig,
            "staging",
          ),
      ).not.toThrow();

      // Should also accept a function for apiKey
      expect(
        () =>
          new GlasstraceSpanProcessor(
            {
              onStart: () => {},
              onEnd: () => {},
              shutdown: () => Promise.resolve(),
              forceFlush: () => Promise.resolve(),
            },
            sessionManager,
            () => "gt_dev_" + "a".repeat(48),
            getConfig,
          ),
      ).not.toThrow();
    });
  });
});
