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
