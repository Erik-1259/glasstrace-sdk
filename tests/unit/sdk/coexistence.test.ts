import { describe, it, expect, beforeEach, vi } from "vitest";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  createGlasstraceSpanProcessor,
  emitNudgeMessage,
  emitGuidanceMessage,
  shouldShowNudge,
} from "../../../packages/sdk/src/coexistence.js";
import * as otelConfig from "../../../packages/sdk/src/otel-config.js";
import {
  initLifecycle,
  setOtelState,
  OtelState,
  resetLifecycleForTesting,
} from "../../../packages/sdk/src/lifecycle.js";
import * as consoleCapture from "../../../packages/sdk/src/console-capture.js";

describe("OTel Coexistence Public API", () => {
  beforeEach(() => {
    resetLifecycleForTesting();
    initLifecycle({ logger: vi.fn() });
    vi.restoreAllMocks();
  });

  describe("createGlasstraceSpanProcessor()", () => {
    it("returns a BatchSpanProcessor", () => {
      const processor = createGlasstraceSpanProcessor();
      expect(processor).toBeInstanceOf(BatchSpanProcessor);
    });

    it("creates a processor with the branded symbol", () => {
      const processor = createGlasstraceSpanProcessor();
      // Access the internal exporter to check for the brand
      const bsp = processor as unknown as { _exporter?: unknown };
      const exporter = bsp._exporter as Record<symbol, unknown> | undefined;
      const brand = Symbol.for("glasstrace.exporter");
      expect(exporter?.[brand]).toBe(true);
    });

    it("accepts optional GlasstraceOptions", () => {
      const processor = createGlasstraceSpanProcessor({
        endpoint: "https://custom.glasstrace.dev",
      });
      expect(processor).toBeInstanceOf(BatchSpanProcessor);
    });

    it("works without registerGlasstrace() being called first", () => {
      // Should not throw — creates processor with pending key
      const processor = createGlasstraceSpanProcessor();
      expect(processor).toBeDefined();
    });

    it("registers exporter for key notification", () => {
      const spy = vi.spyOn(otelConfig, "registerExporterForKeyNotification");

      createGlasstraceSpanProcessor();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe("Nudge messaging", () => {
    it("emitNudgeMessage shows generic example when Sentry is not installed", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

      emitNudgeMessage();

      const calls = spy.mock.calls.map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("createGlasstraceSpanProcessor"))).toBe(true);
      expect(calls.some((msg) => msg.includes("auto-attached"))).toBe(true);

      spy.mockRestore();
    });

    it("emitGuidanceMessage warns with instructions via sdkLog", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});

      emitGuidanceMessage();

      const calls = spy.mock.calls.filter((c) => c[0] === "warn").map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("createGlasstraceSpanProcessor"))).toBe(true);
      expect(calls.some((msg) => msg.includes("could not auto-attach"))).toBe(true);

      spy.mockRestore();
    });
  });

  describe("shouldShowNudge()", () => {
    it("returns true when OTel state is AUTO_ATTACHED", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.AUTO_ATTACHED);
      expect(shouldShowNudge()).toBe(true);
    });

    it("returns false when OTel state is PROCESSOR_PRESENT (B-clean)", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.PROCESSOR_PRESENT);
      expect(shouldShowNudge()).toBe(false);
    });

    it("returns false when OTel state is OWNS_PROVIDER", () => {
      setOtelState(OtelState.CONFIGURING);
      setOtelState(OtelState.OWNS_PROVIDER);
      expect(shouldShowNudge()).toBe(false);
    });
  });
});
