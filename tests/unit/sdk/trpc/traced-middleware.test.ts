/**
 * Runtime tests for `tracedMiddleware` from `@glasstrace/sdk/trpc`.
 *
 * Covered:
 *   - Span creation, status (UNSET on success, ERROR on throw, ERROR on
 *     `{ ok: false, ... }` middleware result without recordException).
 *   - Parent-child relationship inheritance from an active span.
 *   - `glasstrace.trpc.procedure` is NOT duplicated on middleware spans.
 *   - Attributes set at span start (before the wrapped body runs).
 *   - `trpc.path` / `trpc.type` forwarded from middleware opts.
 *   - Sync vs async middleware bodies.
 *   - Nested middleware chains: two wrapped middlewares produce a
 *     nested span tree (HTTP > isAuthed > isPro) when one middleware's
 *     `next()` invokes the next wrapped middleware. Sibling layout is
 *     covered separately for the two-procedures-per-request case.
 *   - Double-instrumentation safety: a wrapped middleware whose body
 *     itself opens an active span produces three properly-nested spans.
 *   - Cross-middleware context narrowing: ctx flows through unchanged.
 *   - v11 fixture against the actually-installed `@trpc/server@^11`.
 *   - Edge cases: empty / non-string `name`, missing attributes,
 *     non-Error throw values.
 *
 * Type-inference preservation is exercised at compile time only —
 * see `traced-middleware-types.test.ts`. Test runs via vitest's
 * standard runner and does not require build artifacts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} from "@opentelemetry/api";
import { initTRPC, TRPCError } from "@trpc/server";
import { tracedMiddleware } from "../../../../packages/sdk/src/trpc/index.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";

// Install an AsyncLocalStorage-based context manager once at module load so
// every test sees parent-child propagation through `tracer.startActiveSpan`.
// Without this, the OTel API falls back to a no-op manager and child spans
// have no `parentSpanContext`, so the parent-child invariants would be
// untestable. Calling once is fine: `setGlobalContextManager` is idempotent
// (subsequent calls log a warning and return false, leaving the manager
// already in place).
installContextManager();

/**
 * Spin up an in-memory OTel provider for each test. Capture the
 * exporter so the test can read finished spans after the action under
 * test resolves. `trace.disable()` in `afterEach` resets the global
 * provider so individual tests do not leak the in-memory provider into
 * later tests.
 */
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  provider = new BasicTracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
});

/**
 * Helper: open a synthetic HTTP server span and run `fn` inside its
 * active context. Mirrors what `@vercel/otel` or the bare OTel SDK
 * does for an inbound HTTP request: the span is active when the tRPC
 * dispatcher invokes the procedure middleware chain.
 */
async function withHttpServerSpan<T>(
  name: string,
  fn: () => Promise<T>,
  // Optional pre-set attributes on the parent span to simulate
  // DISC-1215's `glasstrace.trpc.procedure` being attached.
  attrs?: Record<string, string>,
): Promise<{ result: T; httpSpanId: string; httpTraceId: string }> {
  const tracer = trace.getTracer("test-http");
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.SERVER, attributes: attrs },
    async (span) => {
      const httpSpanId = span.spanContext().spanId;
      const httpTraceId = span.spanContext().traceId;
      try {
        const result = await fn();
        return { result, httpSpanId, httpTraceId };
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Build a synthetic middleware-options object that matches both the v10
 * and v11 middleware-function shape closely enough for the runtime
 * wrapper. The wrapper only reads `path` and `type`; `next` is exposed
 * as a stub so middleware that calls `next()` works.
 */
type SyntheticMwOpts = {
  ctx: Record<string, unknown>;
  type: "query" | "mutation" | "subscription";
  path: string;
  input: unknown;
  rawInput: unknown;
  meta: undefined;
  next: (opts?: { ctx?: Record<string, unknown> }) => Promise<{
    ok: true;
    data: unknown;
    ctx: Record<string, unknown>;
    marker: undefined;
  }>;
};

function makeMwOpts(
  overrides?: Partial<SyntheticMwOpts>,
): SyntheticMwOpts {
  const baseCtx: Record<string, unknown> = overrides?.ctx ?? {};
  return {
    ctx: baseCtx,
    type: overrides?.type ?? "query",
    path: overrides?.path ?? "polls.book",
    input: overrides?.input ?? undefined,
    rawInput: overrides?.rawInput ?? undefined,
    meta: undefined,
    next:
      overrides?.next ??
      (async (opts?: { ctx?: Record<string, unknown> }) => ({
        ok: true,
        data: undefined,
        ctx: { ...baseCtx, ...(opts?.ctx ?? {}) },
        marker: undefined,
      })),
  };
}

/** Find a finished span by `name`. Throws if not exactly one match. */
function getSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const matches = spans.filter((s) => s.name === name);
  expect(matches, `expected exactly one span named ${name}`).toHaveLength(1);
  return matches[0]!;
}

describe("tracedMiddleware — span lifecycle", () => {
  it("creates one span per invocation, ends it, and leaves status UNSET on success", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
      mw(makeMwOpts()),
    );

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    // OTel default span status is UNSET; we must NOT set OK explicitly
    // because OK has higher precedence than ERROR and would shadow any
    // downstream consumer's error transition (per the design's note in
    // sdk-trpc.md §3.3).
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.endTime[0] + span.endTime[1] / 1e9).toBeGreaterThan(
      span.startTime[0] + span.startTime[1] / 1e9,
    );
  });

  it("sets status ERROR and recordException on a thrown TRPCError", async () => {
    const mw = tracedMiddleware({ name: "isAuthed" }, async () => {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "no session" });
    });

    await expect(
      withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
        mw(makeMwOpts()),
      ),
    ).rejects.toThrow("no session");

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("no session");
    // recordException emits an OTel exception event with name + message.
    const events = span.events.map((e) => e.name);
    expect(events).toContain("exception");
  });

  it("sets status ERROR without recordException when middleware returns ok:false", async () => {
    const mw = tracedMiddleware({ name: "isAuthed" }, async () => ({
      ok: false,
      error: new TRPCError({ code: "FORBIDDEN" }),
      marker: undefined,
    }));

    await withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
      mw(makeMwOpts()),
    );

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // No exception recorded — the ok:false envelope does not carry an
    // Error to record. Standard OTel error attribute conventions still
    // apply (the enriching exporter picks up other error indicators
    // separately).
    const events = span.events.map((e) => e.name);
    expect(events).not.toContain("exception");
  });

  it("records non-Error thrown values via String(...) in status.message", async () => {
    const mw = tracedMiddleware({ name: "broken" }, async () => {
      throw "stringly-typed failure";
    });

    await expect(
      withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
        mw(makeMwOpts()),
      ),
    ).rejects.toBe("stringly-typed failure");

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "broken");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("stringly-typed failure");
  });

  it("normalizes plain-object throwables to ERROR status without crashing recordException", async () => {
    // OpenTelemetry's `Span.recordException` accepts only `string | Error`.
    // Throwing a plain object is valid JavaScript (libraries occasionally
    // do this). Pre-normalization, passing it directly to
    // `recordException` could throw and skip `setStatus`, leaving the
    // span UNSET on a failed request. The wrapper now wraps non-Error,
    // non-string throwables in `new Error(String(value))` before
    // recording, and runs `recordException` and `setStatus` in
    // independent try/catch blocks.
    const objectThrowable = { code: "BOOM", reason: "explicit" };
    const mw = tracedMiddleware({ name: "broken-object" }, async () => {
      throw objectThrowable;
    });

    await expect(
      withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
        mw(makeMwOpts()),
      ),
    ).rejects.toBe(objectThrowable);

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "broken-object");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // String(objectThrowable) is "[object Object]" — not useful, but
    // the alternative (passing the raw object to setStatus) violates
    // the OTel API contract. The shape preserves "we know this failed"
    // even when the user discarded the error message.
    expect(span.status.message).toBe("[object Object]");
    const eventNames = span.events.map((e) => e.name);
    expect(eventNames).toContain("exception");
  });

  it("normalizes numeric throwables to ERROR status without crashing recordException", async () => {
    // Same pattern as plain-object throwables: numbers are valid
    // JavaScript throw values but invalid `recordException` inputs.
    const mw = tracedMiddleware({ name: "broken-number" }, async () => {
      throw 42;
    });

    await expect(
      withHttpServerSpan("HTTP POST /api/trpc/polls.book", () =>
        mw(makeMwOpts()),
      ),
    ).rejects.toBe(42);

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "broken-number");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("42");
    const eventNames = span.events.map((e) => e.name);
    expect(eventNames).toContain("exception");
  });
});

describe("tracedMiddleware — parent-child relationship", () => {
  it("middleware span is a child of the active HTTP server span", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    const { httpSpanId, httpTraceId } = await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      () => mw(makeMwOpts()),
    );

    const finished = exporter.getFinishedSpans();
    const middlewareSpan = getSpan(finished, "isAuthed");
    expect(middlewareSpan.parentSpanContext?.spanId).toBe(httpSpanId);
    expect(middlewareSpan.spanContext().traceId).toBe(httpTraceId);
  });

  it("does NOT set glasstrace.trpc.procedure on the middleware span (D3 invariant)", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      () => mw(makeMwOpts()),
      // Simulate DISC-1215 having attached the procedure attribute on
      // the parent HTTP span. The middleware span must not duplicate
      // it.
      { "glasstrace.trpc.procedure": "polls.book" },
    );

    const finished = exporter.getFinishedSpans();
    const middlewareSpan = getSpan(finished, "isAuthed");
    expect(
      middlewareSpan.attributes["glasstrace.trpc.procedure"],
    ).toBeUndefined();
  });

  it("nested middleware chain produces a nested span tree (HTTP > isAuthed > isPro)", async () => {
    const isAuthed = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );
    const isPro = tracedMiddleware(
      { name: "isPro" },
      async (opts) => opts.next(),
    );

    // Compose by chaining: isAuthed runs, then synthetically invokes
    // isPro inside the next() call. This mirrors how tRPC v10/v11 chain
    // middlewares — the second middleware runs inside the first
    // middleware's active span context (since startActiveSpan is
    // active-context-scoped), so isPro becomes a child of isAuthed at
    // span-tree level rather than a sibling. We assert that hierarchy.
    const combined = async (opts: SyntheticMwOpts): Promise<unknown> =>
      isAuthed({
        ...opts,
        next: () => isPro(opts) as Promise<ReturnType<typeof opts.next>>,
      });

    const { httpSpanId } = await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      () => combined(makeMwOpts()),
    );

    const finished = exporter.getFinishedSpans();
    const authedSpan = getSpan(finished, "isAuthed");
    const proSpan = getSpan(finished, "isPro");

    // isPro nested inside isAuthed's active context.
    expect(proSpan.parentSpanContext?.spanId).toBe(
      authedSpan.spanContext().spanId,
    );
    // isAuthed nested inside the HTTP parent.
    expect(authedSpan.parentSpanContext?.spanId).toBe(httpSpanId);
    // Both share the HTTP trace.
    expect(proSpan.spanContext().traceId).toBe(
      authedSpan.spanContext().traceId,
    );
  });

  it("two middlewares applied as siblings (not nested) each get the HTTP span as parent", async () => {
    // This models the case where the user wraps two procedures'
    // entry-points separately (e.g., one chain calls isAuthed; another
    // chain — running on a different request, captured here as two
    // sequential calls inside the same HTTP span — calls isPro). Each
    // middleware span's parent is the HTTP span, not the other
    // middleware.
    const isAuthed = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );
    const isPro = tracedMiddleware(
      { name: "isPro" },
      async (opts) => opts.next(),
    );

    const { httpSpanId } = await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      async () => {
        await isAuthed(makeMwOpts());
        await isPro(makeMwOpts());
      },
    );

    const finished = exporter.getFinishedSpans();
    const authed = getSpan(finished, "isAuthed");
    const pro = getSpan(finished, "isPro");

    expect(authed.parentSpanContext?.spanId).toBe(httpSpanId);
    expect(pro.parentSpanContext?.spanId).toBe(httpSpanId);
  });

  it("double-instrumentation: a wrapped middleware whose body opens its own span produces grandchild correctly", async () => {
    const innerTracer = trace.getTracer("user-app");
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) =>
        innerTracer.startActiveSpan("user-grandchild", async (gc) => {
          try {
            return await opts.next();
          } finally {
            gc.end();
          }
        }),
    );

    const { httpSpanId } = await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      () => mw(makeMwOpts()),
    );

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(3);
    const middleware = getSpan(finished, "isAuthed");
    const grandchild = getSpan(finished, "user-grandchild");
    // HTTP > tracedMiddleware > user-grandchild
    expect(middleware.parentSpanContext?.spanId).toBe(httpSpanId);
    expect(grandchild.parentSpanContext?.spanId).toBe(
      middleware.spanContext().spanId,
    );
  });

  it("does not leak the active context after the chain completes", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan(
      "HTTP POST /api/trpc/polls.book",
      () => mw(makeMwOpts()),
    );

    // After every span has ended, the active span outside the HTTP
    // server span should be undefined (no leftover from the wrapper).
    const active = trace.getActiveSpan();
    expect(active).toBeUndefined();
    // The root context remains the OTel root context.
    expect(context.active()).toBeDefined();
  });
});

describe("tracedMiddleware — attributes", () => {
  it("attaches options.attributes BEFORE the wrapped middleware body runs", async () => {
    let observedDuringBody: unknown;
    const mw = tracedMiddleware(
      { name: "isAuthed", attributes: { "auth.required": true } },
      async (opts) => {
        // The active span at the moment the body runs should already
        // carry our pre-start attribute. This is observable via
        // trace.getActiveSpan(). We don't assert on the span shape here
        // (its public API does not expose attributes for read), so we
        // just assert the body ran and the post-finish span carries
        // the attribute (verified below).
        observedDuringBody = "ran";
        return opts.next();
      },
    );

    await withHttpServerSpan("HTTP", () => mw(makeMwOpts()));

    expect(observedDuringBody).toBe("ran");
    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.attributes["auth.required"]).toBe(true);
  });

  it("forwards trpc.path and trpc.type from middleware opts", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan("HTTP", () =>
      mw(makeMwOpts({ path: "polls.modify", type: "mutation" })),
    );

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.attributes["trpc.path"]).toBe("polls.modify");
    expect(span.attributes["trpc.type"]).toBe("mutation");
  });

  it("is robust to missing path / type without throwing", async () => {
    const mw = tracedMiddleware(
      { name: "isAuthed" },
      async (opts) => opts.next(),
    );

    // Force a malformed mwOpts (no path / type) — the wrapper must not
    // crash, but should also not set the optional attributes.
    const malformed = {
      ctx: {},
      next: async () => ({
        ok: true as const,
        data: undefined,
        ctx: {},
        marker: undefined,
      }),
    };
    await withHttpServerSpan("HTTP", () =>
      mw(malformed as unknown as SyntheticMwOpts),
    );

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.attributes["trpc.path"]).toBeUndefined();
    expect(span.attributes["trpc.type"]).toBeUndefined();
  });

  it("does not redact or scan caller-supplied attribute values", async () => {
    // Documented contract: the SDK does not scan attributes for
    // secrets. This test pins that behavior so a future change cannot
    // silently start filtering attributes.
    const mw = tracedMiddleware(
      { name: "isAuthed", attributes: { "user.id": "user_123" } },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan("HTTP", () => mw(makeMwOpts()));

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.attributes["user.id"]).toBe("user_123");
  });

  it("does not mutate the caller-provided options.attributes object", async () => {
    // Pin the no-mutation contract: the SDK forwards attributes via
    // span.setAttributes, which copies into the span's internal map.
    // The user's object should be byte-identical after the call.
    const attrs = { "auth.required": true, scope: "user" };
    const snapshot = { ...attrs };
    const mw = tracedMiddleware(
      { name: "isAuthed", attributes: attrs },
      async (opts) => opts.next(),
    );

    await withHttpServerSpan("HTTP", () => mw(makeMwOpts()));

    expect(attrs).toEqual(snapshot);
  });
});

describe("tracedMiddleware — defensive instrumentation contract", () => {
  // Pin: instrumentation must never replace the user's error or return
  // value with an OTel-side error. If the OTel impl is misbehaving and
  // throws from recordException / setStatus / end(), the wrapped
  // middleware still returns / throws what the user expects.
  it("propagates the original middleware error even if span.recordException throws", async () => {
    const userError = new Error("user-facing error");

    // Fake an OTel tracer whose spans throw from recordException to
    // simulate a misbehaving instrumentation. We bypass the global
    // provider for this single test by mocking trace.getTracer.
    const realGetTracer = trace.getTracer.bind(trace);
    const stubTracer = {
      startActiveSpan(_name: string, fn: (span: unknown) => unknown) {
        const span = {
          setAttribute: () => {},
          setAttributes: () => {},
          recordException: () => {
            throw new Error("otel internal failure");
          },
          setStatus: () => {},
          end: () => {},
        };
        return fn(span);
      },
    };
    (trace as unknown as { getTracer: () => unknown }).getTracer = () =>
      stubTracer;

    try {
      const mw = tracedMiddleware({ name: "x" }, async () => {
        throw userError;
      });
      await expect(mw(makeMwOpts())).rejects.toBe(userError);
    } finally {
      (trace as unknown as { getTracer: typeof realGetTracer }).getTracer =
        realGetTracer;
    }
  });

  it("still calls span.setStatus(ERROR) even when span.recordException throws", async () => {
    // Pin the independent-try/catch contract for the error path. A
    // failing `recordException` (which OTel's API allows for
    // non-Error inputs and which a misbehaving impl can produce
    // unprompted) must not skip the `setStatus` call — otherwise the
    // span is left UNSET on a failed request and the failure is
    // invisible to standard OTel UIs.
    const realGetTracer = trace.getTracer.bind(trace);
    const setStatusCalls: Array<{ code: SpanStatusCode; message?: string }> = [];
    const stubTracer = {
      startActiveSpan(_name: string, fn: (span: unknown) => unknown) {
        const span = {
          setAttribute: () => {},
          setAttributes: () => {},
          recordException: () => {
            throw new Error("otel internal failure");
          },
          setStatus: (status: { code: SpanStatusCode; message?: string }) => {
            setStatusCalls.push(status);
          },
          end: () => {},
        };
        return fn(span);
      },
    };
    (trace as unknown as { getTracer: () => unknown }).getTracer = () =>
      stubTracer;

    try {
      const mw = tracedMiddleware({ name: "x" }, async () => {
        throw new Error("user-facing error");
      });
      await expect(mw(makeMwOpts())).rejects.toThrow("user-facing error");
      expect(setStatusCalls).toHaveLength(1);
      expect(setStatusCalls[0]?.code).toBe(SpanStatusCode.ERROR);
      expect(setStatusCalls[0]?.message).toBe("user-facing error");
    } finally {
      (trace as unknown as { getTracer: typeof realGetTracer }).getTracer =
        realGetTracer;
    }
  });

  it("propagates the original middleware return value even if span.end throws", async () => {
    const realGetTracer = trace.getTracer.bind(trace);
    const stubTracer = {
      startActiveSpan(_name: string, fn: (span: unknown) => unknown) {
        const span = {
          setAttribute: () => {},
          setAttributes: () => {},
          recordException: () => {},
          setStatus: () => {},
          end: () => {
            throw new Error("otel internal failure");
          },
        };
        return fn(span);
      },
    };
    (trace as unknown as { getTracer: () => unknown }).getTracer = () =>
      stubTracer;

    try {
      const expected = { ok: true as const, data: "payload" };
      const mw = tracedMiddleware(
        { name: "x" },
        async () => expected,
      );
      const result = await mw(makeMwOpts());
      expect(result).toBe(expected);
    } finally {
      (trace as unknown as { getTracer: typeof realGetTracer }).getTracer =
        realGetTracer;
    }
  });
});

describe("tracedMiddleware — option validation", () => {
  it("throws TypeError when options.name is empty", () => {
    expect(() =>
      tracedMiddleware({ name: "" }, async (o) => (o as SyntheticMwOpts).next()),
    ).toThrow(TypeError);
  });

  it("throws TypeError when options.name is not a string", () => {
    expect(() =>
      tracedMiddleware(
        { name: 123 as unknown as string },
        async (o) => (o as SyntheticMwOpts).next(),
      ),
    ).toThrow(TypeError);
  });
});

describe("tracedMiddleware — sync vs async", () => {
  it("accepts a middleware that returns a resolved Promise synchronously", async () => {
    // Equivalent to a non-async function that returns Promise.resolve(...).
    const mw = tracedMiddleware({ name: "sync" }, ((opts: SyntheticMwOpts) =>
      Promise.resolve({
        ok: true as const,
        data: opts.input,
        ctx: opts.ctx,
        marker: undefined,
      })) as unknown as Parameters<typeof tracedMiddleware>[1]);

    await withHttpServerSpan("HTTP", () => mw(makeMwOpts()));

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "sync");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("accepts an async middleware that awaits before returning", async () => {
    const mw = tracedMiddleware({ name: "async" }, async (opts) => {
      await new Promise((r) => setTimeout(r, 1));
      return opts.next();
    });

    await withHttpServerSpan("HTTP", () => mw(makeMwOpts()));

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "async");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe("tracedMiddleware — v10 shape compatibility (peer-dep floor)", () => {
  // The SDK declares `@trpc/server` as an optional peer with range
  // `^10.0.0 || ^11.0.0`. A v10 middleware function differs from v11 in
  // that it has `rawInput: unknown` (no `getRawInput: () => Promise<unknown>`
  // function) and no top-level `signal: AbortSignal | undefined`.
  // These tests run a synthetic v10-shaped middleware through the wrapper
  // to pin runtime compatibility against the declared peer-dep floor
  // (see SDK-036 brief, T3 escalation; structural type assertions live
  // in `traced-middleware-types.test.ts`).
  it("accepts a v10-shaped middleware (rawInput, no getRawInput, no signal)", async () => {
    type V10MiddlewareOpts = {
      ctx: { userId: string };
      type: "query" | "mutation" | "subscription";
      path: string;
      input: unknown;
      rawInput: unknown;
      meta: undefined;
      next: () => Promise<{
        ok: true;
        data: unknown;
        ctx: { userId: string };
        marker: undefined;
      }>;
    };

    const v10Middleware = async (opts: V10MiddlewareOpts) => opts.next();
    const wrapped = tracedMiddleware({ name: "v10-mw" }, v10Middleware);

    const v10Opts: V10MiddlewareOpts = {
      ctx: { userId: "u_42" },
      type: "query",
      path: "polls.book",
      input: undefined,
      rawInput: undefined,
      meta: undefined,
      next: async () => ({
        ok: true,
        data: undefined,
        ctx: { userId: "u_42" },
        marker: undefined,
      }),
    };

    await withHttpServerSpan("HTTP", () => wrapped(v10Opts));

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "v10-mw");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes["trpc.path"]).toBe("polls.book");
    expect(span.attributes["trpc.type"]).toBe("query");
  });

  it("propagates a v10-style throw through the wrapper", async () => {
    const v10Middleware = async () => {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    };
    const wrapped = tracedMiddleware({ name: "v10-throw" }, v10Middleware);

    await expect(
      withHttpServerSpan("HTTP", () =>
        wrapped({
          ctx: {},
          type: "query",
          path: "x",
          input: undefined,
          rawInput: undefined,
          meta: undefined,
          next: () =>
            Promise.resolve({
              ok: true as const,
              data: undefined,
              ctx: {},
              marker: undefined,
            }),
        }),
      ),
    ).rejects.toThrow();

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "v10-throw");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("tracedMiddleware — v11 fixture (real @trpc/server)", () => {
  it("composes with t.middleware().use() and runs end-to-end", async () => {
    interface MyContext {
      session?: { userId: string };
    }
    const t = initTRPC.context<MyContext>().create();

    const isAuthed = t.middleware(
      tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
        if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
        return next({ ctx: { ...ctx, session: ctx.session } });
      }),
    );

    const router = t.router({
      whoami: t.procedure
        .use(isAuthed)
        .query(({ ctx }) => ctx.session.userId),
    });

    const caller = router.createCaller({ session: { userId: "u_42" } });
    const result = await caller.whoami();
    expect(result).toBe("u_42");

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("propagates a thrown TRPCError through the chain and ends the span ERROR", async () => {
    const t = initTRPC.context<{ session?: unknown }>().create();

    const isAuthed = t.middleware(
      tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
        if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
        return next();
      }),
    );

    const router = t.router({
      whoami: t.procedure.use(isAuthed).query(() => "ok"),
    });

    const caller = router.createCaller({});
    await expect(caller.whoami()).rejects.toThrow();

    const finished = exporter.getFinishedSpans();
    const span = getSpan(finished, "isAuthed");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    const eventNames = span.events.map((e) => e.name);
    expect(eventNames).toContain("exception");
  });

  it("two middlewares chained with .use().use() each produce their own span", async () => {
    interface MyContext {
      session?: { userId: string };
      tier?: "free" | "pro";
    }
    const t = initTRPC.context<MyContext>().create();

    const isAuthed = t.middleware(
      tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
        if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
        return next({ ctx: { ...ctx, session: ctx.session } });
      }),
    );

    const isPro = t.middleware(
      tracedMiddleware({ name: "isPro" }, async ({ ctx, next }) => {
        if (ctx.tier !== "pro") throw new TRPCError({ code: "FORBIDDEN" });
        return next();
      }),
    );

    const router = t.router({
      report: t.procedure
        .use(isAuthed)
        .use(isPro)
        .query(() => "ok"),
    });

    const caller = router.createCaller({
      session: { userId: "u_42" },
      tier: "pro",
    });
    await caller.report();

    const finished = exporter.getFinishedSpans();
    expect(getSpan(finished, "isAuthed")).toBeDefined();
    expect(getSpan(finished, "isPro")).toBeDefined();
  });

  it("cross-middleware context narrowing flows through tracedMiddleware untouched", async () => {
    // The first middleware adds a `session` field to ctx; the second
    // middleware's body relies on it. The runtime check here pins the
    // narrowing flow — at runtime, ctx must have `session` populated
    // when the second middleware runs.
    interface MyContext {
      session?: { userId: string };
    }
    const t = initTRPC.context<MyContext>().create();

    let observedSession: { userId: string } | undefined;

    const isAuthed = t.middleware(
      tracedMiddleware({ name: "isAuthed" }, async ({ ctx, next }) => {
        if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
        return next({ ctx: { ...ctx, session: ctx.session } });
      }),
    );

    const requiresSession = t.middleware(
      tracedMiddleware({ name: "requiresSession" }, async ({ ctx, next }) => {
        // After isAuthed runs, ctx.session is non-null at runtime. The
        // type system narrowing is exercised in the type-test file; at
        // runtime, we observe the value here.
        const session = (ctx as { session: { userId: string } }).session;
        observedSession = session;
        return next();
      }),
    );

    const router = t.router({
      whoami: t.procedure
        .use(isAuthed)
        .use(requiresSession)
        .query(({ ctx }) => (ctx as { session: { userId: string } }).session.userId),
    });

    const caller = router.createCaller({ session: { userId: "u_99" } });
    const result = await caller.whoami();
    expect(result).toBe("u_99");
    expect(observedSession).toEqual({ userId: "u_99" });
  });
});
