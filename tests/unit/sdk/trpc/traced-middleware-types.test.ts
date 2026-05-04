/**
 * Compile-time tests for `tracedMiddleware`'s type-inference contract.
 *
 * The load-bearing claim documented in `sdk-trpc.md` §3.3 is that
 * `tracedMiddleware`'s `T extends MiddlewareFunction` bound and `: T`
 * return type preserve the user's narrowed middleware type at the call
 * site. These assertions run at `vitest`-test-discovery time via
 * `expectTypeOf`, which does the type-level checks at TypeScript-compile
 * time (so any regression here surfaces as a `tsc -b` failure as well
 * as a `vitest run` failure).
 *
 * If a future SDK change replaces the structural bound with a less
 * permissive shape, these assertions will fail to compile. Keep them
 * tight: the structural bound's only contract is "anything callable
 * shaped like a tRPC middleware" — and `T` flows through unchanged.
 */
import { describe, it, expectTypeOf } from "vitest";
import { initTRPC } from "@trpc/server";
import {
  tracedMiddleware,
  type MiddlewareFunction,
  type TracedMiddlewareOptions,
} from "../../../../packages/sdk/src/trpc/index.js";

describe("tracedMiddleware — type-inference preservation", () => {
  it("preserves the function's call signature on the wrapped value", () => {
    const original = async (opts: {
      ctx: { userId: string };
      type: "query" | "mutation" | "subscription";
      path: string;
      input: unknown;
      next: () => Promise<{ ok: true; data: number }>;
    }): Promise<{ ok: true; data: number }> => opts.next();

    const wrapped = tracedMiddleware({ name: "x" }, original);

    // The wrapped function has the exact same type as the original —
    // not widened to the structural bound.
    expectTypeOf(wrapped).toEqualTypeOf<typeof original>();
  });

  it("preserves a strongly typed ctx through tRPC's procedure builder narrowing", () => {
    interface MyContext {
      session?: { userId: string };
    }
    const t = initTRPC.context<MyContext>().create();

    // Capturing the middleware type via Parameters/ReturnType of
    // `t.middleware`'s argument so that ctx is the narrowed type. This
    // is the recommended call pattern from sdk-trpc.md §3.3.
    type MwParams = Parameters<Parameters<typeof t.middleware>[0]>[0];

    const wrapped = tracedMiddleware(
      { name: "isAuthed" },
      async (opts: MwParams) => opts.next(),
    );

    // Apply via t.middleware — this only compiles if the wrapped
    // function's type still matches what tRPC expects.
    const isAuthed = t.middleware(wrapped);
    expectTypeOf(isAuthed).toBeObject();
  });

  it("rejects a non-function middleware argument at compile time", () => {
    // The structural bound forbids passing a string / number / object
    // as the second argument. The `@ts-expect-error` directives pin
    // the type-level rejection. We deliberately do NOT invoke the
    // expressions at runtime — the goal is the compile-time check, and
    // running them would either throw on type-validation in the helper
    // or behave nonsensically. Wrapping in `false &&` keeps the type
    // checker happy with the assertions while skipping execution.
    if (false as boolean) {
      // @ts-expect-error — second argument must be a function
      tracedMiddleware({ name: "x" }, "not a function");
      // @ts-expect-error — second argument must be a function
      tracedMiddleware({ name: "x" }, 42);
    }
  });

  it("rejects an empty options object at compile time (name is required)", () => {
    if (false as boolean) {
      // @ts-expect-error — options.name is required
      tracedMiddleware({}, async (o: { next: () => Promise<unknown> }) =>
        o.next(),
      );
    }
  });

  it("MiddlewareFunction type is exported and assignable to tRPC's middleware shape", () => {
    expectTypeOf<MiddlewareFunction>().toBeFunction();
    // The bound's parameter is `any` (load-bearing per src JSDoc), so
    // any tRPC v10 / v11 middleware function is assignable.

    // Floor of the declared peer-dependency range: `@trpc/server@10.0.0`.
    // The v10.0.0 middleware shape has `rawInput: unknown` (no
    // `getRawInput`) and no `signal` field. This fixture pins the
    // structural compatibility against the floor explicitly so a
    // future SDK change that tightens the bound (and would silently
    // break v10.0.0 consumers) fails this test at compile time.
    type TrpcV10Floor_MiddlewareFn = (opts: {
      ctx: unknown;
      type: "query" | "mutation" | "subscription";
      path: string;
      input: unknown;
      rawInput: unknown;
      meta: unknown;
      next: () => Promise<{ ok: boolean }>;
    }) => Promise<{ ok: boolean }>;
    expectTypeOf<TrpcV10Floor_MiddlewareFn>().toMatchTypeOf<MiddlewareFunction>();

    // Last shipped v10 line: `@trpc/server@10.45.x`. Same shape as the
    // floor — v10 did not change the middleware surface across its
    // entire 10.0.0 → 10.45.x line. Pinning explicitly so a regression
    // is caught even if the shape is the same as the floor.
    type TrpcV10Tip_MiddlewareFn = TrpcV10Floor_MiddlewareFn;
    expectTypeOf<TrpcV10Tip_MiddlewareFn>().toMatchTypeOf<MiddlewareFunction>();

    // v11 added `getRawInput: GetRawInputFn` (replacing `rawInput`) and
    // a top-level `signal: AbortSignal | undefined`. The structural
    // bound must accept this shape too.
    type TrpcV11_MiddlewareFn = (opts: {
      ctx: unknown;
      type: "query" | "mutation" | "subscription";
      path: string;
      input: unknown;
      getRawInput: () => Promise<unknown>;
      meta: unknown;
      signal: AbortSignal | undefined;
      next: () => Promise<{ ok: boolean }>;
    }) => Promise<{ ok: boolean }>;
    expectTypeOf<TrpcV11_MiddlewareFn>().toMatchTypeOf<MiddlewareFunction>();
  });

  it("TracedMiddlewareOptions has the documented shape", () => {
    expectTypeOf<TracedMiddlewareOptions>().toMatchTypeOf<{
      name: string;
      attributes?: Record<string, unknown>;
    }>();
    // `name` is required.
    expectTypeOf<TracedMiddlewareOptions["name"]>().toEqualTypeOf<string>();
  });
});
