import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import type { CaptureConfig } from "@glasstrace/protocol";
import { GlasstraceExporter, API_KEY_PENDING, extractLeadingPath } from "../../../packages/sdk/src/enriching-exporter.js";
import { SessionManager } from "../../../packages/sdk/src/session.js";
import * as healthCollector from "../../../packages/sdk/src/health-collector.js";
import * as consoleCapture from "../../../packages/sdk/src/console-capture.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

const DEFAULT_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

const TEST_API_KEY = "gt_dev_" + "a".repeat(48);

/**
 * Creates a mock ReadableSpan with realistic attributes.
 */
function createMockSpan(overrides?: {
  name?: string;
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  startTime?: [number, number];
  endTime?: [number, number];
  instrumentationScope?: { name: string; version?: string };
  status?: { code: SpanStatusCode; message?: string };
  events?: Array<{ time: [number, number]; name: string; attributes?: Record<string, string | number | boolean> }>;
}): ReadableSpan {
  return {
    name: overrides?.name ?? "GET /api/users",
    kind: overrides?.kind ?? SpanKind.SERVER,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    }),
    parentSpanId: undefined,
    startTime: overrides?.startTime ?? [1700000000, 0],
    endTime: overrides?.endTime ?? [1700000000, 150_000_000], // 150ms
    status: overrides?.status ?? { code: SpanStatusCode.OK },
    attributes: overrides?.attributes ?? {
      "http.method": "GET",
      "http.route": "/api/users",
      "http.status_code": 200,
    },
    links: [],
    events: overrides?.events ?? [],
    duration: [0, 150_000_000],
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: overrides?.instrumentationScope ?? { name: "test", version: "1.0.0" },
    instrumentationLibrary: overrides?.instrumentationScope ?? { name: "test", version: "1.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan; // Mock object — ReadableSpan interface is too wide to satisfy without cast
}

/**
 * Creates a mock exception event matching OTel's recordException() output.
 */
function createExceptionEvent(
  type?: string,
  message?: string,
): { time: [number, number]; name: string; attributes: Record<string, string> } {
  const attributes: Record<string, string> = {};
  if (type) attributes["exception.type"] = type;
  if (message) attributes["exception.message"] = message;
  return {
    time: [1700000000, 50_000_000],
    name: "exception",
    attributes,
  };
}

/**
 * Creates a mock delegate SpanExporter.
 */
function createMockDelegate(): SpanExporter & {
  exportedSpans: ReadableSpan[][];
  exportCallbacks: Array<(result: ExportResult) => void>;
} {
  const delegate = {
    exportedSpans: [] as ReadableSpan[][],
    exportCallbacks: [] as Array<(result: ExportResult) => void>,
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
      delegate.exportedSpans.push(spans);
      delegate.exportCallbacks.push(resultCallback);
      resultCallback({ code: 0 });
    },
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  };
  return delegate;
}

function createExporter(overrides?: {
  apiKey?: string | (() => string);
  environment?: string;
  delegate?: SpanExporter;
  verbose?: boolean;
}): {
  exporter: GlasstraceExporter;
  delegate: ReturnType<typeof createMockDelegate>;
  sessionManager: SessionManager;
  getApiKey: () => string;
} {
  const delegate = (overrides?.delegate as ReturnType<typeof createMockDelegate>) ?? createMockDelegate();
  const sessionManager = new SessionManager();

  const currentKey = typeof overrides?.apiKey === "function"
    ? overrides.apiKey()
    : (overrides?.apiKey ?? TEST_API_KEY);

  const getApiKey = typeof overrides?.apiKey === "function"
    ? overrides.apiKey
    : () => currentKey;

  const exporter = new GlasstraceExporter({
    getApiKey,
    sessionManager,
    getConfig: () => DEFAULT_CONFIG,
    environment: overrides?.environment,
    endpointUrl: "https://api.glasstrace.dev/v1/traces",
    createDelegate: () => delegate,
    verbose: overrides?.verbose,
  });

  return { exporter, delegate, sessionManager, getApiKey };
}

describe("GlasstraceExporter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Enrichment basics", () => {
    it("enriches HTTP span with glasstrace.route, method, status_code, and duration_ms", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      expect(delegate.exportedSpans).toHaveLength(1);
      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ROUTE]).toBe("/api/users");
      expect(enriched.attributes[ATTR.HTTP_METHOD]).toBe("GET");
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(200);
      expect(typeof enriched.attributes[ATTR.HTTP_DURATION_MS]).toBe("number");
      expect(enriched.attributes[ATTR.HTTP_DURATION_MS]).toBe(150);
    });

    it("uses http.request.method and http.response.status_code as fallbacks", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "POST /api/orders",
        attributes: {
          "http.request.method": "POST",
          "http.response.status_code": 201,
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_METHOD]).toBe("POST");
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(201);
    });

    it("uses span name as route fallback when http.route is absent", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "GET /health",
        attributes: {},
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ROUTE]).toBe("GET /health");
    });

    it("enriches error spans with glasstrace.error.*", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "failing-op",
        attributes: {
          "exception.message": "User not found",
          "exception.type": "NotFoundError",
          "error.field": "userId",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_MESSAGE]).toBe("User not found");
      expect(enriched.attributes[ATTR.ERROR_CODE]).toBe("NotFoundError");
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("not-found");
      expect(enriched.attributes[ATTR.ERROR_FIELD]).toBe("userId");
    });

    it("enriches Prisma-shaped spans with glasstrace.orm.*", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "prisma:query",
        attributes: {
          "db.sql.table": "User",
          "db.operation": "SELECT",
        },
        instrumentationScope: { name: "@prisma/instrumentation", version: "1.0.0" },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ORM_PROVIDER]).toBe("prisma");
      expect(enriched.attributes[ATTR.ORM_MODEL]).toBe("User");
      expect(enriched.attributes[ATTR.ORM_OPERATION]).toBe("SELECT");
    });

    it("enriches Drizzle-shaped spans", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "drizzle:query",
        attributes: {
          "db.sql.table": "orders",
          "db.operation": "INSERT",
        },
        instrumentationScope: { name: "drizzle-orm" },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ORM_PROVIDER]).toBe("drizzle");
    });

    it("classifies outbound fetch targets on CLIENT spans", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "HTTP GET",
        kind: SpanKind.CLIENT,
        attributes: {
          "http.url": "https://api.stripe.com/v1/charges",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.FETCH_TARGET]).toBe("stripe");
    });

    it("does not classify fetch target on SERVER spans", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "incoming request",
        kind: SpanKind.SERVER,
        attributes: {
          "http.url": "https://api.stripe.com/v1/charges",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.FETCH_TARGET]).toBeUndefined();
    });

    it("attaches glasstrace.session.id to every span", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.SESSION_ID]).toBeTruthy();
      expect(typeof enriched.attributes[ATTR.SESSION_ID]).toBe("string");
    });

    it("attaches glasstrace.trace.type to every span", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRACE_TYPE]).toBe("server");
    });

    it("attaches glasstrace.environment from constructor", () => {
      const { exporter, delegate } = createExporter({ environment: "staging" });
      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ENVIRONMENT]).toBe("staging");
    });

    it("propagates correlation ID from span attributes", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "glasstrace.correlation.id": "550e8400-e29b-41d4-a716-446655440000",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.CORRELATION_ID]).toBe(
        "550e8400-e29b-41d4-a716-446655440000",
      );
    });
  });

  describe("Buffering when key pending", () => {
    it("buffers spans when API key is pending", () => {
      const delegate = createMockDelegate();
      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      // Delegate should NOT have been called
      expect(delegate.exportedSpans).toHaveLength(0);
      // Callback should NOT have been called (spans are buffered)
      expect(callback).not.toHaveBeenCalled();
    });

    it("flushes buffered spans when key resolves", () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;
      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      const span1 = createMockSpan({ name: "GET /api/users" });
      const span2 = createMockSpan({ name: "POST /api/orders" });
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      exporter.export([span1], callback1);
      exporter.export([span2], callback2);

      expect(delegate.exportedSpans).toHaveLength(0);

      // Resolve the key
      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      // All buffered spans should now be exported
      expect(delegate.exportedSpans).toHaveLength(2);
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it("exports directly when key is already resolved", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      expect(delegate.exportedSpans).toHaveLength(1);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe("Buffer overflow", () => {
    it("evicts oldest batches when buffer exceeds 1024 spans (FIFO order)", () => {
      const delegate = createMockDelegate();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const exporter = new GlasstraceExporter({
          getApiKey: () => API_KEY_PENDING,
          sessionManager: new SessionManager(),
          getConfig: () => DEFAULT_CONFIG,
          environment: undefined,
          endpointUrl: "https://api.glasstrace.dev/v1/traces",
          createDelegate: () => delegate,
        });

        const callbacks: ReturnType<typeof vi.fn>[] = [];

        // Buffer 1025 spans (individual batches of 1)
        for (let i = 0; i < 1025; i++) {
          const cb = vi.fn();
          callbacks.push(cb);
          exporter.export([createMockSpan({ name: `span-${i}` })], cb);
        }

        // Only the first (oldest) callback should have been evicted to get
        // back under the 1024-span limit
        expect(callbacks[0]).toHaveBeenCalled();
        // The next-oldest batch and the last span should still be buffered
        expect(callbacks[1]).not.toHaveBeenCalled();
        expect(callbacks[1024]).not.toHaveBeenCalled();

        // Overflow warning should be logged exactly once
        const overflowWarnings = warnSpy.mock.calls.filter(
          (call) => typeof call[0] === "string" && call[0].includes("overflow"),
        );
        expect(overflowWarnings).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("Session ID uses resolved key", () => {
    it("computes session ID with resolved key for both buffered and direct spans", () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;
      const sessionManager = new SessionManager();

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager,
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      // Buffer a span while pending
      const span = createMockSpan();
      const callback = vi.fn();
      exporter.export([span], callback);

      // Resolve key and flush
      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      // Buffered spans are enriched at flush time with the resolved key
      const flushedSpan = delegate.exportedSpans[0][0];
      const sessionIdFromResolvedKey = sessionManager.getSessionId(TEST_API_KEY);
      expect(flushedSpan.attributes[ATTR.SESSION_ID]).toBe(sessionIdFromResolvedKey);

      // New spans after key resolution should also use the resolved key
      const span2 = createMockSpan();
      const callback2 = vi.fn();
      exporter.export([span2], callback2);

      const directSpan = delegate.exportedSpans[1][0];
      expect(directSpan.attributes[ATTR.SESSION_ID]).toBe(sessionIdFromResolvedKey);
    });
  });

  describe("Partial enrichment resilience", () => {
    it("continues enrichment when SessionManager throws", () => {
      const delegate = createMockDelegate();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const brokenSessionManager = {
          getSessionId: () => {
            throw new Error("session broken");
          },
        } as unknown as SessionManager; // Intentionally broken — testing resilience when SessionManager throws

        const exporter = new GlasstraceExporter({
          getApiKey: () => TEST_API_KEY,
          sessionManager: brokenSessionManager,
          getConfig: () => DEFAULT_CONFIG,
          environment: "staging",
          endpointUrl: "https://api.glasstrace.dev/v1/traces",
          createDelegate: () => delegate,
        });

        const span = createMockSpan({
          attributes: {
            "http.method": "GET",
            "http.status_code": 200,
          },
        });
        const callback = vi.fn();

        exporter.export([span], callback);

        const enriched = delegate.exportedSpans[0][0];
        // Session ID should be absent due to error
        expect(enriched.attributes[ATTR.SESSION_ID]).toBeUndefined();
        // Other attributes should still be present
        expect(enriched.attributes[ATTR.TRACE_TYPE]).toBe("server");
        expect(enriched.attributes[ATTR.HTTP_METHOD]).toBe("GET");
        expect(enriched.attributes[ATTR.ENVIRONMENT]).toBe("staging");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("enriches spans with missing/malformed attributes gracefully", () => {
      const { exporter, delegate } = createExporter({ environment: "test" });
      const span = createMockSpan({
        name: "internal-op",
        attributes: {},
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRACE_TYPE]).toBe("server");
      expect(enriched.attributes[ATTR.SESSION_ID]).toBeTruthy();
      expect(enriched.attributes[ATTR.ENVIRONMENT]).toBe("test");
      expect(enriched.attributes[ATTR.HTTP_METHOD]).toBeUndefined();
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBeUndefined();
    });
  });

  describe("Shutdown", () => {
    it("flushes buffered spans on shutdown when key is resolved", async () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      const span = createMockSpan();
      const callback = vi.fn();
      exporter.export([span], callback);

      // Resolve key, then shutdown
      currentKey = TEST_API_KEY;
      await exporter.shutdown();

      // Buffered spans should have been flushed
      expect(delegate.exportedSpans).toHaveLength(1);
      expect(delegate.shutdown).toHaveBeenCalled();
    });

    it("logs warning on shutdown when key is still pending", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const delegate = createMockDelegate();

      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      const span = createMockSpan();
      const callback = vi.fn();
      exporter.export([span], callback);

      await exporter.shutdown();

      const lostWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("spans lost"),
      );
      expect(lostWarning).toBeDefined();
      // Callback should be completed so pipeline doesn't hang
      expect(callback).toHaveBeenCalled();
    });
  });

  describe("Duration calculation", () => {
    it("correctly computes duration from HrTime tuples", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        startTime: [1700000000, 500_000_000], // +500ms
        endTime: [1700000002, 250_000_000],   // +2s 250ms
        attributes: {},
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      // Duration should be (2 - 0) * 1000 + (250_000_000 - 500_000_000) / 1_000_000
      // = 2000 + (-250) = 1750ms
      expect(enriched.attributes[ATTR.HTTP_DURATION_MS]).toBe(1750);
    });

    it("handles sub-millisecond durations", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        startTime: [1700000000, 0],
        endTime: [1700000000, 500_000], // 0.5ms
        attributes: {},
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_DURATION_MS]).toBe(0.5);
    });
  });

  describe("Error category derivation", () => {
    it("derives validation category for ZodError", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "exception.message": "Invalid input",
          "exception.type": "ZodError",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("validation");
    });

    it("derives network category for ECONNREFUSED", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "exception.message": "Connection refused",
          "exception.type": "ECONNREFUSED",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("network");
    });

    it("derives auth category for UnauthorizedError", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "exception.type": "UnauthorizedError",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("auth");
    });

    it("defaults to internal category for unknown errors", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "exception.type": "SomeRandomError",
        },
      });
      const callback = vi.fn();

      exporter.export([span], callback);

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("internal");
    });
  });

  describe("No delegate factory", () => {
    it("reports success when no delegate factory is provided", () => {
      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: null,
      });

      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      expect(callback).toHaveBeenCalledWith({ code: 0 });
    });
  });

  describe("forceFlush", () => {
    it("delegates forceFlush to the underlying exporter", async () => {
      const { exporter, delegate } = createExporter();
      // Trigger delegate creation by exporting a span
      exporter.export([createMockSpan()], vi.fn());

      await exporter.forceFlush();

      expect(delegate.forceFlush).toHaveBeenCalled();
    });

    it("resolves immediately when no delegate exists", async () => {
      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: null,
      });

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe("Deferred enrichment", () => {
    it("enriches buffered spans at flush time with the resolved key", () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;
      const sessionManager = new SessionManager();

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager,
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      // Buffer a span while key is pending
      const span = createMockSpan();
      const callback = vi.fn();
      exporter.export([span], callback);

      // Resolve key and flush
      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      // The flushed span should have a session ID from the resolved key
      const flushedSpan = delegate.exportedSpans[0][0];
      const expectedSessionId = sessionManager.getSessionId(TEST_API_KEY);
      expect(flushedSpan.attributes[ATTR.SESSION_ID]).toBe(expectedSessionId);
    });
  });

  describe("Buffer race condition fix", () => {
    it("flushes immediately when key resolves between check and buffer", () => {
      const delegate = createMockDelegate();
      let callCount = 0;

      // Simulate the race: getApiKey returns "pending" on the first call
      // (the check in export()) but returns the real key on the second call
      // (the re-check in bufferSpans). This models the key resolving between
      // the two calls.
      const getApiKey = () => {
        callCount++;
        return callCount <= 1 ? API_KEY_PENDING : TEST_API_KEY;
      };

      const exporter = new GlasstraceExporter({
        getApiKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      const span = createMockSpan();
      const callback = vi.fn();

      exporter.export([span], callback);

      // The re-check in bufferSpans should have detected the resolved key
      // and flushed immediately — no need for notifyKeyResolved.
      expect(delegate.exportedSpans).toHaveLength(1);
      expect(callback).toHaveBeenCalled();
    });
  });

  describe("Key rotation", () => {
    it("recreates delegate when API key changes", () => {
      let currentKey = "gt_dev_" + "a".repeat(48);

      const createDelegate = vi.fn(() => createMockDelegate());

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate,
      });

      // First export — creates delegate with key A
      exporter.export([createMockSpan()], vi.fn());
      expect(createDelegate).toHaveBeenCalledTimes(1);

      // Second export with same key — reuses delegate
      exporter.export([createMockSpan()], vi.fn());
      expect(createDelegate).toHaveBeenCalledTimes(1);

      // Rotate key
      currentKey = "gt_dev_" + "b".repeat(48);

      // Third export — should create new delegate with key B
      exporter.export([createMockSpan()], vi.fn());
      expect(createDelegate).toHaveBeenCalledTimes(2);

      // Verify the new delegate was called with the new key in headers
      const lastCallArgs = createDelegate.mock.calls[1];
      expect(lastCallArgs[1]).toEqual({
        Authorization: `Bearer ${currentKey}`,
      });
    });
  });

  describe("Original span not mutated", () => {
    it("does not modify the original span's attributes", () => {
      const { exporter } = createExporter();
      const originalAttributes = {
        "http.method": "GET",
        "http.status_code": 200,
      };
      const span = createMockSpan({ attributes: { ...originalAttributes } });
      const callback = vi.fn();

      exporter.export([span], callback);

      // Original span attributes should be unchanged
      expect(Object.keys(span.attributes)).toEqual(Object.keys(originalAttributes));
      expect(span.attributes[ATTR.ROUTE]).toBeUndefined();
    });
  });

  describe("Health recording", () => {
    it("records exported span count on direct export", () => {
      const spy = vi.spyOn(healthCollector, "recordSpansExported");
      const { exporter } = createExporter();

      exporter.export([createMockSpan(), createMockSpan()], vi.fn());

      expect(spy).toHaveBeenCalledWith(2);
    });

    it("records exported span count on flush after key resolution", () => {
      const spy = vi.spyOn(healthCollector, "recordSpansExported");
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      exporter.export([createMockSpan(), createMockSpan(), createMockSpan()], vi.fn());
      expect(spy).not.toHaveBeenCalled();

      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      expect(spy).toHaveBeenCalledWith(3);
    });

    it("records dropped span count on buffer overflow", () => {
      const spy = vi.spyOn(healthCollector, "recordSpansDropped");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => createMockDelegate(),
      });

      // Fill buffer to 1024
      for (let i = 0; i < 1024; i++) {
        exporter.export([createMockSpan()], vi.fn());
      }
      expect(spy).not.toHaveBeenCalled();

      // One more triggers eviction of the oldest batch (1 span)
      exporter.export([createMockSpan()], vi.fn());
      expect(spy).toHaveBeenCalledWith(1);
    });

    it("records dropped span count on shutdown with unresolved key", async () => {
      const spy = vi.spyOn(healthCollector, "recordSpansDropped");
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => createMockDelegate(),
      });

      exporter.export([createMockSpan(), createMockSpan()], vi.fn());
      exporter.export([createMockSpan()], vi.fn());

      await exporter.shutdown();

      expect(spy).toHaveBeenCalledWith(3);
    });

    it("records dropped span count on direct export with no delegate factory", () => {
      const spy = vi.spyOn(healthCollector, "recordSpansDropped");

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: null,
      });

      exporter.export([createMockSpan(), createMockSpan()], vi.fn());

      expect(spy).toHaveBeenCalledWith(2);
    });

    it("records dropped span count when flushPending has no delegate factory", () => {
      const spy = vi.spyOn(healthCollector, "recordSpansDropped");
      let currentKey = API_KEY_PENDING;

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: null,
      });

      // Buffer 3 spans while key is pending
      exporter.export([createMockSpan(), createMockSpan()], vi.fn());
      exporter.export([createMockSpan()], vi.fn());

      // Resolve key — triggers flushPending, but no delegate factory
      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      expect(spy).toHaveBeenCalledWith(3);
    });
  });

  describe("Export failure logging", () => {
    it("logs warning when delegate export fails on direct export", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const failingDelegate = {
        ...createMockDelegate(),
        export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
          resultCallback({ code: 1, error: new Error("auth failed") });
        },
        shutdown: vi.fn().mockResolvedValue(undefined),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => failingDelegate,
      });

      const callback = vi.fn();
      exporter.export([createMockSpan()], callback);

      const exportWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Span export failed"),
      );
      expect(exportWarning).toBeDefined();
      expect(exportWarning![0]).toContain("auth failed");

      // Callback should still be called (propagated)
      expect(callback).toHaveBeenCalledWith({ code: 1, error: expect.any(Error) });
    });

    it("logs warning when delegate export fails on flush path", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let currentKey = API_KEY_PENDING;

      const failingDelegate = {
        ...createMockDelegate(),
        export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
          resultCallback({ code: 1, error: new Error("network timeout") });
        },
        shutdown: vi.fn().mockResolvedValue(undefined),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => failingDelegate,
      });

      const callback = vi.fn();
      exporter.export([createMockSpan()], callback);

      // Resolve key to trigger flush
      currentKey = TEST_API_KEY;
      exporter.notifyKeyResolved();

      const exportWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Span export failed"),
      );
      expect(exportWarning).toBeDefined();
      expect(exportWarning![0]).toContain("network timeout");
    });

    it("logs 'unknown error' when export fails without error object", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const failingDelegate = {
        ...createMockDelegate(),
        export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
          resultCallback({ code: 1 });
        },
        shutdown: vi.fn().mockResolvedValue(undefined),
        forceFlush: vi.fn().mockResolvedValue(undefined),
      };

      const exporter = new GlasstraceExporter({
        getApiKey: () => TEST_API_KEY,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => failingDelegate,
      });

      exporter.export([createMockSpan()], vi.fn());

      const exportWarning = warnSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("Span export failed"),
      );
      expect(exportWarning).toBeDefined();
      expect(exportWarning![0]).toContain("unknown error");
    });

    it("does NOT log on successful export", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { exporter } = createExporter();
      exporter.export([createMockSpan()], vi.fn());

      const exportWarnings = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("Span export failed"),
      );
      expect(exportWarnings).toHaveLength(0);
    });
  });

  describe("forceFlush with pending batches", () => {
    it("flushes pending batches when key resolved but notifyKeyResolved not called", async () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      // Buffer spans while key is pending
      exporter.export([createMockSpan(), createMockSpan()], vi.fn());
      expect(delegate.exportedSpans).toHaveLength(0);

      // Resolve key WITHOUT calling notifyKeyResolved
      currentKey = TEST_API_KEY;

      // forceFlush should detect resolved key and flush pending batches
      await exporter.forceFlush();

      expect(delegate.exportedSpans).toHaveLength(1);
      expect(delegate.exportedSpans[0]).toHaveLength(2);
    });

    it("does NOT flush when key is still pending", async () => {
      const delegate = createMockDelegate();

      const exporter = new GlasstraceExporter({
        getApiKey: () => API_KEY_PENDING,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      exporter.export([createMockSpan()], vi.fn());

      await exporter.forceFlush();

      // Spans should still be buffered, not flushed
      expect(delegate.exportedSpans).toHaveLength(0);
    });

    it("delegates forceFlush to underlying exporter after flushing pending", async () => {
      const delegate = createMockDelegate();
      let currentKey = API_KEY_PENDING;

      const exporter = new GlasstraceExporter({
        getApiKey: () => currentKey,
        sessionManager: new SessionManager(),
        getConfig: () => DEFAULT_CONFIG,
        environment: undefined,
        endpointUrl: "https://api.glasstrace.dev/v1/traces",
        createDelegate: () => delegate,
      });

      exporter.export([createMockSpan()], vi.fn());

      currentKey = TEST_API_KEY;
      await exporter.forceFlush();

      // Both pending flush AND delegate forceFlush should have happened
      expect(delegate.exportedSpans).toHaveLength(1);
      expect(delegate.forceFlush).toHaveBeenCalled();
    });
  });

  describe("Error status inference (DISC-1134)", () => {
    it("infers 500 when span has ERROR status and http.status_code is 200", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR, message: "Internal Server Error" },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("infers 500 when span has ERROR status and http.status_code is 0", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.method": "GET",
          "http.status_code": 0,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("infers 500 when span has ERROR status and no http.status_code", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.method": "GET",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("uses error.type numeric value when present (e.g. '404' → 404)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "error.type": "404",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(404);
    });

    it("defaults to 500 when error.type is non-numeric (e.g. 'NotFoundError')", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "error.type": "NotFoundError",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("keeps existing error status code when already >= 400", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR },
        attributes: {
          "http.method": "GET",
          "http.status_code": 404,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(404);
    });

    it("does NOT infer error status on OK spans with status_code 200", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.OK },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(200);
    });

    it("does NOT infer error status on UNSET spans with status_code 200", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(200);
    });

    it("does NOT infer error status on non-HTTP error spans (e.g. DB spans)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.ERROR, message: "query failed" },
        attributes: {
          "db.operation": "SELECT",
          "db.sql.table": "users",
        },
        instrumentationScope: { name: "@prisma/instrumentation" },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      // Non-HTTP span should NOT get an inferred HTTP status code
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBeUndefined();
    });
  });

  describe("Error detection via exception events (DISC-1204)", () => {
    it("infers 500 when exception event present and status is UNSET with status_code 200", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
        events: [createExceptionEvent("TypeError", "Cannot read properties of undefined")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("infers 500 when exception event present and no http.status_code", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
        },
        events: [createExceptionEvent("Error", "boom")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("uses error.type numeric value when exception event triggers inference", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "error.type": "503",
        },
        events: [createExceptionEvent("Error", "service unavailable")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(503);
    });

    it("does NOT override existing 4xx/5xx status code when exception event present", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 422,
        },
        events: [createExceptionEvent("ValidationError", "invalid input")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(422);
    });

    it("does NOT inject status code on non-HTTP span with exception event", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "db.operation": "SELECT",
          "db.sql.table": "users",
        },
        events: [createExceptionEvent("Error", "query failed")],
        instrumentationScope: { name: "@prisma/instrumentation" },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBeUndefined();
    });

    it("infers 500 from exception attributes on span (without events)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "exception.type": "TypeError",
          "exception.message": "Cannot read properties of undefined",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(500);
    });

    it("extracts error details from exception event when not in span attributes", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
        events: [createExceptionEvent("TypeError", "Cannot read properties of undefined (reading 'trim')")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_MESSAGE]).toBe("Cannot read properties of undefined (reading 'trim')");
      expect(enriched.attributes[ATTR.ERROR_CODE]).toBe("TypeError");
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("internal");
    });

    it("prefers span attributes over event attributes for error details", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "exception.type": "ZodError",
          "exception.message": "validation failed",
        },
        events: [createExceptionEvent("TypeError", "different error message")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_MESSAGE]).toBe("validation failed");
      expect(enriched.attributes[ATTR.ERROR_CODE]).toBe("ZodError");
      expect(enriched.attributes[ATTR.ERROR_CATEGORY]).toBe("validation");
    });

    it("does NOT trigger inference when status is explicitly OK", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        status: { code: SpanStatusCode.OK },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
        events: [createExceptionEvent("Error", "handled error")],
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.HTTP_STATUS_CODE]).toBe(200);
      // Error details from events should NOT be extracted for OK spans
      expect(enriched.attributes[ATTR.ERROR_MESSAGE]).toBeUndefined();
      expect(enriched.attributes[ATTR.ERROR_CODE]).toBeUndefined();
    });
  });

  describe("Verbose logging (DISC-1204)", () => {
    it("logs error detection signals when verbose is enabled", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});
      const { exporter } = createExporter({ verbose: true });
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
        events: [createExceptionEvent("TypeError", "boom")],
      });

      exporter.export([span], vi.fn());

      const calls = spy.mock.calls.map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("isErrorByEvent=true"))).toBe(true);
      expect(calls.some((msg) => msg.includes("isErrorByStatus=false"))).toBe(true);

      spy.mockRestore();
    });

    it("does not log inferred status_code when no inference occurs and verbose is enabled", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});
      const { exporter } = createExporter({ verbose: true });
      const span = createMockSpan({
        status: { code: SpanStatusCode.OK },
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const calls = spy.mock.calls.map((c) => c[1]);
      // Should log the detection signals line (always logged for HTTP spans in verbose)
      // but should NOT log the "inferred status_code" line (no inference happened)
      expect(calls.some((msg) => msg.includes("inferred status_code"))).toBe(false);

      spy.mockRestore();
    });

    it("does not log enrichment details when verbose is disabled", () => {
      const spy = vi.spyOn(consoleCapture, "sdkLog").mockImplementation(() => {});
      const { exporter } = createExporter({ verbose: false });
      const span = createMockSpan({
        status: { code: SpanStatusCode.UNSET },
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
        events: [createExceptionEvent("TypeError", "boom")],
      });

      exporter.export([span], vi.fn());

      const calls = spy.mock.calls.map((c) => c[1]);
      expect(calls.some((msg) => msg.includes("enrichSpan"))).toBe(false);

      spy.mockRestore();
    });
  });

  describe("tRPC procedure extraction (DISC-1215)", () => {
    it("extracts procedure name from standard tRPC URL", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.modify?batch=1",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.modify");
    });

    it("extracts dotted procedure name", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/user.settings.get",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("user.settings.get");
    });

    it("captures batched procedure names as comma-separated string", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.list,polls.count?batch=1",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.list,polls.count");
    });

    it("does not set TRPC_PROCEDURE for non-tRPC URLs", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/users",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBeUndefined();
    });

    it("strips query parameters from procedure name", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.get?input=%7B%22id%22%3A1%7D",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.get");
    });

    it("trims trailing slashes from procedure name", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.modify/",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.modify");
    });

    it("does not set attribute for empty procedure name", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBeUndefined();
    });

    it("does not override glasstrace.route (keeps HTTP path)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/api/trpc/[trpc]",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.modify",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ROUTE]).toBe("/api/trpc/[trpc]");
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.modify");
    });

    it("falls back to url.full when http.url is absent", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
          "url.full": "http://localhost:3000/api/trpc/polls.delete",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.delete");
    });

    it("falls back to raw match on malformed percent encoding", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
          "http.url": "http://localhost:3000/api/trpc/polls.%E0%A4%A",
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.TRPC_PROCEDURE]).toBe("polls.%E0%A4%A");
    });
  });

  describe("Error response body passthrough (DISC-1216)", () => {
    it("promotes glasstrace.internal.response_body to glasstrace attribute when config enabled", () => {
      const config = { ...DEFAULT_CONFIG, errorResponseBodies: true };
      const { exporter, delegate } = createExporter();
      Object.defineProperty(exporter, "getConfig", { value: () => config });

      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 403,
          "glasstrace.internal.response_body": '{"error":{"code":"FORBIDDEN","message":"Not allowed"}}',
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_RESPONSE_BODY]).toBe(
        '{"error":{"code":"FORBIDDEN","message":"Not allowed"}}',
      );
    });

    it("does NOT enrich response body when config disabled", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 403,
          "glasstrace.internal.response_body": '{"error":"forbidden"}',
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_RESPONSE_BODY]).toBeUndefined();
    });

    it("truncates response body to 500 characters", () => {
      const config = { ...DEFAULT_CONFIG, errorResponseBodies: true };
      const { exporter, delegate } = createExporter();
      Object.defineProperty(exporter, "getConfig", { value: () => config });

      const longBody = "x".repeat(1000);
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 500,
          "glasstrace.internal.response_body": longBody,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_RESPONSE_BODY]).toBe("x".repeat(500));
    });

    it("ignores non-string response body", () => {
      const config = { ...DEFAULT_CONFIG, errorResponseBodies: true };
      const { exporter, delegate } = createExporter();
      Object.defineProperty(exporter, "getConfig", { value: () => config });

      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.status_code": 500,
          "glasstrace.internal.response_body": 42 as unknown as string,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.ERROR_RESPONSE_BODY]).toBeUndefined();
    });
  });

  describe("Next.js Server Action heuristic (DISC-1253)", () => {
    // Suppress the developer-facing stderr nudge so tests don't pollute
    // test output or depend on nudge state. The heuristic behavior (the
    // attribute) is independent of the nudge firing.
    const ORIGINAL_SUPPRESS = process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;

    beforeEach(() => {
      process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE = "1";
    });

    afterEach(() => {
      if (ORIGINAL_SUPPRESS === undefined) {
        delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
      } else {
        process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE = ORIGINAL_SUPPRESS;
      }
    });

    it("flags POST /login as a Server Action (page route)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/login",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("flags POST /[locale]/login (parameterized page route)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/[locale]/login",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("does NOT flag POST /api/auth (API route prefix)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/api/auth",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("does NOT flag POST /api (exact-match API root)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/api",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("does NOT flag POST /_next/static/... (Next internal route)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/_next/static/chunks/foo.js",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("does NOT flag GET /login (non-POST)", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "GET",
          "http.route": "/login",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("does NOT flag POST /apiary (lookalike page route is not /api/*)", () => {
      // Regression guard against accidental prefix-match bugs — only
      // exact "/api" or "/api/..." should be excluded.
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        attributes: {
          "http.method": "POST",
          "http.route": "/apiary",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      // "/apiary" is a legitimate page route, so it should be flagged.
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("uses http.route when present but falls back to span name for ROUTE", () => {
      // Span name "POST /login" used as fallback when http.route is absent
      // should still be recognized as a page route.
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "/login",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("normalizes 'POST /login' span name (no http.route) as a page route", () => {
      // Regression: when http.route is missing, route falls back to
      // span.name which Next.js formats as "METHOD /path". The heuristic
      // must extract the leading /path token before matching.
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "POST /login",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("normalizes 'POST /api/auth' span name (no http.route) → NOT flagged", () => {
      // Regression guard for Codex-flagged defect: before normalization,
      // a span literally named "POST /api/auth" would slip past the
      // `/api/` prefix check and get incorrectly tagged.
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "POST /api/auth",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("normalizes 'middleware POST /login' span name → flagged", () => {
      // Next.js also emits "middleware POST <path>" span names for
      // middleware execution spans. The leading-path extractor walks
      // tokens until it finds one starting with `/`.
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "middleware POST /login",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBe(true);
    });

    it("normalizes 'middleware POST /_next/data/...' → NOT flagged", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "middleware POST /_next/data/build-id/route.json",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("does NOT flag a span with no path-like token (e.g. plain 'POST')", () => {
      const { exporter, delegate } = createExporter();
      const span = createMockSpan({
        name: "POST",
        attributes: {
          "http.method": "POST",
          "http.status_code": 200,
        },
      });

      exporter.export([span], vi.fn());

      const enriched = delegate.exportedSpans[0][0];
      expect(enriched.attributes[ATTR.NEXT_ACTION_DETECTED]).toBeUndefined();
    });

    it("fires the nudge when heuristic matches AND correlation.id is absent", async () => {
      // Clear the env-var silencer we set in beforeEach so we can observe
      // the nudge, then reload the nudge module to clear the module-level
      // hasFired guard.
      delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
      delete process.env.NODE_ENV;
      delete process.env.VERCEL_ENV;

      const nudgeMod = await import("../../../packages/sdk/src/nudge/error-nudge.js");
      nudgeMod.__resetNudgeStateForTests();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      try {
        const { exporter } = createExporter();
        const span = createMockSpan({
          attributes: {
            "http.method": "POST",
            "http.route": "/login",
            "http.status_code": 200,
          },
        });

        exporter.export([span], vi.fn());

        const calls = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((msg) => msg.includes("Server Action"));
        expect(calls.length).toBe(1);
        expect(calls[0]).toContain("glasstrace.dev/ext");
      } finally {
        stderrSpy.mockRestore();
        nudgeMod.__resetNudgeStateForTests();
      }
    });

    it("does NOT fire the nudge when correlation.id is present on the span", async () => {
      delete process.env.GLASSTRACE_SUPPRESS_ACTION_NUDGE;
      delete process.env.NODE_ENV;
      delete process.env.VERCEL_ENV;

      const nudgeMod = await import("../../../packages/sdk/src/nudge/error-nudge.js");
      nudgeMod.__resetNudgeStateForTests();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      try {
        const { exporter } = createExporter();
        const span = createMockSpan({
          attributes: {
            "http.method": "POST",
            "http.route": "/login",
            "http.status_code": 200,
            "glasstrace.correlation.id": "cid_test_12345",
          },
        });

        exporter.export([span], vi.fn());

        const calls = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((msg) => msg.includes("Server Action"));
        expect(calls.length).toBe(0);
      } finally {
        stderrSpy.mockRestore();
        nudgeMod.__resetNudgeStateForTests();
      }
    });
  });

  describe("extractLeadingPath (DISC-1253 helper)", () => {
    it("returns bare paths unchanged", () => {
      expect(extractLeadingPath("/login")).toBe("/login");
      expect(extractLeadingPath("/[locale]/login")).toBe("/[locale]/login");
      expect(extractLeadingPath("/api/auth")).toBe("/api/auth");
    });

    it("strips a leading method token from 'METHOD /path' spans", () => {
      expect(extractLeadingPath("POST /login")).toBe("/login");
      expect(extractLeadingPath("GET /api/users")).toBe("/api/users");
    });

    it("walks to the first /-prefixed token in multi-word span names", () => {
      expect(extractLeadingPath("middleware POST /login")).toBe("/login");
      expect(extractLeadingPath("GET RSC /page")).toBe("/page");
    });

    it("returns undefined for empty, whitespace-only, or non-path inputs", () => {
      expect(extractLeadingPath(undefined)).toBeUndefined();
      expect(extractLeadingPath("")).toBeUndefined();
      expect(extractLeadingPath("   ")).toBeUndefined();
      expect(extractLeadingPath("POST")).toBeUndefined();
      expect(extractLeadingPath("no path here")).toBeUndefined();
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(extractLeadingPath("  /login  ")).toBe("/login");
      expect(extractLeadingPath("  POST /login  ")).toBe("/login");
    });
  });

});
