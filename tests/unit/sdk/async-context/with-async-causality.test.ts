/**
 * Runtime tests for `withAsyncCausality` from
 * `@glasstrace/sdk/async-context` (DISC-1539 / SDK-046).
 *
 * Covered scenarios per the SDK-046 brief §5.3:
 *   - Capture inside an active request span; async span carries
 *     `glasstrace.causal.post_response_async` with the originating
 *     trace ID, plus the `affects_http_*` companion booleans.
 *   - Span links surface in the `links` array (OTel-native form).
 *   - Capture outside any active span: callback still runs; no
 *     causal attribute; lifecycle event fires once.
 *   - Wrapped callback throws: ERROR status + recordException; rethrow.
 *   - Two concurrent captures with different originating traces
 *     produce non-cross-contaminated async spans.
 *   - Async span is a NEW root span (not parented to the originating
 *     trace's HTTP span).
 *   - Validation: invalid `name` and non-function `fn` throw.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import {
  withAsyncCausality,
  _resetForTesting,
} from "../../../../packages/sdk/src/async-context/index.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  _resetForTesting();
  exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  provider = new BasicTracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

function getSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const matches = spans.filter((s) => s.name === name);
  expect(matches, `expected exactly one span named ${name}`).toHaveLength(1);
  return matches[0]!;
}

async function withHttpServerSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
): Promise<{ result: T; httpTraceId: string }> {
  const tracer = trace.getTracer("test-http");
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.SERVER },
    async (span) => {
      const httpTraceId = span.spanContext().traceId;
      try {
        const result = await fn();
        return { result, httpTraceId };
      } finally {
        span.end();
      }
    },
  );
}

describe("withAsyncCausality — captured-context happy path", () => {
  it("attaches glasstrace.causal.post_response_async + Link to the originating trace", async () => {
    let asyncContinuation: (() => Promise<unknown>) | undefined;
    const { httpTraceId } = await withHttpServerSpan(
      "HTTP POST /api/orders",
      () => {
        asyncContinuation = withAsyncCausality(
          { name: "send-confirmation-email" },
          async () => "sent",
        );
      },
    );

    expect(asyncContinuation).toBeDefined();
    // Run the continuation AFTER the request span has ended — that's
    // the entire point of post-response work.
    const result = await asyncContinuation!();
    expect(result).toBe("sent");

    const finished = exporter.getFinishedSpans();
    const asyncSpan = getSpan(finished, "send-confirmation-email");
    expect(asyncSpan.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC]).toBe(
      httpTraceId,
    );
    expect(asyncSpan.attributes[ATTR.CAUSAL_AFFECTS_HTTP_STATUS]).toBe(false);
    expect(asyncSpan.attributes[ATTR.CAUSAL_AFFECTS_HTTP_DURATION]).toBe(false);
    // OTel Link on the async span pointing back to the originating
    // request's HTTP server span.
    expect(asyncSpan.links).toHaveLength(1);
    expect(asyncSpan.links[0]!.context.traceId).toBe(httpTraceId);
  });

  it("emits the async span as a NEW ROOT (not a child of the originating span)", async () => {
    let asyncContinuation: (() => Promise<unknown>) | undefined;
    const { httpTraceId } = await withHttpServerSpan(
      "HTTP POST /api/orders",
      () => {
        asyncContinuation = withAsyncCausality(
          { name: "send-email" },
          async () => undefined,
        );
      },
    );
    await asyncContinuation!();

    const asyncSpan = getSpan(exporter.getFinishedSpans(), "send-email");
    // Per the SDK-046 design: the async span is in a different
    // trace from the originating request. Causality is communicated
    // via the Link + attribute pair.
    expect(asyncSpan.spanContext().traceId).not.toBe(httpTraceId);
    expect(asyncSpan.parentSpanContext).toBeUndefined();
  });

  it("forwards options.attributes onto the async span", async () => {
    let cont: (() => Promise<unknown>) | undefined;
    await withHttpServerSpan("HTTP", () => {
      cont = withAsyncCausality(
        { name: "task", attributes: { "task.kind": "email" } },
        async () => undefined,
      );
    });
    await cont!();

    const span = getSpan(exporter.getFinishedSpans(), "task");
    expect(span.attributes["task.kind"]).toBe("email");
  });

  it("two concurrent captures with different originating traces produce isolated async spans", async () => {
    const captures: Array<{
      cont: () => Promise<unknown>;
      httpTraceId: string;
    }> = [];

    // Two parallel "requests", each captures its own continuation.
    await Promise.all([
      withHttpServerSpan("HTTP-A", () => {
        const cont = withAsyncCausality(
          { name: "task-A" },
          async () => "A-done",
        );
        // Reading the trace id off the active span at this point.
        const httpTraceId = trace.getActiveSpan()!.spanContext().traceId;
        captures.push({ cont, httpTraceId });
      }),
      withHttpServerSpan("HTTP-B", () => {
        const cont = withAsyncCausality(
          { name: "task-B" },
          async () => "B-done",
        );
        const httpTraceId = trace.getActiveSpan()!.spanContext().traceId;
        captures.push({ cont, httpTraceId });
      }),
    ]);

    // Run both continuations later, in reverse order.
    await captures[1]!.cont();
    await captures[0]!.cont();

    const finished = exporter.getFinishedSpans();
    const asyncA = getSpan(finished, "task-A");
    const asyncB = getSpan(finished, "task-B");
    expect(asyncA.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC]).toBe(
      captures.find((c) => c.cont === captures[0]!.cont)!.httpTraceId,
    );
    expect(asyncB.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC]).toBe(
      captures.find((c) => c.cont === captures[1]!.cont)!.httpTraceId,
    );
    // Sanity: traces differ.
    expect(asyncA.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC]).not.toBe(
      asyncB.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC],
    );
  });
});

describe("withAsyncCausality — captured-context error paths", () => {
  it("sets ERROR status + recordException when fn throws and rethrows", async () => {
    let cont: (() => Promise<unknown>) | undefined;
    await withHttpServerSpan("HTTP", () => {
      cont = withAsyncCausality({ name: "task" }, async () => {
        throw new Error("nope");
      });
    });

    await expect(cont!()).rejects.toThrow("nope");
    const span = getSpan(exporter.getFinishedSpans(), "task");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("nope");
    expect(span.events.map((e) => e.name)).toContain("exception");
  });

  it("handles non-Error throwables", async () => {
    let cont: (() => Promise<unknown>) | undefined;
    await withHttpServerSpan("HTTP", () => {
      cont = withAsyncCausality({ name: "task" }, async () => {
        throw "plain string" as unknown as Error;
      });
    });

    await expect(cont!()).rejects.toBe("plain string");
    const span = getSpan(exporter.getFinishedSpans(), "task");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("plain string");
  });
});

describe("withAsyncCausality — no originating context", () => {
  it("runs the callback with no causal attribute, no Link", async () => {
    // Capture is performed OUTSIDE any active request span.
    const cont = withAsyncCausality(
      { name: "orphan-task" },
      async () => "ok",
    );
    const result = await cont();
    expect(result).toBe("ok");

    const span = getSpan(exporter.getFinishedSpans(), "orphan-task");
    expect(span.attributes[ATTR.CAUSAL_POST_RESPONSE_ASYNC]).toBeUndefined();
    expect(
      span.attributes[ATTR.CAUSAL_AFFECTS_HTTP_STATUS],
    ).toBeUndefined();
    expect(
      span.attributes[ATTR.CAUSAL_AFFECTS_HTTP_DURATION],
    ).toBeUndefined();
    expect(span.links).toHaveLength(0);
  });

  it("supports synchronous fn and wraps the value in Promise.resolve", async () => {
    const cont = withAsyncCausality(
      { name: "sync-task" },
      () => 99,
    );
    await expect(cont()).resolves.toBe(99);
  });
});

describe("withAsyncCausality — no leaked probe spans", () => {
  it("does NOT emit a `__glasstrace_probe__` (or other probe) span on the real provider", async () => {
    let cont: (() => Promise<unknown>) | undefined;
    await withHttpServerSpan("HTTP", () => {
      cont = withAsyncCausality({ name: "task" }, async () => 1);
    });
    await cont!();
    await cont!();

    const finished = exporter.getFinishedSpans();
    // Exactly the originating HTTP span + two async spans.
    const names = finished.map((s) => s.name).sort();
    expect(names).toEqual(["HTTP", "task", "task"]);
  });
});

describe("withAsyncCausality — validation", () => {
  it("throws TypeError when options.name is empty", () => {
    expect(() =>
      withAsyncCausality({ name: "" }, async () => undefined),
    ).toThrow(TypeError);
  });

  it("throws TypeError when options.name is not a string", () => {
    expect(() =>
      withAsyncCausality(
        // @ts-expect-error — testing runtime guard
        { name: 42 },
        async () => undefined,
      ),
    ).toThrow(TypeError);
  });

  it("throws TypeError when fn is not a function", () => {
    expect(() =>
      withAsyncCausality(
        { name: "x" },
        // @ts-expect-error — testing runtime guard
        "not-a-fn",
      ),
    ).toThrow(TypeError);
  });
});
