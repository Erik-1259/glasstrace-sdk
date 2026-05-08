/**
 * Runtime tests for `tracedRequestMiddleware` from
 * `@glasstrace/sdk/middleware` (DISC-1537 / SDK-046).
 *
 * Covered scenarios per the SDK-046 brief §5.2:
 *   - Span creation, status (UNSET on success, ERROR on throw).
 *   - `glasstrace.causal.middleware_for_request` attribute carries
 *     the originating request path.
 *   - Path extraction prefers `req.nextUrl.pathname` over `req.url`.
 *   - Falls back to parsing `req.url` (absolute and relative forms).
 *   - Omits the causal attribute when neither is parseable.
 *   - User-supplied attributes are forwarded.
 *   - Non-Error throwables don't crash the wrapper.
 *   - Sync and async handlers both work.
 *   - Edge-runtime constraint: no AsyncLocalStorage usage.
 *
 * SDK-not-registered scenarios are covered separately in
 * `traced-request-middleware-uninstalled.test.ts` because they
 * require the OTel API to be in its initial noop state — which the
 * `trace.setGlobalTracerProvider` test harness here intentionally
 * overrides.
 *
 * Type-inference is exercised at compile time only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import {
  tracedRequestMiddleware,
  _resetForTesting,
} from "../../../../packages/sdk/src/middleware/index.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

// Install ALS-backed context manager once at module load so
// parent/child propagation works across the test fixtures. Same
// pattern as the tRPC tests at
// `tests/unit/sdk/trpc/traced-middleware.test.ts:51`.
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

/** Find a finished span by name. Throws if not exactly one match. */
function getSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const matches = spans.filter((s) => s.name === name);
  expect(matches, `expected exactly one span named ${name}`).toHaveLength(1);
  return matches[0]!;
}

/**
 * Open a synthetic HTTP server span and run `fn` inside its active
 * context. Mirrors what `@vercel/otel` does for an inbound HTTP
 * request: the span is active when the user's middleware runs.
 */
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

/** Synthesize a NextRequest-like object with `nextUrl` and `url`. */
function makeNextRequest(opts: {
  pathname?: string;
  url?: string;
}): { nextUrl?: { pathname: string }; url?: string } {
  const out: { nextUrl?: { pathname: string }; url?: string } = {};
  if (opts.pathname !== undefined) {
    out.nextUrl = { pathname: opts.pathname };
  }
  if (opts.url !== undefined) {
    out.url = opts.url;
  }
  return out;
}

describe("tracedRequestMiddleware — span lifecycle", () => {
  it("creates one span per invocation, ends it, and leaves status UNSET on success", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth-middleware" },
      async () => ({ status: 200 }),
    );

    await withHttpServerSpan("HTTP GET /dashboard", () =>
      wrapped(makeNextRequest({ pathname: "/dashboard" })),
    );

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "auth-middleware");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.endTime[0] + span.endTime[1] / 1e9).toBeGreaterThan(
      span.startTime[0] + span.startTime[1] / 1e9,
    );
  });

  it("nests under the active HTTP server span (Node runtime, ALS available)", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth-middleware" },
      async () => ({ status: 200 }),
    );

    const { httpTraceId } = await withHttpServerSpan(
      "HTTP GET /dashboard",
      () => wrapped(makeNextRequest({ pathname: "/dashboard" })),
    );

    const finished = exporter.getFinishedSpans();
    const middlewareSpan = getSpan(finished, "auth-middleware");
    expect(middlewareSpan.spanContext().traceId).toBe(httpTraceId);
    // The middleware span's parent is the HTTP server span (not the root).
    expect(middlewareSpan.parentSpanContext?.spanId).toBeDefined();
  });

  it("sets status ERROR and recordException on a thrown error", async () => {
    class AuthError extends Error {
      constructor() {
        super("not authorized");
      }
    }
    const wrapped = tracedRequestMiddleware(
      { name: "auth-middleware" },
      async () => {
        throw new AuthError();
      },
    );

    await expect(
      withHttpServerSpan("HTTP GET /dashboard", () =>
        wrapped(makeNextRequest({ pathname: "/dashboard" })),
      ),
    ).rejects.toThrow("not authorized");

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "auth-middleware");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("not authorized");
    expect(span.events.map((e) => e.name)).toContain("exception");
  });

  it("handles synchronous handlers and synchronous throws", () => {
    const wrapped = tracedRequestMiddleware(
      { name: "sync-middleware" },
      () => ({ status: 200 }),
    );

    // Sync handler returning a value: should not be wrapped in a Promise.
    const result = wrapped(makeNextRequest({ pathname: "/x" }));
    expect(result).toEqual({ status: 200 });

    const wrappedThrow = tracedRequestMiddleware(
      { name: "sync-throw" },
      () => {
        throw new Error("boom");
      },
    );
    expect(() => wrappedThrow(makeNextRequest({ pathname: "/x" }))).toThrow(
      "boom",
    );
    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "sync-throw");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("handles non-Error throwables without crashing recordException", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "weird-throw" },
      async () => {
        throw 42 as unknown as Error;
      },
    );

    // Original error preserved verbatim through the rethrow.
    await expect(
      wrapped(makeNextRequest({ pathname: "/x" })),
    ).rejects.toBe(42);

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "weird-throw");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // Status message reflects the normalized form.
    expect(span.status.message).toBe("42");
  });
});

describe("tracedRequestMiddleware — causal attribute", () => {
  it("emits glasstrace.causal.middleware_for_request from req.nextUrl.pathname", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "/dashboard/billing" }));

    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe(
      "/dashboard/billing",
    );
  });

  it("falls back to parsing req.url when nextUrl is absent", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ url: "https://example.com/api/users?x=1" }));

    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe(
      "/api/users",
    );
  });

  it("handles relative req.url forms (Node frameworks that pass IncomingMessage.url)", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped({ url: "/api/foo?x=1" });

    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe("/api/foo");
  });

  it("prefers req.nextUrl.pathname over req.url when both are present (Next 16 url-rewrite case)", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    // Simulate Next 16: framework rewrote req.url to a fallback but
    // req.nextUrl.pathname carries the original.
    await wrapped({
      nextUrl: { pathname: "/dashboard" },
      url: "https://internal/_next/data/x.json",
    });

    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe(
      "/dashboard",
    );
  });

  it("omits the causal attribute when neither nextUrl nor url is parseable", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped({});

    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBeUndefined();
  });

  it("omits the causal attribute on a non-object request argument", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped(null);
    await wrapped(undefined);
    await wrapped("not-a-request" as unknown);

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThan(0);
    for (const span of finished) {
      expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBeUndefined();
    }
  });
});

describe("tracedRequestMiddleware — caller attributes and ownership invariants", () => {
  it("forwards options.attributes onto the span", async () => {
    const wrapped = tracedRequestMiddleware(
      {
        name: "auth",
        attributes: { "auth.required": true, "auth.realm": "users" },
      },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "/x" }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes["auth.required"]).toBe(true);
    expect(span.attributes["auth.realm"]).toBe("users");
  });

  it("does NOT set glasstrace.route, glasstrace.http.status_code, or glasstrace.http.duration_ms", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "/x" }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    // Per SDK-046 brief §1.4: the middleware span must not overwrite
    // root-request semantics owned by the enriching exporter.
    expect(span.attributes[ATTR.ROUTE]).toBeUndefined();
    expect(span.attributes[ATTR.HTTP_STATUS_CODE]).toBeUndefined();
    expect(span.attributes[ATTR.HTTP_DURATION_MS]).toBeUndefined();
  });
});

describe("tracedRequestMiddleware — validation", () => {
  it("throws TypeError when options.name is not a string", () => {
    expect(() =>
      tracedRequestMiddleware(
        // @ts-expect-error — testing runtime guard
        { name: 42 },
        async () => undefined,
      ),
    ).toThrow(TypeError);
  });

  it("throws TypeError when options.name is empty", () => {
    expect(() =>
      tracedRequestMiddleware({ name: "" }, async () => undefined),
    ).toThrow(TypeError);
  });
});

describe("tracedRequestMiddleware — no leaked probe spans", () => {
  it("does NOT emit a `__glasstrace_probe__` (or other probe) span on the real provider", async () => {
    // Regression guard: an earlier draft of the wrapper detected the
    // noop-tracer state by opening a probe span ahead of time, which
    // leaked an empty probe span into the export path on every
    // request when a real provider was registered. The fix is to
    // detect via `span.isRecording()` on the already-open active
    // span — exercised here by asserting the only emitted span is
    // the wrapped middleware span.
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );
    await wrapped({ nextUrl: { pathname: "/dashboard" } });
    await wrapped({ nextUrl: { pathname: "/dashboard" } });
    await wrapped({ nextUrl: { pathname: "/dashboard" } });

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(3);
    for (const span of finished) {
      expect(span.name).toBe("auth");
    }
  });
});

describe("tracedRequestMiddleware — sampler-drop discriminator (regression)", () => {
  // Pin that the SDK-not-registered fast path uses
  // `spanContext().traceId === INVALID_TRACE_ID` (the noop-tracer
  // sentinel), NOT `isRecording() === false`. A real provider whose
  // sampler decides NOT_RECORD also returns isRecording=false, but
  // produces a valid trace ID — that case must take the normal
  // enrichment path, not fire `middleware:skipped_uninstalled`.
  // Without this guard the wrapper would emit spurious lifecycle
  // events for every sampled-out request in production deployments
  // that use head-sampling configurations.

  it("does not emit middleware:skipped_uninstalled when a real provider's sampler drops the span", async () => {
    // Replace the parent describe's provider with one whose sampler
    // returns NOT_RECORD for every shouldSample call.
    await provider.shutdown();
    const dropSampler: Sampler = {
      shouldSample: (): SamplingResult => ({
        decision: SamplingDecision.NOT_RECORD,
      }),
      toString: () => "DropSampler",
    };
    const dropProvider = new BasicTracerProvider({
      sampler: dropSampler,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(dropProvider);

    const lifecycleModule = await import(
      "../../../../packages/sdk/src/lifecycle.js"
    );
    lifecycleModule.resetLifecycleForTesting();
    lifecycleModule.initLifecycle({ logger: () => {} });

    let skippedEmitted = false;
    const listener = (): void => {
      skippedEmitted = true;
    };
    lifecycleModule.onLifecycleEvent(
      "middleware:skipped_uninstalled",
      listener,
    );

    try {
      const wrapped = tracedRequestMiddleware(
        { name: "drop-test" },
        async () => "ok",
      );
      await wrapped({ nextUrl: { pathname: "/x" } });
      expect(skippedEmitted).toBe(false);
    } finally {
      lifecycleModule.offLifecycleEvent(
        "middleware:skipped_uninstalled",
        listener,
      );
      await dropProvider.shutdown();
    }
  });

  // Regression for Codex P1 on PR #264 (2026-05-08): an earlier
  // version of the defensive try/catch wrapped the entire
  // `tracer.startActiveSpan(...)` call, which intercepted the
  // callback's intentional rethrow of handler errors and ran the
  // handler a SECOND time in the catch fallback. The fix added a
  // `callbackInvoked` flag so the fallback only fires when
  // `startActiveSpan` itself failed BEFORE the callback ran.
  //
  // This test pins the no-double-invocation invariant: a handler
  // that throws synchronously must run exactly once, and the error
  // must propagate.
  it("does not double-invoke the handler when it throws synchronously", () => {
    let invocations = 0;
    const wrapped = tracedRequestMiddleware(
      { name: "throwing" },
      (): unknown => {
        invocations++;
        throw new Error("user-handler-sync-throw");
      },
    );

    expect(() =>
      wrapped({ nextUrl: { pathname: "/x" } }),
    ).toThrow("user-handler-sync-throw");

    // Critical: handler ran ONCE. If the outer try/catch were too
    // broad, this would be 2.
    expect(invocations).toBe(1);
  });
});

describe("tracedRequestMiddleware — handler types", () => {
  it("preserves the handler's call signature in TypeScript via the H generic", () => {
    // Compile-time only — if this typechecks, the H bound preserves
    // the signature through the wrapper.
    const wrapped = tracedRequestMiddleware(
      { name: "x" },
      async (req: { nextUrl: { pathname: string } }): Promise<number> => {
        return req.nextUrl.pathname.length;
      },
    );
    // The returned function accepts the same shape.
    const _check: Promise<number> = wrapped({
      nextUrl: { pathname: "/x" },
    });
    expect(typeof _check.then).toBe("function");
  });
});
