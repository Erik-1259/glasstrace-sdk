import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installConsoleCapture,
  uninstallConsoleCapture,
} from "../../../packages/sdk/src/console-capture.js";

/**
 * Creates a mock span with a `addEvent` spy.
 * Sets up the @opentelemetry/api mock so that `trace.getSpan(context.active())`
 * returns the mock span when called from inside the console wrappers.
 */
function mockOtelWithActiveSpan() {
  const addEvent = vi.fn();
  const mockSpan = { addEvent };

  vi.doMock("@opentelemetry/api", () => ({
    trace: {
      getSpan: () => mockSpan,
    },
    context: {
      active: () => ({}),
    },
  }));

  return { mockSpan, addEvent };
}

function mockOtelWithNoActiveSpan() {
  vi.doMock("@opentelemetry/api", () => ({
    trace: {
      getSpan: () => undefined,
    },
    context: {
      active: () => ({}),
    },
  }));
}

describe("console-capture", () => {
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalError = console.error;
    originalWarn = console.warn;
  });

  afterEach(() => {
    uninstallConsoleCapture();
    // Ensure originals are restored even if uninstall fails
    console.error = originalError;
    console.warn = originalWarn;
    vi.doUnmock("@opentelemetry/api");
  });

  describe("installConsoleCapture", () => {
    it("replaces console.error and console.warn", async () => {
      await installConsoleCapture();
      expect(console.error).not.toBe(originalError);
      expect(console.warn).not.toBe(originalWarn);
    });

    it("is idempotent — second call is a no-op", async () => {
      await installConsoleCapture();
      const firstError = console.error;
      const firstWarn = console.warn;

      await installConsoleCapture();
      expect(console.error).toBe(firstError);
      expect(console.warn).toBe(firstWarn);
    });
  });

  describe("uninstallConsoleCapture", () => {
    it("restores original console.error and console.warn", async () => {
      await installConsoleCapture();
      uninstallConsoleCapture();
      expect(console.error).toBe(originalError);
      expect(console.warn).toBe(originalWarn);
    });

    it("is safe to call when not installed", () => {
      expect(() => uninstallConsoleCapture()).not.toThrow();
    });
  });

  describe("wrapped console methods", () => {
    it("console.error calls the original method", async () => {
      const spy = vi.fn();
      console.error = spy;

      await installConsoleCapture();
      console.error("test message");

      expect(spy).toHaveBeenCalledWith("test message");
    });

    it("console.warn calls the original method", async () => {
      const spy = vi.fn();
      console.warn = spy;

      await installConsoleCapture();
      console.warn("test message");

      expect(spy).toHaveBeenCalledWith("test message");
    });

    it("skips capture for messages starting with '[glasstrace]'", async () => {
      const { addEvent } = mockOtelWithActiveSpan();

      // Must re-import to pick up the mock
      const mod = await import("../../../packages/sdk/src/console-capture.js");
      await mod.installConsoleCapture();
      console.error("[glasstrace] internal SDK message");

      expect(addEvent).not.toHaveBeenCalled();
      mod.uninstallConsoleCapture();
    });

    it("records console.error as span event when span is active", async () => {
      const { addEvent } = mockOtelWithActiveSpan();

      const mod = await import("../../../packages/sdk/src/console-capture.js");
      await mod.installConsoleCapture();
      console.error("something went wrong");

      expect(addEvent).toHaveBeenCalledWith("console.error", {
        "console.message": "something went wrong",
      });
      mod.uninstallConsoleCapture();
    });

    it("records console.warn as span event when span is active", async () => {
      const { addEvent } = mockOtelWithActiveSpan();

      const mod = await import("../../../packages/sdk/src/console-capture.js");
      await mod.installConsoleCapture();
      console.warn("potential issue");

      expect(addEvent).toHaveBeenCalledWith("console.warn", {
        "console.message": "potential issue",
      });
      mod.uninstallConsoleCapture();
    });

    it("formats multiple arguments into a single message", async () => {
      const { addEvent } = mockOtelWithActiveSpan();

      const mod = await import("../../../packages/sdk/src/console-capture.js");
      await mod.installConsoleCapture();
      console.error("error:", 42, { detail: "info" });

      expect(addEvent).toHaveBeenCalledWith("console.error", {
        "console.message": 'error: 42 {"detail":"info"}',
      });
      mod.uninstallConsoleCapture();
    });

    it("does not record span event when no span is active", async () => {
      mockOtelWithNoActiveSpan();

      const mod = await import("../../../packages/sdk/src/console-capture.js");
      await mod.installConsoleCapture();

      expect(() => console.error("no span context")).not.toThrow();
      mod.uninstallConsoleCapture();
    });
  });
});
