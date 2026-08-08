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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  SamplingDecision,
  type ReadableSpan,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import {
  trace,
  SpanStatusCode,
  SpanKind,
  type AttributeValue,
} from "@opentelemetry/api";
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

describe("tracedRequestMiddleware — attribute snapshot, path clamp, name validation hardening", () => {
  it.each(["   ", "\t", "\n"])(
    "rejects a whitespace-only name (%j)",
    (name) => {
      expect(() =>
        tracedRequestMiddleware({ name }, async () => undefined),
      ).toThrow(TypeError);
    },
  );

  it("snapshots options.name at construction — post-construction name mutation is not observed", async () => {
    const options = { name: "original-name" };
    const wrapped = tracedRequestMiddleware(options, async () => ({
      status: 200,
    }));
    options.name = "mutated-name";
    await wrapped(makeNextRequest({ pathname: "/x" }));
    const span = getSpan(exporter.getFinishedSpans(), "original-name");
    expect(span.name).toBe("original-name");
  });

  it("snapshots options.attributes at construction — post-construction mutation is not observed", async () => {
    const attributes: Record<string, AttributeValue> = {
      "auth.required": true,
    };
    const wrapped = tracedRequestMiddleware(
      { name: "auth", attributes },
      async () => ({ status: 200 }),
    );
    // Mutate the caller's object AFTER the wrapper is constructed.
    attributes["auth.required"] = false;
    attributes["added.after"] = "later";

    await wrapped(makeNextRequest({ pathname: "/x" }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes["auth.required"]).toBe(true);
    expect(span.attributes["added.after"]).toBeUndefined();
  });

  it("wrapper-owned causal path attribute takes precedence over a caller-supplied value", async () => {
    const wrapped = tracedRequestMiddleware(
      {
        name: "auth",
        attributes: { [ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]: "/caller-bogus" },
      },
      async () => ({ status: 200 }),
    );
    await wrapped(makeNextRequest({ pathname: "/real" }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe("/real");
  });

  it("strips a caller-supplied wrapper-owned causal attribute when no path is extractable", async () => {
    const wrapped = tracedRequestMiddleware(
      {
        name: "auth",
        attributes: { [ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]: "/caller-spoof" },
      },
      async () => ({ status: 200 }),
    );
    // No nextUrl/url → extractRequestPath returns undefined → the wrapper sets
    // nothing, and the caller's spoofed value must NOT survive (the wrapper
    // owns this attribute and prefers omission over guessed evidence).
    await wrapped(makeNextRequest({}));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBeUndefined();
  });

  it("leaves a path at the 2048-char boundary unclamped", async () => {
    const path = "/" + "a".repeat(2047); // length exactly 2048
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );
    await wrapped(makeNextRequest({ pathname: path }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    const val = span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST] as string;
    expect(val).toBe(path);
    expect(val.length).toBe(2048);
  });

  it("clamps a path longer than 2048 chars to length 2048 with an ellipsis marker", async () => {
    const path = "/" + "a".repeat(5000); // far over the cap
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );
    await wrapped(makeNextRequest({ pathname: path }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    const val = span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST] as string;
    expect(val.length).toBe(2048);
    expect(val.endsWith("…")).toBe(true);
    expect(val.startsWith("/aaa")).toBe(true);
  });

  it("never emits a lone surrogate when clamping a path with a multi-byte char at the cut boundary", async () => {
    // Place an emoji (a surrogate pair) so its high half lands at the cut
    // index, exercising the surrogate-aware back-off in clampPathAttribute.
    const path = "/" + "a".repeat(2045) + "😀" + "b".repeat(100);
    const wrapped = tracedRequestMiddleware(
      { name: "auth" },
      async () => ({ status: 200 }),
    );
    await wrapped(makeNextRequest({ pathname: path }));
    const span = getSpan(exporter.getFinishedSpans(), "auth");
    const val = span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST] as string;
    expect(val.length).toBeLessThanOrEqual(2048);
    expect(val.endsWith("…")).toBe(true);
    // No orphaned high surrogate (would be invalid UTF-8 on the OTLP wire).
    expect(val.isWellFormed()).toBe(true);
  });

  it("runs the handler directly when tracer.startActiveSpan throws (coverage)", async () => {
    const throwing = {
      startActiveSpan: () => {
        throw new Error("provider boom");
      },
    } as unknown as ReturnType<typeof trace.getTracer>;
    const spy = vi.spyOn(trace, "getTracer").mockReturnValue(throwing);
    try {
      let ran = false;
      const wrapped = tracedRequestMiddleware({ name: "auth" }, async () => {
        ran = true;
        return { status: 200 };
      });
      const res = await wrapped(makeNextRequest({ pathname: "/x" }));
      expect(ran).toBe(true);
      expect(res).toEqual({ status: 200 });
    } finally {
      spy.mockRestore();
    }
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

describe("tracedRequestMiddleware — hardening (span-leak watchdog + control-char strip)", () => {
  const WATCHDOG_MS = 600_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the span via the watchdog when a returned thenable never settles", async () => {
    vi.useFakeTimers();
    const neverSettles = { then: () => undefined };
    const wrapped = tracedRequestMiddleware(
      { name: "stuck-middleware" },
      () => neverSettles as unknown as Promise<unknown>,
    );

    wrapped(makeNextRequest({ pathname: "/stuck" }));

    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const span = getSpan(exporter.getFinishedSpans(), "stuck-middleware");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe("/stuck");
  });

  it("a late settle after the watchdog fired is a safe no-op (no double end)", async () => {
    vi.useFakeTimers();
    let capturedResolve: ((value: unknown) => unknown) | undefined;
    const lateThenable = {
      then: (onResolve: (value: unknown) => unknown) => {
        capturedResolve = onResolve;
        return undefined;
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "late-middleware" },
      () => lateThenable as unknown as Promise<unknown>,
    );

    wrapped(makeNextRequest({ pathname: "/late" }));
    vi.advanceTimersByTime(WATCHDOG_MS);
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    expect(capturedResolve).toBeDefined();
    expect(() => capturedResolve!({ status: 200 })).not.toThrow();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("a normally settling async handler never triggers the watchdog", async () => {
    vi.useFakeTimers();
    const wrapped = tracedRequestMiddleware(
      { name: "prompt-middleware" },
      async () => ({ status: 200 }),
    );

    const pending = wrapped(makeNextRequest({ pathname: "/ok" }));
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    vi.advanceTimersByTime(WATCHDOG_MS * 2);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });


  it("traces a CALLABLE thenable (function with then) through the settle path", async () => {
    const fnThenable = Object.assign(() => undefined, {
      then: (onResolve: (value: unknown) => void) => {
        onResolve("fn-done");
      },
    });
    const wrapped = tracedRequestMiddleware(
      { name: "callable-thenable-middleware" },
      () => fnThenable as unknown as Promise<unknown>,
    );

    await expect(
      wrapped(makeNextRequest({ pathname: "/callable" })),
    ).resolves.toBe("fn-done");
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "callable-thenable-middleware"),
    ).toHaveLength(1);
  });

  it("returns a real Promise for a primitive thenable whose then() returns void", async () => {
    const primitiveThenable = {
      then: (onResolve: (value: unknown) => void) => {
        onResolve(42);
        // returns undefined — the wrapper must still yield a Promise
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "primitive-thenable-middleware" },
      () => primitiveThenable as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/primitive" }));
    expect(out).toBeInstanceOf(Promise);
    await expect(out as Promise<unknown>).resolves.toBe(42);
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "primitive-thenable-middleware"),
    ).toHaveLength(1);
  });

  it("rejects (rather than throwing synchronously) when a thenable's registration throws", async () => {
    const hostileRegistration = {
      then: () => {
        throw new Error("registration boom");
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "hostile-registration-middleware" },
      () => hostileRegistration as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/hostile" }));
    expect(out).toBeInstanceOf(Promise);
    await expect(out as Promise<unknown>).rejects.toThrow("registration boom");
    const span = getSpan(
      exporter.getFinishedSpans(),
      "hostile-registration-middleware",
    );
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });


  it("assimilates a nested pending promise: the span ends only at ACTUAL fulfillment", async () => {
    let resolveInner!: (value: string) => void;
    const inner = new Promise<string>((resolve) => { resolveInner = resolve; });
    const outerThenable = {
      then: (onResolve: (value: unknown) => void) => {
        onResolve(inner); // resolve with a still-pending promise
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "assimilating-middleware" },
      () => outerThenable as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/nested" })) as Promise<unknown>;
    // Outer thenable has resolved-with-pending: no span may end yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    resolveInner("finally-done");
    await expect(out).resolves.toBe("finally-done");
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "assimilating-middleware"),
    ).toHaveLength(1);
  });

  it("records a late rejection of a nested promise with ERROR status", async () => {
    let rejectInner!: (error: unknown) => void;
    const inner = new Promise<never>((_r, reject) => { rejectInner = reject; });
    const outerThenable = {
      then: (onResolve: (value: unknown) => void) => {
        onResolve(inner);
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "nested-reject-middleware" },
      () => outerThenable as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/nested-reject" })) as Promise<unknown>;
    const swallowed = out.catch((e: unknown) => e);
    rejectInner(new Error("inner-boom"));
    const seen = await swallowed;
    expect((seen as Error).message).toBe("inner-boom");
    const span = getSpan(exporter.getFinishedSpans(), "nested-reject-middleware");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("inner-boom");
  });


  it("commits to the FIRST callback: resolve-then-reject keeps the span clean", async () => {
    const doubleCaller = {
      then: (
        onResolve: (value: unknown) => void,
        onReject: (error: unknown) => void,
      ) => {
        onResolve("first-wins");
        onReject(new Error("spurious late rejection"));
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "first-wins-middleware" },
      () => doubleCaller as unknown as Promise<unknown>,
    );

    await expect(
      wrapped(makeNextRequest({ pathname: "/first" })) as Promise<unknown>,
    ).resolves.toBe("first-wins");
    const span = getSpan(exporter.getFinishedSpans(), "first-wins-middleware");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.events.map((e) => e.name)).not.toContain("exception");
  });

  it("commits to the FIRST callback: reject-then-resolve records exactly one ERROR", async () => {
    const doubleCaller = {
      then: (
        onResolve: (value: unknown) => void,
        onReject: (error: unknown) => void,
      ) => {
        onReject(new Error("real failure"));
        onResolve("spurious late value");
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "reject-first-middleware" },
      () => doubleCaller as unknown as Promise<unknown>,
    );

    await expect(
      wrapped(makeNextRequest({ pathname: "/reject-first" })) as Promise<unknown>,
    ).rejects.toThrow("real failure");
    const span = getSpan(exporter.getFinishedSpans(), "reject-first-middleware");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("real failure");
  });


  it("preserves the handler's Promise subtype through the wrapper", async () => {
    class TaggedPromise<T> extends Promise<T> {
      tag(): string {
        return "tagged";
      }
    }
    const wrapped = tracedRequestMiddleware(
      { name: "subtype-middleware" },
      () => TaggedPromise.resolve({ status: 200 }),
    );

    const out = wrapped(makeNextRequest({ pathname: "/subtype" }));
    expect(out).toBeInstanceOf(TaggedPromise);
    expect((out as InstanceType<typeof TaggedPromise>).tag()).toBe("tagged");
    await out;
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "subtype-middleware"),
    ).toHaveLength(1);
  });


  it("rejects with TypeError on self-resolution instead of hanging", async () => {
    let storedResolve: ((value: unknown) => void) | undefined;
    const selfResolver = {
      then: (onResolve: (value: unknown) => void) => {
        storedResolve = onResolve;
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "self-resolving-middleware" },
      () => selfResolver as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/self" })) as Promise<unknown>;
    expect(storedResolve).toBeDefined();
    storedResolve!(out); // hand the wrapper its own promise

    await expect(out).rejects.toThrow(TypeError);
    await expect(out).rejects.toThrow("Chaining cycle detected");
    const span = getSpan(
      exporter.getFinishedSpans(),
      "self-resolving-middleware",
    );
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });


  it("survives a proxy thenable whose getPrototypeOf trap throws (falls to the guarded path)", async () => {
    const hostileBrand = new Proxy(
      {
        then: (onResolve: (value: unknown) => void) => {
          onResolve("proxied-done");
        },
      },
      {
        getPrototypeOf: () => {
          throw new Error("hostile prototype trap");
        },
      },
    );
    const wrapped = tracedRequestMiddleware(
      { name: "hostile-brand-middleware" },
      () => hostileBrand as unknown as Promise<unknown>,
    );

    await expect(
      wrapped(makeNextRequest({ pathname: "/hostile-brand" })) as Promise<unknown>,
    ).resolves.toBe("proxied-done");
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "hostile-brand-middleware"),
    ).toHaveLength(1);
  });


  it("rejects with TypeError when a NESTED thenable later fulfills with the wrapper", async () => {
    let nestedResolve: ((value: unknown) => void) | undefined;
    const nestedThenable = {
      then: (onResolve: (value: unknown) => void) => {
        nestedResolve = onResolve;
      },
    };
    const outerThenable = {
      then: (onResolve: (value: unknown) => void) => {
        onResolve(nestedThenable); // fulfill outer with the nested thenable
      },
    };
    const wrapped = tracedRequestMiddleware(
      { name: "nested-cycle-middleware" },
      () => outerThenable as unknown as Promise<unknown>,
    );

    const out = wrapped(makeNextRequest({ pathname: "/nested-cycle" })) as Promise<unknown>;
    // Let native assimilation register callbacks on the nested thenable.
    await vi.waitFor(() => {
      expect(nestedResolve).toBeDefined();
    });
    nestedResolve!(out); // the nested thenable hands back the wrapper

    await expect(out).rejects.toThrow(TypeError);
    await expect(out).rejects.toThrow("Chaining cycle detected");
    const span = getSpan(
      exporter.getFinishedSpans(),
      "nested-cycle-middleware",
    );
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });


  it("traces a real Promise whose own then property is a non-callable shadow", async () => {
    const shadowed = Promise.resolve({ status: 200 });
    Object.defineProperty(shadowed, "then", { value: 42 });
    const wrapped = tracedRequestMiddleware(
      { name: "shadowed-then-middleware" },
      () => shadowed,
    );

    const out = wrapped(makeNextRequest({ pathname: "/shadowed" }));
    await expect(out as Promise<unknown>).resolves.toEqual({ status: 200 });
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === "shadowed-then-middleware"),
    ).toHaveLength(1);
  });

  it("strips control characters from caller attributes (strings and array elements)", async () => {
    const wrapped = tracedRequestMiddleware(
      {
        name: "strip-middleware",
        attributes: {
          note: "line1\r\nline2",
          tags: ["a\tb", "clean"],
          count: 3,
        },
      },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "/strip" }));
    const span = getSpan(exporter.getFinishedSpans(), "strip-middleware");
    expect(span.attributes["note"]).toBe("line1line2");
    expect(span.attributes["tags"]).toEqual(["ab", "clean"]);
    expect(span.attributes["count"]).toBe(3);
  });

  it("strips a control character introduced by post-construction in-place array mutation", async () => {
    const tags = ["clean"];
    const wrapped = tracedRequestMiddleware(
      { name: "mutated-array-middleware", attributes: { tags } },
      async () => ({ status: 200 }),
    );
    // The snapshot is shallow: in-place element mutation IS observed
    // (per the documented semantics), and the write-time strip must
    // still sanitize the mutated element.
    tags[0] = "dirty\tvalue";

    await wrapped(makeNextRequest({ pathname: "/mutated" }));
    const span = getSpan(
      exporter.getFinishedSpans(),
      "mutated-array-middleware",
    );
    expect(span.attributes["tags"]).toEqual(["dirtyvalue"]);
  });

  it("omits the causal path attribute when the path strips to empty", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "empty-path-middleware" },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "\n\t" }));
    const span = getSpan(exporter.getFinishedSpans(), "empty-path-middleware");
    expect(
      span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST],
    ).toBeUndefined();
  });

  it("strips control characters from the causal path attribute", async () => {
    const wrapped = tracedRequestMiddleware(
      { name: "strip-path-middleware" },
      async () => ({ status: 200 }),
    );

    await wrapped(makeNextRequest({ pathname: "/multi\nline\tpath" }));
    const span = getSpan(exporter.getFinishedSpans(), "strip-path-middleware");
    expect(span.attributes[ATTR.CAUSAL_MIDDLEWARE_FOR_REQUEST]).toBe(
      "/multilinepath",
    );
  });
});
