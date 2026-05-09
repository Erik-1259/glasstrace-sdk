/**
 * Unit tests for `wrapBatchedHttpHandler` + `tracedMiddleware`
 * batch-member span emission (SDK-052 / Wave 16B / advances
 * DISC-1534 SDK-side slice).
 *
 * The wrapper sets a request-scoped `AsyncLocalStorage` envelope so
 * `tracedMiddleware`'s span emission can label each batch member's
 * span with `glasstrace.trpc.batch.member_index` and
 * `glasstrace.trpc.batch.member_procedures`. Apps not using the
 * wrapper, and apps not using `tracedMiddleware`, see no
 * trace-shape change.
 *
 * Same-additivity scope only — the brief proposed reshaping the
 * root HTTP server span's `glasstrace.trpc.procedure` from
 * comma-joined to first-member representative; that change is NOT
 * additive and is deferred per the Wave 16 plan §Mid-wave stop
 * rules. Tests below pin the strict-additive behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";
import { tracedMiddleware } from "../../../../packages/sdk/src/trpc/index.js";
import {
  wrapBatchedHttpHandler,
  _resetBatchHandlerForTesting,
} from "../../../../packages/sdk/src/trpc/batch-handler.js";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../../packages/sdk/src/lifecycle.js";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupTracerProvider(): void {
  exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  provider = new BasicTracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
}

function getSpan(name: string): ReadableSpan | undefined {
  return exporter.getFinishedSpans().find((s) => s.name === name);
}

beforeEach(() => {
  _resetBatchHandlerForTesting();
  setupTracerProvider();
});

afterEach(async () => {
  // OTel's `trace.setGlobalTracerProvider` is idempotent — once a
  // provider is registered, subsequent registrations from beforeEach
  // are silent no-ops, so test N+1 would inherit test N's exporter.
  // `trace.disable` clears the global registration so beforeEach can
  // register a fresh provider next time.
  await provider.shutdown();
  trace.disable();
});

describe("wrapBatchedHttpHandler — batch URL detection", () => {
  it("parses /api/trpc/<procs>?batch=1 and propagates the envelope to tracedMiddleware", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-member" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(async () => {
      // Simulate tRPC's per-procedure dispatch: invoke middleware
      // once per batch member with the corresponding `path`.
      await middleware({
        path: "polls.get",
        type: "query",
        next: async () => ({ ok: true }),
      } as unknown as never);
      await middleware({
        path: "polls.comments.list",
        type: "query",
        next: async () => ({ ok: true }),
      } as unknown as never);
      return new Response("ok");
    });

    const req = new Request(
      "http://localhost:3000/api/trpc/polls.get,polls.comments.list?batch=1",
    );
    await handler(req);

    const spans = exporter.getFinishedSpans();
    const memberSpans = spans.filter((s) => s.name === "trpc-member");
    expect(memberSpans).toHaveLength(2);

    const first = memberSpans[0]!;
    expect(first.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(0);
    expect(first.attributes[ATTR.TRPC_BATCH_MEMBER_PROCEDURES]).toEqual([
      "polls.get",
      "polls.comments.list",
    ]);

    const second = memberSpans[1]!;
    expect(second.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(1);
    expect(second.attributes[ATTR.TRPC_BATCH_MEMBER_PROCEDURES]).toEqual([
      "polls.get",
      "polls.comments.list",
    ]);
  });

  it("uses positional dispatch index for duplicate procedure names", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-member" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(async () => {
      // Same procedure twice — positional indexing must distinguish
      // index=0 from index=1.
      await middleware({
        path: "polls.get",
        next: async () => ({ ok: true }),
      } as unknown as never);
      await middleware({
        path: "polls.get",
        next: async () => ({ ok: true }),
      } as unknown as never);
      return new Response("ok");
    });

    const req = new Request(
      "http://localhost:3000/api/trpc/polls.get,polls.get?batch=1",
    );
    await handler(req);

    const memberSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "trpc-member");
    expect(memberSpans).toHaveLength(2);
    expect(memberSpans[0]!.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(0);
    expect(memberSpans[1]!.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(1);
  });

  it("respects a configured non-default basePath (DISC-1215 — configurable mount)", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-member" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(
      async () => {
        await middleware({
          path: "polls.get",
          next: async () => ({ ok: true }),
        } as unknown as never);
        return new Response("ok");
      },
      { basePath: "/api/v2/trpc/" },
    );

    const req = new Request(
      "http://localhost:3000/api/v2/trpc/polls.get?batch=1",
    );
    await handler(req);

    const span = getSpan("trpc-member");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(0);
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_PROCEDURES]).toEqual([
      "polls.get",
    ]);
  });

  it("normalizes a basePath without trailing slash by appending one", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-member" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(
      async () => {
        await middleware({
          path: "polls.get",
          next: async () => ({ ok: true }),
        } as unknown as never);
        return new Response("ok");
      },
      { basePath: "/api/v2/trpc" }, // missing trailing slash
    );

    const req = new Request(
      "http://localhost:3000/api/v2/trpc/polls.get?batch=1",
    );
    await handler(req);

    const span = getSpan("trpc-member");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBe(0);
  });
});

describe("wrapBatchedHttpHandler — non-batched regression", () => {
  it("leaves single-procedure non-batched URLs untouched (no envelope)", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-single" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(async () => {
      await middleware({
        path: "polls.get",
        next: async () => ({ ok: true }),
      } as unknown as never);
      return new Response("ok");
    });

    // No batch= query param → not a batch.
    const req = new Request(
      "http://localhost:3000/api/trpc/polls.get?input=...",
    );
    await handler(req);

    const span = getSpan("trpc-single");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBeUndefined();
    expect(
      span?.attributes[ATTR.TRPC_BATCH_MEMBER_PROCEDURES],
    ).toBeUndefined();
  });

  it("leaves URLs whose basePath does not match (default /api/trpc/) untouched", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-other" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(async () => {
      await middleware({
        path: "polls.get",
        next: async () => ({ ok: true }),
      } as unknown as never);
      return new Response("ok");
    });

    // URL doesn't have /api/trpc/ prefix.
    const req = new Request(
      "http://localhost:3000/api/orpc/polls.get?batch=1",
    );
    await handler(req);

    const span = getSpan("trpc-other");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBeUndefined();
  });
});

describe("wrapBatchedHttpHandler — opt-in semantics", () => {
  it("apps NOT using the wrapper see no envelope (regression for backwards-compat)", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-noop" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    // No wrapper — direct invocation.
    await middleware({
      path: "polls.get",
      next: async () => ({ ok: true }),
    } as unknown as never);

    const span = getSpan("trpc-noop");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBeUndefined();
    expect(
      span?.attributes[ATTR.TRPC_BATCH_MEMBER_PROCEDURES],
    ).toBeUndefined();
  });
});

describe("wrapBatchedHttpHandler — failure modes", () => {
  it("falls through to the underlying handler when the request shape is unrecognized", async () => {
    let called = false;
    const handler = wrapBatchedHttpHandler(((arg: unknown) => {
      called = true;
      return arg;
    }) as (...args: never[]) => unknown);

    // Pass a non-object — the wrapper can't extract a URL.
    const result = await (handler as unknown as (a: number) => unknown)(42);
    expect(called).toBe(true);
    expect(result).toBe(42);
  });

  it("falls through when the URL is malformed", async () => {
    const middleware = tracedMiddleware(
      { name: "trpc-malformed" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(
      async () => {
        await middleware({
          path: "polls.get",
          next: async () => ({ ok: true }),
        } as unknown as never);
        return "ok";
      },
    );

    // URL constructor with a placeholder origin is permissive, so a
    // pathological URL still parses but yields a non-matching pathname.
    // Pass a value the URL constructor genuinely rejects: a control
    // char followed by random text.
    const req = { url: "\x00://broken url" };
    await handler(req as { url: string });

    const span = getSpan("trpc-malformed");
    expect(span?.attributes[ATTR.TRPC_BATCH_MEMBER_INDEX]).toBeUndefined();
  });

  it("emits otel:trpc_batch_member_mismatch when a procedure is not in the envelope", async () => {
    const handler_listener = vi.fn();
    onLifecycleEvent("otel:trpc_batch_member_mismatch", handler_listener);

    const middleware = tracedMiddleware(
      { name: "trpc-mismatch" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    const handler = wrapBatchedHttpHandler(async () => {
      // The envelope has procedure `polls.get` but middleware fires
      // for `polls.unrelated` — name doesn't match.
      await middleware({
        path: "polls.unrelated",
        next: async () => ({ ok: true }),
      } as unknown as never);
      return new Response("ok");
    });

    const req = new Request(
      "http://localhost:3000/api/trpc/polls.get?batch=1",
    );
    await handler(req);

    expect(handler_listener).toHaveBeenCalledTimes(1);
    const payload = handler_listener.mock.calls[0][0] as {
      procedureName: string;
      batchMembers: ReadonlyArray<string>;
      spanId: string;
    };
    expect(payload.procedureName).toBe("polls.unrelated");
    expect(payload.batchMembers).toEqual(["polls.get"]);
    expect(typeof payload.spanId).toBe("string");
    expect(payload.spanId.length).toBeGreaterThan(0);

    offLifecycleEvent("otel:trpc_batch_member_mismatch", handler_listener);
  });

  it("does NOT emit mismatch event for non-batched requests (no envelope at all)", async () => {
    const handler_listener = vi.fn();
    onLifecycleEvent("otel:trpc_batch_member_mismatch", handler_listener);

    const middleware = tracedMiddleware(
      { name: "trpc-no-envelope" },
      async ({ next }: { next: () => Promise<unknown> }) => next(),
    );

    // No wrapper at all — middleware runs but no envelope exists.
    await middleware({
      path: "polls.get",
      next: async () => ({ ok: true }),
    } as unknown as never);

    expect(handler_listener).not.toHaveBeenCalled();

    offLifecycleEvent("otel:trpc_batch_member_mismatch", handler_listener);
  });
});

