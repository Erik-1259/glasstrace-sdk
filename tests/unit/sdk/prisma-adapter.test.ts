/**
 * Behavior tests for the passive Prisma value-capture adapter.
 *
 * The adapter returns a Prisma client extension; these tests drive its
 * `$allOperations` callback structurally (no real `@prisma/client`) under a
 * real active request span + capture config, and assert the contract:
 *
 *  - green: an allowlisted boolean projects onto an owned `db.<Model>.<op>`
 *    span as a native scalar; the query result is returned unchanged;
 *  - default-deny: with no allow entry (and the master switch ON) nothing is
 *    captured and NO owned span is opened (gate-before-startSpan);
 *  - only the eight documented single-record-result operations are eligible;
 *    count, aggregate, group, list, bulk, raw, and unknown operations open no
 *    owned value-capture span;
 *  - pure-observer: a thrown query propagates verbatim with the owned span
 *    still ended and no leak.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  prismaAdapter,
  type ScalarIntent,
} from "../../../packages/sdk/src/adapters/prisma.js";
import { hashIdWeb } from "../../../packages/sdk/src/side-effect/hash-id-web.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../packages/protocol/src/wire.js";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  SIDE_EFFECT_SCALAR_PREFIX,
} from "../../../packages/protocol/src/index.js";

installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

const scalarKey = (k: string): string => `${SIDE_EFFECT_SCALAR_PREFIX}${k}`;

function configWith(sideEffectEvidence: boolean): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence,
    },
    subscriptionStatus: "active",
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512_000,
      maxConcurrentSessions: 1,
    },
  } as SdkInitResponse;
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-prisma-test");
  _setCurrentConfig(configWith(true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

/**
 * Drive one Prisma operation through the adapter under an active request
 * span. Returns the operation result and any caught query error; finished
 * spans remain available through the test exporter.
 */
async function runOperation(opts: {
  allow: ReadonlyArray<{ model: string; column: string; as?: ScalarIntent }>;
  model: string;
  operation: string;
  /** Operation arguments forwarded unchanged to the query callback. */
  args?: unknown;
  query: (args: unknown) => Promise<unknown>;
  /** Omit to simulate an edge runtime with no active request span. */
  withRequestSpan?: boolean;
}): Promise<{ result: unknown; thrown: unknown }> {
  const ext = prismaAdapter({ allow: opts.allow });
  const invoke = async (): Promise<{ result: unknown; thrown: unknown }> => {
    try {
      const result = await ext.query.$allModels.$allOperations({
        model: opts.model,
        operation: opts.operation,
        args: opts.args ?? {},
        query: opts.query,
      });
      return { result, thrown: undefined };
    } catch (err) {
      return { result: undefined, thrown: err };
    }
  };

  if (opts.withRequestSpan === false) {
    return invoke();
  }
  return new Promise((resolve) => {
    tracer.startActiveSpan("request", async (reqSpan) => {
      const out = await invoke();
      reqSpan.end();
      resolve(out);
    });
  });
}

function ownedSpanAttrs(): Record<string, unknown> | undefined {
  const span = exporter
    .getFinishedSpans()
    .find((s) => s.name.startsWith("db."));
  return span?.attributes as Record<string, unknown> | undefined;
}

function expectNoOwnedSpan(): void {
  expect(
    exporter.getFinishedSpans().some((span) => span.name.startsWith("db.")),
  ).toBe(false);
}

function guardedCountSelectArgs(field: string): {
  args: Readonly<{ select: object }>;
  rawSelect: Readonly<Record<string, boolean>>;
  selectSnapshot: Readonly<Record<string, boolean>>;
  structuralReadCount: () => number;
} {
  const rawSelect = { [field]: true };
  const selectSnapshot = structuredClone(rawSelect);
  Object.freeze(rawSelect);

  let structuralReads = 0;
  const rejectStructuralRead = (): never => {
    structuralReads += 1;
    throw new Error("the adapter must not inspect args.select");
  };
  const select = new Proxy(rawSelect, {
    get: rejectStructuralRead,
    has: rejectStructuralRead,
    ownKeys: rejectStructuralRead,
    getOwnPropertyDescriptor: rejectStructuralRead,
  });

  return {
    args: Object.freeze({ select }),
    rawSelect,
    selectSnapshot,
    structuralReadCount: () => structuralReads,
  };
}

describe("count select result boundary", () => {
  it.each([
    { intent: "value", suffix: "Value" },
    { intent: "amount", suffix: "Amount" },
    { intent: "ms", suffix: "Ms" },
    { intent: "bytes", suffix: "Bytes" },
    { intent: "ratio", suffix: "Ratio" },
  ] as const)(
    "keeps count select inert for the $intent numeric intent",
    async ({ intent, suffix }) => {
      const {
        args,
        rawSelect,
        selectSnapshot,
        structuralReadCount,
      } = guardedCountSelectArgs("metric");
      const countResult = Object.freeze({ metric: 7 });
      const resultSnapshot = structuredClone(countResult);
      const query = vi.fn(async (receivedArgs: unknown) => {
        expect(receivedArgs).toBe(args);
        return countResult;
      });

      const { result, thrown } = await runOperation({
        allow: [{ model: "Order", column: "metric", as: intent }],
        model: "Order",
        operation: "count",
        args,
        query,
      });

      expect(thrown).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toBe(countResult);
      expect(countResult).toEqual(resultSnapshot);
      expect(rawSelect).toEqual(selectSnapshot);
      expect(structuralReadCount()).toBe(0);

      const owned = ownedSpanAttrs();
      const captured = owned?.[scalarKey(`metric${suffix}`)];
      expect(captured).not.toBe(7);
      expect(captured).toBeUndefined();
      expect(
        owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
      ).toBeUndefined();
      expect(
        exporter.getFinishedSpans().some((span) => span.name.startsWith("db.")),
      ).toBe(false);
    },
  );

  it("keeps count select inert for the default flag intent", async () => {
    const {
      args,
      rawSelect,
      selectSnapshot,
      structuralReadCount,
    } = guardedCountSelectArgs("active");
    const countResult = Object.freeze({ active: 7 });
    const resultSnapshot = structuredClone(countResult);
    const query = vi.fn(async (receivedArgs: unknown) => {
      expect(receivedArgs).toBe(args);
      return countResult;
    });

    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "active" }],
      model: "Order",
      operation: "count",
      args,
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(countResult);
    expect(countResult).toEqual(resultSnapshot);
    expect(rawSelect).toEqual(selectSnapshot);
    expect(structuralReadCount()).toBe(0);

    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("activeFlag")]).toBeUndefined();
    const omission =
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD];
    expect(omission).not.toBe(1);
    expect(omission).toBeUndefined();
    expect(
      exporter.getFinishedSpans().some((span) => span.name.startsWith("db.")),
    ).toBe(false);
  });

  it("keeps count select inert for the full-fidelity id intent", async () => {
    const hmacKey = "count-select-test-hmac-secret-do-not-use";
    const full = configWith(true);
    full.config.captureFidelity = "full";
    full.config.attrHmacKey = hmacKey;
    _setCurrentConfig(full);

    const {
      args,
      rawSelect,
      selectSnapshot,
      structuralReadCount,
    } = guardedCountSelectArgs("owner");
    const countResult = Object.freeze({ owner: 7 });
    const resultSnapshot = structuredClone(countResult);
    const query = vi.fn(async (receivedArgs: unknown) => {
      expect(receivedArgs).toBe(args);
      return countResult;
    });

    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "owner", as: "id" }],
      model: "Order",
      operation: "count",
      args,
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(countResult);
    expect(countResult).toEqual(resultSnapshot);
    expect(rawSelect).toEqual(selectSnapshot);
    expect(structuralReadCount()).toBe(0);

    const owned = ownedSpanAttrs();
    const captured = owned?.[scalarKey("ownerId")];
    expect(captured).not.toBe(await hashIdWeb("7", hmacKey));
    expect(captured).toBeUndefined();
    expect(
      exporter.getFinishedSpans().some((span) => span.name.startsWith("db.")),
    ).toBe(false);
  });

  it("keeps a bare count number inert", async () => {
    const query = vi.fn(async () => 7);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "count", as: "value" }],
      model: "Order",
      operation: "count",
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(7);
    expectNoOwnedSpan();
  });

  it("keeps count select _all inert", async () => {
    const {
      args,
      rawSelect,
      selectSnapshot,
      structuralReadCount,
    } = guardedCountSelectArgs("_all");
    const countResult = Object.freeze({ _all: 7 });
    const query = vi.fn(async (receivedArgs: unknown) => {
      expect(receivedArgs).toBe(args);
      return countResult;
    });

    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "_all", as: "value" }],
      model: "Order",
      operation: "count",
      args,
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(countResult);
    expect(rawSelect).toEqual(selectSnapshot);
    expect(structuralReadCount()).toBe(0);
    expectNoOwnedSpan();
  });

  it("propagates a denied count-select error verbatim without inspecting arguments or opening an owned span", async () => {
    const {
      args,
      rawSelect,
      selectSnapshot,
      structuralReadCount,
    } = guardedCountSelectArgs("metric");
    const sentinel = new Error("count-select sentinel");
    const query = vi.fn(async (receivedArgs: unknown): Promise<never> => {
      expect(receivedArgs).toBe(args);
      throw sentinel;
    });

    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "metric", as: "value" }],
      model: "Order",
      operation: "count",
      args,
      query,
    });

    expect(result).toBeUndefined();
    expect(thrown).toBe(sentinel);
    expect(query).toHaveBeenCalledTimes(1);
    expect(rawSelect).toEqual(selectSnapshot);
    expect(structuralReadCount()).toBe(0);
    expectNoOwnedSpan();
  });
});

describe("prismaAdapter — green path", () => {
  it("projects an allowlisted boolean onto an owned db.<Model>.<op> span and returns the result unchanged", async () => {
    const row = { muted: false, id: "p1" };
    const { result } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => row,
    });

    expect(result).toBe(row); // identity preserved (no mutation/copy)
    const finished = exporter.getFinishedSpans();
    const owned = finished.find((s) => s.name === "db.Poll.findUnique");
    expect(owned).toBeDefined();
    expect(owned?.attributes[scalarKey("mutedFlag")]).toBe(false);
  });

  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "create",
    "update",
    "upsert",
    "delete",
  ])(
    "captures an own allowlisted field for the eligible %s operation",
    async (operation) => {
      const args = Object.freeze({ where: Object.freeze({ id: "p1" }) });
      const row = Object.freeze({ muted: false, id: "p1" });
      const query = vi.fn(async (receivedArgs: unknown) => {
        expect(receivedArgs).toBe(args);
        return row;
      });

      const { result, thrown } = await runOperation({
        allow: [{ model: "Poll", column: "muted" }],
        model: "Poll",
        operation,
        args,
        query,
      });

      expect(thrown).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toBe(row);
      const owned = exporter
        .getFinishedSpans()
        .find((span) => span.name === `db.Poll.${operation}`);
      expect(owned?.attributes[scalarKey("mutedFlag")]).toBe(false);
    },
  );

  it("ignores an inherited allowlisted property while capturing a neighboring own property", async () => {
    const prototype = Object.freeze({ inherited: true });
    const row = Object.assign(Object.create(prototype) as { own?: boolean }, {
      own: false,
    });

    const { result, thrown } = await runOperation({
      allow: [
        { model: "Poll", column: "inherited" },
        { model: "Poll", column: "own" },
      ],
      model: "Poll",
      operation: "findUnique",
      query: async () => row,
    });

    expect(thrown).toBeUndefined();
    expect(result).toBe(row);
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("inheritedFlag")]).toBeUndefined();
    expect(owned?.[scalarKey("ownFlag")]).toBe(false);
  });
});

describe("prismaAdapter — default-deny and gate-before-startSpan", () => {
  it("captures nothing AND opens no owned span with an empty allow (master switch explicitly ON)", async () => {
    await runOperation({
      allow: [],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ muted: false }),
    });
    // Only the request span exists — no db.* owned span was opened.
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(["request"]);
  });

  it("opens no owned span when the capture master switch is off", async () => {
    _setCurrentConfig(configWith(false));
    await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ muted: false }),
    });
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["request"]);
  });

  it("does not capture a model that is not allowlisted", async () => {
    await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "User",
      operation: "findUnique",
      query: async () => ({ muted: false }),
    });
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["request"]);
  });
});

describe("prismaAdapter — bounded and edge-safe no-ops", () => {
  it("disables findMany (no per-row capture)", async () => {
    const rows = [{ muted: false }, { muted: true }];
    const { result } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findMany",
      query: async () => rows,
    });
    expect(result).toBe(rows);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["request"]);
  });

  it.each([
    {
      operation: "aggregate",
      result: Object.freeze({ _sum: Object.freeze({ total: 7 }), _count: 1 }),
    },
    {
      operation: "groupBy",
      result: Object.freeze([Object.freeze({ status: "open", _count: 7 })]),
    },
    {
      operation: "createManyAndReturn",
      result: Object.freeze([Object.freeze({ metric: 7 })]),
    },
    {
      operation: "updateManyAndReturn",
      result: Object.freeze([Object.freeze({ metric: 7 })]),
    },
  ])(
    "keeps the $operation result family inert",
    async ({ operation, result: operationResult }) => {
      const query = vi.fn(async () => operationResult);
      const { result, thrown } = await runOperation({
        allow: [{ model: "Order", column: "metric", as: "value" }],
        model: "Order",
        operation,
        query,
      });

      expect(thrown).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toBe(operationResult);
      expectNoOwnedSpan();
    },
  );

  it.each(["createMany", "updateMany", "deleteMany"])(
    "keeps the %s count map inert even when count is allowlisted",
    async (operation) => {
      const countResult = Object.freeze({ count: 7 });
      const query = vi.fn(async () => countResult);
      const { result, thrown } = await runOperation({
        allow: [{ model: "Order", column: "count", as: "value" }],
        model: "Order",
        operation,
        query,
      });

      expect(thrown).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toBe(countResult);
      expectNoOwnedSpan();
    },
  );

  it.each(["findRaw", "aggregateRaw"])(
    "keeps the model-scoped %s collision-shaped result inert",
    async (operation) => {
      const rawResult = Object.freeze({ metric: 7 });
      const query = vi.fn(async () => rawResult);
      const { result, thrown } = await runOperation({
        allow: [{ model: "Order", column: "metric", as: "value" }],
        model: "Order",
        operation,
        query,
      });

      expect(thrown).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(result).toBe(rawResult);
      expectNoOwnedSpan();
    },
  );

  it("fails closed for an unknown future operation", async () => {
    const unknownResult = Object.freeze({ metric: 7 });
    const query = vi.fn(async () => unknownResult);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "metric", as: "value" }],
      model: "Order",
      operation: "futureOperation",
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(unknownResult);
    expectNoOwnedSpan();
  });

  it("captures nothing on a runtime with no active request span (edge)", async () => {
    const { result } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ muted: false }),
      withRequestSpan: false,
    });
    expect(result).toEqual({ muted: false });
    expect(exporter.getFinishedSpans().some((s) => s.name.startsWith("db."))).toBe(
      false,
    );
  });

  it("handles a null result (findUnique miss) without throwing or capturing", async () => {
    const { result, thrown } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => null,
    });
    expect(thrown).toBeUndefined();
    expect(result).toBeNull();
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("mutedFlag")]).toBeUndefined();
  });

  it.each([
    { label: "primitive", result: 7 },
    { label: "array", result: Object.freeze([Object.freeze({ muted: false })]) },
  ])(
    "retains the $label result guard for an eligible operation",
    async ({ result: operationResult }) => {
      const { result, thrown } = await runOperation({
        allow: [{ model: "Poll", column: "muted" }],
        model: "Poll",
        operation: "findUnique",
        query: async () => operationResult,
      });

      expect(thrown).toBeUndefined();
      expect(result).toBe(operationResult);
      const owned = exporter
        .getFinishedSpans()
        .find((span) => span.name === "db.Poll.findUnique");
      expect(owned?.ended).toBe(true);
      expect(owned?.attributes[scalarKey("mutedFlag")]).toBeUndefined();
    },
  );
});

describe("prismaAdapter — pure observer", () => {
  it("re-throws a query error verbatim and still ends the owned span", async () => {
    const boom = new Error("db exploded");
    const { result, thrown } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => {
        throw boom;
      },
    });
    expect(result).toBeUndefined();
    expect(thrown).toBe(boom); // identical error instance, not wrapped
    // The owned span was opened and ended (no leak), carrying no scalar.
    const owned = exporter
      .getFinishedSpans()
      .find((s) => s.name === "db.Poll.findUnique");
    expect(owned).toBeDefined();
    expect(owned?.ended).toBe(true);
  });

  it("returns an eligible result unchanged when an allowlisted accessor throws during projection", async () => {
    const row = {};
    Object.defineProperty(row, "muted", {
      enumerable: true,
      get: () => {
        throw new Error("result accessor exploded");
      },
    });
    const query = vi.fn(async () => row);

    const { result, thrown } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query,
    });

    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(row);
    const owned = exporter
      .getFinishedSpans()
      .find((span) => span.name === "db.Poll.findUnique");
    expect(owned?.ended).toBe(true);
    expect(owned?.attributes[scalarKey("mutedFlag")]).toBeUndefined();
  });

  it("records a safe omission (not a captured value) for a non-boolean allowlisted column", async () => {
    await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ muted: "yes" }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("mutedFlag")]).toBeUndefined();
    expect(owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD]).toBe(
      1,
    );
  });
});

describe("prismaAdapter — never throws on an OTel API failure", () => {
  it("falls back to running the query when trace.getActiveSpan() throws", async () => {
    vi.spyOn(otelApi.trace, "getActiveSpan").mockImplementation(() => {
      throw new Error("otel api boom");
    });
    const row = { muted: false };
    const ext = prismaAdapter({ allow: [{ model: "Poll", column: "muted" }] });

    let result: unknown;
    let thrown: unknown;
    try {
      result = await ext.query.$allModels.$allOperations({
        model: "Poll",
        operation: "findUnique",
        args: {},
        query: async () => row,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(row); // query ran, result unchanged
    expect(
      exporter.getFinishedSpans().some((s) => s.name.startsWith("db.")),
    ).toBe(false);
  });

  it("falls back to running the query when startSpan throws", async () => {
    // Gate passes (an active span is present), then the owned-span open fails.
    vi.spyOn(otelApi.trace, "getActiveSpan").mockReturnValue({} as otelApi.Span);
    vi.spyOn(otelApi.trace, "getTracer").mockReturnValue({
      startSpan: () => {
        throw new Error("startSpan boom");
      },
    } as unknown as otelApi.Tracer);
    const row = { muted: true };
    const ext = prismaAdapter({ allow: [{ model: "Poll", column: "muted" }] });

    let result: unknown;
    let thrown: unknown;
    try {
      result = await ext.query.$allModels.$allOperations({
        model: "Poll",
        operation: "findUnique",
        args: {},
        query: async () => row,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(result).toBe(row);
  });
});

describe("prismaAdapter — optional config and non-recording spans", () => {
  it("is callable with no options / empty options and captures nothing", async () => {
    for (const ext of [prismaAdapter(), prismaAdapter({})]) {
      const result = await new Promise((resolve) => {
        tracer.startActiveSpan("request", async (reqSpan) => {
          const out = await ext.query.$allModels.$allOperations({
            model: "Poll",
            operation: "findUnique",
            args: {},
            query: async () => ({ muted: false }),
          });
          reqSpan.end();
          resolve(out);
        });
      });
      expect(result).toEqual({ muted: false });
    }
    expect(
      exporter.getFinishedSpans().some((s) => s.name.startsWith("db.")),
    ).toBe(false);
  });

  it("captures nothing when the active span is non-recording (sampled out)", async () => {
    vi.spyOn(otelApi.trace, "getActiveSpan").mockReturnValue({
      isRecording: () => false,
    } as unknown as otelApi.Span);
    const { result } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ muted: false }),
      withRequestSpan: false,
    });
    expect(result).toEqual({ muted: false });
    expect(
      exporter.getFinishedSpans().some((s) => s.name.startsWith("db.")),
    ).toBe(false);
  });
});

describe("prismaAdapter — non-boolean scalar intents (as)", () => {
  it("projects a numeric column onto the as-derived scalar as a native number", async () => {
    await runOperation({
      allow: [{ model: "Order", column: "total", as: "amount" }],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ total: 4200 }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("totalAmount")]).toBe(4200);
    expect(typeof owned?.[scalarKey("totalAmount")]).toBe("number");
  });

  it("projects multiple intents on one model (default flag + numerics)", async () => {
    await runOperation({
      allow: [
        { model: "Order", column: "paid" }, // as defaults to "flag"
        { model: "Order", column: "total", as: "amount" },
        { model: "Order", column: "size", as: "bytes" },
      ],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ paid: true, total: 99, size: 2048 }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("paidFlag")]).toBe(true);
    expect(owned?.[scalarKey("totalAmount")]).toBe(99);
    expect(owned?.[scalarKey("sizeBytes")]).toBe(2048);
  });

  it("rejects a non-number on a numeric intent (omission, no scalar)", async () => {
    await runOperation({
      allow: [{ model: "Order", column: "total", as: "amount" }],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ total: "lots" }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("totalAmount")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(1);
  });

  it("rejects a raw epoch on an `ms` intent but accepts a bounded delta", async () => {
    await runOperation({
      allow: [{ model: "Job", column: "elapsed", as: "ms" }],
      model: "Job",
      operation: "findUnique",
      query: async () => ({ elapsed: 1_700_000_000_000 }),
    });
    let owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("elapsedMs")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_TIMESTAMP],
    ).toBe(1);

    exporter.reset();
    await runOperation({
      allow: [{ model: "Job", column: "elapsed", as: "ms" }],
      model: "Job",
      operation: "findUnique",
      query: async () => ({ elapsed: 42 }),
    });
    owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("elapsedMs")]).toBe(42);
  });

  it("drops an entry with an out-of-contract `as` intent (default-deny)", async () => {
    await runOperation({
      allow: [
        {
          model: "Order",
          column: "total",
          as: "bogus" as unknown as ScalarIntent,
        },
      ],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ total: 4200 }),
    });
    // The only allow entry was dropped at construction, so no owned span opens.
    expect(
      exporter.getFinishedSpans().some((s) => s.name.startsWith("db.")),
    ).toBe(false);
  });

  it("drops an entry with a null `as` intent (untyped callers — default-deny)", async () => {
    await runOperation({
      allow: [
        { model: "Order", column: "paid", as: null as unknown as ScalarIntent },
      ],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ paid: true }),
    });
    // `null` is out-of-contract (not absent), so the entry is dropped — a
    // boolean `paid` column is NOT silently captured as a flag.
    expect(
      exporter.getFinishedSpans().some((s) => s.name.startsWith("db.")),
    ).toBe(false);
  });

  it.each([
    { as: "value", suffix: "Value" },
    { as: "amount", suffix: "Amount" },
    { as: "ms", suffix: "Ms" },
    { as: "bytes", suffix: "Bytes" },
    { as: "ratio", suffix: "Ratio" },
  ] as ReadonlyArray<{ as: ScalarIntent; suffix: string }>)(
    "projects a finite number onto the $suffix scalar for the '$as' intent",
    async ({ as, suffix }) => {
      await runOperation({
        allow: [{ model: "Order", column: "metric", as }],
        model: "Order",
        operation: "findUnique",
        query: async () => ({ metric: 7 }),
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[scalarKey(`metric${suffix}`)]).toBe(7);
      expect(typeof owned?.[scalarKey(`metric${suffix}`)]).toBe("number");
    },
  );

  it("does not double the suffix when the column already ends in it", async () => {
    await runOperation({
      allow: [{ model: "Job", column: "elapsedMs", as: "ms" }],
      model: "Job",
      operation: "findUnique",
      query: async () => ({ elapsedMs: 42 }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("elapsedMs")]).toBe(42);
    expect(owned?.[scalarKey("elapsedMsMs")]).toBeUndefined();
  });

  it("omits a Prisma Decimal (non-native-number object), never lossily converting it", async () => {
    // Prisma represents Decimal columns as Decimal.js objects, not numbers.
    const decimalLike = { toNumber: () => 4200, toString: () => "4200.00" };
    await runOperation({
      allow: [{ model: "Order", column: "total", as: "amount" }],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ total: decimalLike }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("totalAmount")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_RAW_PAYLOAD],
    ).toBe(1);
  });
});

describe("prismaAdapter — id intent (full-fidelity pseudonymized capture)", () => {
  const HMAC_KEY = "adapter-test-hmac-secret-do-not-use";

  function setFullConfig(attrHmacKey: string | undefined): void {
    const init = configWith(true);
    init.config.captureFidelity = "full";
    if (attrHmacKey !== undefined) init.config.attrHmacKey = attrHmacKey;
    _setCurrentConfig(init);
  }

  it("projects an *Id column as a pseudonymized gthid_ token; the raw id never reaches the wire", async () => {
    setFullConfig(HMAC_KEY);
    const rawId = "550e8400-e29b-41d4-a716-446655440000";
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: rawId }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("ownerId")]).toBe(await hashIdWeb(rawId, HMAC_KEY));
    expect(owned?.[scalarKey("ownerId")]).toMatch(/^gthid_[0-9a-f]{32}$/);
    // Privacy: the raw id is on no attribute of the owned span.
    expect(Object.values(owned ?? {})).not.toContain(rawId);
  });

  it("does not double the Id suffix when the column already ends in Id", async () => {
    setFullConfig(HMAC_KEY);
    const rawId = "u-7";
    await runOperation({
      allow: [{ model: "User", column: "userId", as: "id" }],
      model: "User",
      operation: "findUnique",
      query: async () => ({ userId: rawId }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("userId")]).toBe(await hashIdWeb(rawId, HMAC_KEY));
    expect(owned?.[scalarKey("userIdId")]).toBeUndefined();
  });

  it("coerces a numeric id to a string before hashing", async () => {
    setFullConfig(HMAC_KEY);
    await runOperation({
      allow: [{ model: "Order", column: "owner", as: "id" }],
      model: "Order",
      operation: "findUnique",
      query: async () => ({ owner: 12345 }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("ownerId")]).toBe(await hashIdWeb("12345", HMAC_KEY));
  });

  it("opens no span for an id-only allowlist under strict (zero overhead until full)", async () => {
    _setCurrentConfig(configWith(true)); // strict (captureFidelity unset)
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: "u-1" }),
    });
    // Identifier capture is off under strict: no owned span, scalar, or omission.
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["request"]);
  });

  it("still opens a span for a mixed model under strict (an eager column warrants it)", async () => {
    _setCurrentConfig(configWith(true)); // strict
    await runOperation({
      allow: [
        { model: "Poll", column: "owner", as: "id" },
        { model: "Poll", column: "muted", as: "flag" },
      ],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: "u-1", muted: true }),
    });
    const owned = ownedSpanAttrs();
    // The eager boolean captures; under strict the id intent is silently off —
    // neither a token NOR an `unhashed_id` omission is recorded, even though the
    // owned span exists (a real place an omission could otherwise land). This is
    // the SDK end of the served-`strict` invariant: when the backend normalizes
    // a `full`-without-key config to `strict` at the wire, an id column produces
    // no omission counter, not just no token.
    expect(owned?.[scalarKey("mutedFlag")]).toBe(true);
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBeUndefined();
  });

  it("fail-closed under full with no provisioned key: records unhashed_id, emits no token", async () => {
    setFullConfig(undefined);
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: "u-1" }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBe(1);
  });

  it("fail-closed for a non-string/number id (an object): unhashed_id, no token", async () => {
    setFullConfig(HMAC_KEY);
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: { nested: "x" } }),
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBe(1);
  });

  it("remains a pure observer: returns the result unchanged and ends the owned span despite the async hash", async () => {
    setFullConfig(HMAC_KEY);
    const row = { owner: "u-9" };
    const { result } = await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => row,
    });
    expect(result).toBe(row); // identity preserved despite awaiting the hash
    const owned = exporter
      .getFinishedSpans()
      .find((s) => s.name === "db.Poll.findUnique");
    expect(owned?.ended).toBe(true);
  });

  it("fail-closed when Web Crypto rejects: records unhashed_id and still projects later columns on the row", async () => {
    setFullConfig(HMAC_KEY);
    vi.spyOn(globalThis.crypto.subtle, "sign").mockRejectedValue(
      new Error("subtle unavailable"),
    );
    await runOperation({
      allow: [
        { model: "Poll", column: "owner", as: "id" },
        { model: "Poll", column: "active", as: "flag" },
      ],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: "u-1", active: true }),
    });
    const owned = ownedSpanAttrs();
    // The id hash failed → no token, but a counted unhashed_id omission...
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBe(1);
    // ...and the later boolean column on the same row is still captured.
    expect(owned?.[scalarKey("activeFlag")]).toBe(true);
  });

  it("fail-closed: a raw value already shaped like a gthid_ token is not emitted when the gate is unmet", async () => {
    setFullConfig(undefined); // full, but no provisioned key
    const tokenShaped = `gthid_${"a".repeat(32)}`; // passes the strict *Id shape
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => ({ owner: tokenShaped }),
    });
    const owned = ownedSpanAttrs();
    // The gate (full + key) is unmet, so even a token-shaped raw value is
    // dropped and counted — never emitted as an unkeyed token.
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBe(1);
  });

  it("records no omission when capture is disabled mid-operation (gate re-checked at emit)", async () => {
    // The gate passes at the start (full + capture enabled), then a heartbeat
    // init disables capture while the query is in flight — but the account is
    // still `full` with no key, so projection reaches the fail-closed path.
    setFullConfig(undefined);
    await runOperation({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      operation: "findUnique",
      query: async () => {
        const disabled = configWith(false); // sideEffectEvidence off
        disabled.config.captureFidelity = "full";
        _setCurrentConfig(disabled);
        return { owner: "u-1" };
      },
    });
    const owned = ownedSpanAttrs();
    expect(owned?.[scalarKey("ownerId")]).toBeUndefined();
    // Capture was disabled before emit, so even the omission counter is
    // suppressed — disabled capture writes nothing.
    expect(
      owned?.[GLASSTRACE_ATTRIBUTE_NAMES.SIDE_EFFECT_OMITTED_UNHASHED_ID],
    ).toBeUndefined();
  });
});
