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
  type PrismaAggregateCaptureEntry,
  type ScalarIntent,
} from "../../../packages/sdk/src/adapters/prisma.js";
import {
  accessorKeyEntry,
  accessorResult,
  aggregateEntry,
  countAllEntry,
  countFieldEntry,
  decimalLike,
  exactBudgetAllowlist,
  holedAllowlist,
  inheritedKeyEntry,
  justOverBudgetAllowlist,
  overBudgetAllowlist,
  revokedAllowlistProxy,
  throwingAllowlistProxy,
  throwingResultProxy,
  underBudgetAllowlist,
} from "./prisma-result-fixtures.js";
import { hashIdWeb } from "../../../packages/sdk/src/side-effect/hash-id-web.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../packages/protocol/src/wire.js";
import {
  GLASSTRACE_ATTRIBUTE_NAMES,
  RESULT_EVIDENCE_ATTRIBUTE_PREFIX,
  RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
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
  /** Phase 1 aggregate-result allowlist, forwarded to the adapter. */
  aggregateAllow?: ReadonlyArray<PrismaAggregateCaptureEntry>;
  model: string;
  operation: string;
  /** Operation arguments forwarded unchanged to the query callback. */
  args?: unknown;
  query: (args: unknown) => Promise<unknown>;
  /** Omit to simulate an edge runtime with no active request span. */
  withRequestSpan?: boolean;
}): Promise<{ result: unknown; thrown: unknown }> {
  const ext = prismaAdapter({
    allow: opts.allow,
    aggregateAllow: opts.aggregateAllow,
  });
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

describe("result-evidence wire-v1 inertness regression", () => {
  // The result-evidence protocol ships ahead of any producer. These
  // regressions prove the widened-result operations stay inert even
  // when the server grants both result-evidence capabilities: no owned
  // span, no `glasstrace.side_effect.result.v1.*` attribute, and no
  // row-scalar (`scalar.r<n>.*`) attribute may appear anywhere.
  function grantBothCapabilities(): void {
    const granted = configWith(true);
    granted.config.resultEvidenceCapabilities = {
      wireVersion: 1,
      aggregateScalars: true,
      boundedRows: true,
    };
    _setCurrentConfig(granted);
  }

  function expectNoResultEvidenceAttributes(): void {
    const attributeKeys = exporter
      .getFinishedSpans()
      .flatMap((span) => Object.keys(span.attributes ?? {}));
    expect(
      attributeKeys.filter((key) =>
        key.startsWith(RESULT_EVIDENCE_ATTRIBUTE_PREFIX),
      ),
    ).toEqual([]);
    // Family-1/2 evidence is flat scalars plus the marker, so the
    // whole scalar channel must also stay silent — a partial flat
    // emission would otherwise slip past a result.v1-only filter.
    expect(
      attributeKeys.filter((key) =>
        key.startsWith(SIDE_EFFECT_SCALAR_PREFIX),
      ),
    ).toEqual([]);
  }

  it("count emits no result evidence with both capabilities granted", async () => {
    grantBothCapabilities();
    const countResult = Object.freeze({ _all: 7 });
    const query = vi.fn(async () => countResult);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "metric", as: "value" }],
      model: "Order",
      operation: "count",
      query,
    });
    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(countResult);
    expectNoOwnedSpan();
    expectNoResultEvidenceAttributes();
  });

  it("aggregate emits no result evidence with both capabilities granted", async () => {
    grantBothCapabilities();
    const aggregateResult = Object.freeze({
      _sum: Object.freeze({ total: 7 }),
      _count: 1,
    });
    const query = vi.fn(async () => aggregateResult);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "total", as: "amount" }],
      model: "Order",
      operation: "aggregate",
      query,
    });
    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(aggregateResult);
    expectNoOwnedSpan();
    expectNoResultEvidenceAttributes();
  });

  it("findMany emits no result evidence with both capabilities granted", async () => {
    grantBothCapabilities();
    const rows = [{ muted: false }, { muted: true }];
    const query = vi.fn(async () => rows);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Poll", column: "muted" }],
      model: "Poll",
      operation: "findMany",
      query,
    });
    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(rows);
    expectNoOwnedSpan();
    expectNoResultEvidenceAttributes();
  });

  it("groupBy emits no result evidence with both capabilities granted", async () => {
    grantBothCapabilities();
    const groupResult = Object.freeze([
      Object.freeze({ status: "open", _count: 7 }),
    ]);
    const query = vi.fn(async () => groupResult);
    const { result, thrown } = await runOperation({
      allow: [{ model: "Order", column: "metric", as: "value" }],
      model: "Order",
      operation: "groupBy",
      query,
    });
    expect(thrown).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toBe(groupResult);
    expectNoOwnedSpan();
    expectNoResultEvidenceAttributes();
  });
});

describe("Phase 1 aggregate-result capture (family 1 / family 2)", () => {
  // The protocol constant, not a re-typed literal, so a wire-string change
  // cannot silently diverge between producer tests and the contract.
  const FAMILY_KEY = RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY;

  /** Grants the aggregate-scalars capability (family 1/2) on the active config. */
  function grantAggregateScalars(boundedRows = false): void {
    const granted = configWith(true);
    granted.config.resultEvidenceCapabilities = {
      wireVersion: 1,
      aggregateScalars: true,
      boundedRows,
    };
    _setCurrentConfig(granted);
  }

  describe("admission and capability gating", () => {
    it("captures a bare count number under a _all selector as family 1", async () => {
      grantAggregateScalars();
      const query = vi.fn(async () => 42);
      const { result, thrown } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query,
      });
      expect(thrown).toBeUndefined();
      expect(result).toBe(42);
      expect(query).toHaveBeenCalledTimes(1);
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      expect(owned?.[scalarKey("matchedAmount")]).toBe(42);
    });

    it("captures a selected _all count map as family 1", async () => {
      grantAggregateScalars();
      const countResult = Object.freeze({ _all: 9 });
      await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: async () => countResult,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      expect(owned?.[scalarKey("matchedAmount")]).toBe(9);
    });

    it("captures a concrete count field only from its own flat property", async () => {
      grantAggregateScalars();
      const countResult = Object.freeze({ metric: 7, other: 3 });
      await runOperation({
        allow: [],
        aggregateAllow: [countFieldEntry("metric", "metricAmount")],
        model: "Order",
        operation: "count",
        query: async () => countResult,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      expect(owned?.[scalarKey("metricAmount")]).toBe(7);
      expect(owned?.[scalarKey("otherAmount")]).toBeUndefined();
    });

    it("captures aggregate buckets as family 2, several selections at once", async () => {
      grantAggregateScalars();
      const aggregateResult = Object.freeze({
        _sum: Object.freeze({ total: 1234.5 }),
        _avg: Object.freeze({ total: 205.75 }),
        _min: Object.freeze({ total: 1 }),
        _max: Object.freeze({ total: 999 }),
        _count: Object.freeze({ total: 6 }),
      });
      await runOperation({
        allow: [],
        aggregateAllow: [
          aggregateEntry("_sum", "total", "sumAmount"),
          aggregateEntry("_avg", "total", "avgAmount"),
          aggregateEntry("_min", "total", "minAmount"),
          aggregateEntry("_max", "total", "maxAmount"),
          aggregateEntry("_count", "total", "rowsAmount"),
        ],
        model: "Order",
        operation: "aggregate",
        query: async () => aggregateResult,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(2);
      expect(owned?.[scalarKey("sumAmount")]).toBe(1234.5);
      expect(owned?.[scalarKey("avgAmount")]).toBe(205.75);
      expect(owned?.[scalarKey("minAmount")]).toBe(1);
      expect(owned?.[scalarKey("maxAmount")]).toBe(999);
      expect(owned?.[scalarKey("rowsAmount")]).toBe(6);
    });

    it("admits the _count._all exception when the bucket itself is a number", async () => {
      grantAggregateScalars();
      const aggregateResult = Object.freeze({ _count: 11 });
      await runOperation({
        allow: [],
        aggregateAllow: [
          { model: "Order", operation: "aggregate", aggregate: "_count", field: "_all", key: "rowsAmount" },
        ],
        model: "Order",
        operation: "aggregate",
        query: async () => aggregateResult,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(2);
      expect(owned?.[scalarKey("rowsAmount")]).toBe(11);
    });

    it.each([
      ["capability absent", () => _setCurrentConfig(configWith(true))],
      [
        "aggregateScalars false",
        () => {
          const granted = configWith(true);
          granted.config.resultEvidenceCapabilities = {
            wireVersion: 1,
            aggregateScalars: false,
            boundedRows: true,
          };
          _setCurrentConfig(granted);
        },
      ],
      [
        "master capture switch off",
        () => {
          const granted = configWith(false);
          granted.config.resultEvidenceCapabilities = {
            wireVersion: 1,
            aggregateScalars: true,
            boundedRows: false,
          };
          _setCurrentConfig(granted);
        },
      ],
    ])("opens no span when %s", async (_label, setup) => {
      setup();
      const query = vi.fn(async () => 42);
      const { result } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query,
      });
      expect(result).toBe(42);
      expect(query).toHaveBeenCalledTimes(1);
      expectNoOwnedSpan();
    });

    it("opens no span without a recording request span", async () => {
      grantAggregateScalars();
      const { result } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: async () => 42,
        withRequestSpan: false,
      });
      expect(result).toBe(42);
      expect(exporter.getFinishedSpans()).toEqual([]);
    });

    it("a config refresh applies to the next operation", async () => {
      grantAggregateScalars();
      const aggregateAllow = [countAllEntry("Order", "matchedAmount")];
      await runOperation({
        allow: [],
        aggregateAllow,
        model: "Order",
        operation: "count",
        query: async () => 1,
      });
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBe(1);
      exporter.reset();

      _setCurrentConfig(configWith(true)); // capability revoked
      await runOperation({
        allow: [],
        aggregateAllow,
        model: "Order",
        operation: "count",
        query: async () => 2,
      });
      expectNoOwnedSpan();
    });

    it("the admission view governs an operation across a mid-query refresh", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: async () => {
          // Capability revoked while the query is in flight: the operation
          // already admitted under its coherent view, so the family still
          // emits; the receiver independently rechecks current state.
          _setCurrentConfig(configWith(true));
          return 5;
        },
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      expect(owned?.[scalarKey("matchedAmount")]).toBe(5);
    });

    it.each(["groupBy", "createMany", "findMany", "aggregateRaw", "findRaw"])(
      "%s stays inert even with an aggregate allowlist and capability granted",
      async (operation) => {
        grantAggregateScalars(true);
        const opResult = Object.freeze({ _all: 7 });
        const query = vi.fn(async () => opResult);
        const { result } = await runOperation({
          allow: [],
          aggregateAllow: [countAllEntry("Order", "matchedAmount")],
          model: "Order",
          operation,
          query,
        });
        expect(result).toBe(opResult);
        expect(query).toHaveBeenCalledTimes(1);
        expectNoOwnedSpan();
      },
    );

    it("a model without a bucket stays inert", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "User",
        operation: "count",
        query: async () => 42,
      });
      expectNoOwnedSpan();
    });
  });

  describe("allowlist validation (default-deny, bounded, hostile-safe)", () => {
    it.each([
      // Each case runs the operation against exactly the model and
      // operation the entry names, so removing the named validation check
      // makes the entry compile and emit — failing the test — rather than
      // the case passing vacuously against an unrelated model.
      ["bad model grammar", { ...countAllEntry(), model: "bad-name" }, "bad-name", "count"],
      ["model over 64 chars", { ...countAllEntry(), model: "A".repeat(65) }, "A".repeat(65), "count"],
      ["unknown operation", { ...countAllEntry(), operation: "Count" }, "Order", "Count"],
      ["unknown aggregate", { ...countAllEntry(), aggregate: "_median" }, "Order", "count"],
      ["count with a non-_count bucket", { ...countAllEntry(), aggregate: "_sum" }, "Order", "count"],
      ["_all on a non-_count bucket", aggregateEntry("_avg", "_all", "avgAmount"), "Order", "aggregate"],
      ["key with an Id suffix", { ...countAllEntry(), key: "ownerId" }, "Order", "count"],
      ["key with a Flag suffix", { ...countAllEntry(), key: "activeFlag" }, "Order", "count"],
      ["key outside the scalar grammar", { ...countAllEntry(), key: "snake_caseAmount" }, "Order", "count"],
      ["key over the 80-char cap", { ...countAllEntry(), key: `${"a".repeat(79)}Ms` }, "Order", "count"],
      ["non-object entry", "entry", "Order", "count"],
    ])("drops an entry with %s (default-deny)", async (_label, entry, model, operation) => {
      grantAggregateScalars();
      const query = vi.fn(async () =>
        operation === "aggregate"
          ? Object.freeze({ _avg: Object.freeze({ _all: 7 }) })
          : 42,
      );
      await runOperation({
        allow: [],
        aggregateAllow: [entry as PrismaAggregateCaptureEntry],
        model,
        operation,
        query,
      });
      expect(query).toHaveBeenCalledTimes(1);
      expectNoOwnedSpan();
    });

    it("collapses a byte-identical duplicate to its first occurrence", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry(), countAllEntry()],
        model: "Order",
        operation: "count",
        query: async () => 3,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      expect(owned?.[scalarKey("matchedAmount")]).toBe(3);
    });

    it.each([
      [
        "a conflicting selector (same selector, different key)",
        [countAllEntry("Order", "matchedAmount"), countAllEntry("Order", "otherAmount")],
      ],
      [
        "a duplicate output key across selectors",
        [
          countFieldEntry("metric", "metricAmount"),
          countFieldEntry("other", "metricAmount"),
        ],
      ],
      [
        "more than 16 distinct selectors in one bucket",
        Array.from({ length: 17 }, (_, i) =>
          countFieldEntry(`field${i}`, `field${i}Amount`),
        ),
      ],
    ])("fails a bucket closed on %s", async (_label, aggregateAllow) => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow,
        model: "Order",
        operation: "count",
        query: async () => Object.freeze({ metric: 1, other: 2, field0: 3 }),
      });
      expectNoOwnedSpan();
    });

    it("admits exactly 16 distinct selectors in one bucket", async () => {
      grantAggregateScalars();
      const aggregateAllow = Array.from({ length: 16 }, (_, i) =>
        countFieldEntry(`field${i}`, `field${i}Amount`),
      );
      const countResult = Object.freeze(
        Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [`field${i}`, i + 1]),
        ),
      );
      await runOperation({
        allow: [],
        aggregateAllow,
        model: "Order",
        operation: "count",
        query: async () => countResult,
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(1);
      for (let i = 0; i < 16; i += 1) {
        expect(owned?.[scalarKey(`field${i}Amount`)]).toBe(i + 1);
      }
    });

    it("stays within the raw-position budget for a 42-entry policy", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: underBudgetAllowlist(),
        model: "Model0",
        operation: "count",
        query: async () => 4,
      });
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBe(1);
    });

    it("compiles at exactly raw position 256", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: exactBudgetAllowlist(),
        model: "Model0",
        operation: "count",
        query: async () => 4,
      });
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBe(1);
    });

    it("fails the whole policy closed at raw position 257", async () => {
      grantAggregateScalars();
      // One position past the budget — even the FIRST entry admits
      // nothing: overflow fails the whole policy closed, never truncates.
      await runOperation({
        allow: [],
        aggregateAllow: justOverBudgetAllowlist(),
        model: "Model0",
        operation: "count",
        query: async () => 4,
      });
      expectNoOwnedSpan();
    });

    it("fails the whole policy closed for a 43-entry object list", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: overBudgetAllowlist(),
        model: "Model0",
        operation: "count",
        query: async () => 4,
      });
      expectNoOwnedSpan();
    });

    it.each([
      // Every case runs against a model that a VALID entry in the hostile
      // list names (the sibling "Other" entry, or "Order" for the
      // single-entry proxy cases), so surviving compilation would emit and
      // fail the test — proving whole-policy inertness discriminately.
      ["an accessor-backed entry member", [countAllEntry("Other", "otherAmount"), accessorKeyEntry()], "Other"],
      ["an inherited entry member", [countAllEntry("Other", "otherAmount"), inheritedKeyEntry()], "Other"],
      ["a throwing allowlist proxy", throwingAllowlistProxy(), "Order"],
      ["a revoked allowlist proxy", revokedAllowlistProxy(), "Order"],
      ["a non-array allowlist", { 0: countAllEntry() }, "Order"],
      ["an array hole", holedAllowlist(), "Other"],
    ])("fails the whole policy closed on %s", async (_label, aggregateAllow, model) => {
      grantAggregateScalars();
      // The otherwise-valid entries admit nothing either.
      await runOperation({
        allow: [],
        aggregateAllow: aggregateAllow as ReadonlyArray<PrismaAggregateCaptureEntry>,
        model,
        operation: "count",
        query: async () => 4,
      });
      expectNoOwnedSpan();
    });
  });

  describe("value admission and privacy", () => {
    async function runSingleAggregate(
      key: string,
      value: unknown,
      aggregate: PrismaAggregateCaptureEntry["aggregate"] = "_sum",
    ): Promise<Record<string, unknown> | undefined> {
      await runOperation({
        allow: [],
        aggregateAllow: [aggregateEntry(aggregate, "total", key)],
        model: "Order",
        operation: "aggregate",
        query: async () =>
          Object.freeze({ [aggregate]: Object.freeze({ total: value }) }),
      });
      return ownedSpanAttrs();
    }

    it("admits numeric edges: zero, negatives, fractions, sub-threshold magnitudes", async () => {
      grantAggregateScalars();
      expect((await runSingleAggregate("zeroAmount", 0))?.[scalarKey("zeroAmount")]).toBe(0);
      exporter.reset();
      grantAggregateScalars();
      expect((await runSingleAggregate("deltaAmount", -12.5))?.[scalarKey("deltaAmount")]).toBe(-12.5);
      exporter.reset();
      grantAggregateScalars();
      expect(
        (await runSingleAggregate("bigBytes", Number.MAX_SAFE_INTEGER))?.[
          scalarKey("bigBytes")
        ],
      ).toBe(Number.MAX_SAFE_INTEGER);
      exporter.reset();
      grantAggregateScalars();
      expect(
        (await runSingleAggregate("okValue", 999_999_999))?.[scalarKey("okValue")],
      ).toBe(999_999_999);
    });

    it.each([
      ["a timestamp-shaped *Value at 1e9", "startValue", 1_000_000_000, "raw_timestamp"],
      ["a timestamp-shaped *Ms at 1e12", "epochMs", 1_000_000_000_000, "raw_timestamp"],
      ["a fractional epoch *Ms", "epochMs", 1_700_000_000_000.5, "raw_timestamp"],
      ["an unsafe integer", "hugeAmount", 2 ** 53, "raw_payload"],
      ["NaN", "nanAmount", NaN, "non_finite"],
      ["Infinity", "infAmount", Infinity, "non_finite"],
      ["a numeric string", "strAmount", "7", "raw_payload"],
      ["a boolean", "boolAmount", true, "raw_payload"],
      ["a BigInt", "bigintAmount", BigInt(7), "raw_payload"],
      ["a Decimal-like object", "decAmount", decimalLike("1.5"), "raw_payload"],
      ["null", "nullAmount", null, "raw_payload"],
      ["a Date", "dateAmount", new Date(), "raw_payload"],
      ["an array", "arrAmount", [7], "raw_payload"],
    ])(
      "omits %s with a bounded reason and no family",
      async (_label, key, value, reason) => {
        grantAggregateScalars();
        const owned = await runSingleAggregate(key, value);
        expect(owned?.[FAMILY_KEY]).toBeUndefined();
        expect(owned?.[scalarKey(key)]).toBeUndefined();
        expect(
          owned?.[`glasstrace.side_effect.omitted.${reason}`],
        ).toBe(1);
      },
    );

    it("rejects a negative or fractional _count value", async () => {
      grantAggregateScalars();
      let owned = await runSingleAggregate("rowsAmount", -1, "_count");
      expect(owned?.[FAMILY_KEY]).toBeUndefined();
      expect(owned?.["glasstrace.side_effect.omitted.raw_payload"]).toBe(1);
      exporter.reset();
      grantAggregateScalars();
      owned = await runSingleAggregate("rowsAmount", 1.5, "_count");
      expect(owned?.[FAMILY_KEY]).toBeUndefined();
    });

    it("emits the surviving scalars when only some candidates are invalid", async () => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: [
          aggregateEntry("_sum", "total", "sumAmount"),
          aggregateEntry("_avg", "total", "avgAmount"),
        ],
        model: "Order",
        operation: "aggregate",
        query: async () =>
          Object.freeze({
            _sum: Object.freeze({ total: 100 }),
            _avg: Object.freeze({ total: "bad" }),
          }),
      });
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBe(2);
      expect(owned?.[scalarKey("sumAmount")]).toBe(100);
      expect(owned?.[scalarKey("avgAmount")]).toBeUndefined();
      expect(owned?.["glasstrace.side_effect.omitted.raw_payload"]).toBe(1);
    });
  });

  describe("result observation (own data only, hostile-safe)", () => {
    it("never invokes an accessor-backed result field", async () => {
      grantAggregateScalars();
      const { result: hostileResult, getterCalls } = accessorResult("metric");
      await runOperation({
        allow: [],
        aggregateAllow: [countFieldEntry("metric", "metricAmount")],
        model: "Order",
        operation: "count",
        query: async () => hostileResult,
      });
      expect(getterCalls()).toBe(0);
      const owned = ownedSpanAttrs();
      expect(owned?.[FAMILY_KEY]).toBeUndefined();
      expect(owned?.[scalarKey("metricAmount")]).toBeUndefined();
    });

    it("ignores an inherited result field", async () => {
      grantAggregateScalars();
      const inherited = Object.create({ metric: 7 });
      await runOperation({
        allow: [],
        aggregateAllow: [countFieldEntry("metric", "metricAmount")],
        model: "Order",
        operation: "count",
        query: async () => inherited,
      });
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBeUndefined();
    });

    it("keeps a throwing result proxy inert with identity preserved", async () => {
      grantAggregateScalars();
      const hostile = throwingResultProxy();
      const { result, thrown } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: async () => hostile,
      });
      expect(thrown).toBeUndefined();
      expect(result).toBe(hostile);
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBeUndefined();
    });

    it.each([
      ["an array result", Object.freeze([7])],
      ["a null result", null],
      ["a string result", "7"],
      ["an array aggregate bucket", Object.freeze({ _sum: Object.freeze([7]) })],
      ["a numeric non-_all bucket", Object.freeze({ _sum: 7 })],
    ])("keeps %s inert", async (_label, unsupported) => {
      grantAggregateScalars();
      await runOperation({
        allow: [],
        aggregateAllow: [aggregateEntry("_sum", "total", "sumAmount")],
        model: "Order",
        operation: "aggregate",
        query: async () => unsupported,
      });
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBeUndefined();
    });
  });

  describe("pure observation", () => {
    it("forwards arguments by identity and never inspects them", async () => {
      grantAggregateScalars();
      let structuralReads = 0;
      const rejectRead = (): never => {
        structuralReads += 1;
        throw new Error("the adapter must not inspect count/aggregate args");
      };
      const rawArgs = { where: { active: true } };
      const guardedArgs = new Proxy(rawArgs, {
        get: rejectRead,
        has: rejectRead,
        ownKeys: rejectRead,
        getOwnPropertyDescriptor: rejectRead,
      });
      let seenArgs: unknown;
      await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        args: guardedArgs,
        query: async (args) => {
          seenArgs = args;
          return 42;
        },
      });
      expect(seenArgs).toBe(guardedArgs);
      expect(structuralReads).toBe(0);
      expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBe(1);
    });

    it("propagates a query rejection verbatim with the span ended and no family", async () => {
      grantAggregateScalars();
      const sentinel = new Error("aggregate sentinel");
      const { result, thrown } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: async () => {
          throw sentinel;
        },
      });
      expect(result).toBeUndefined();
      expect(thrown).toBe(sentinel);
      const owned = exporter
        .getFinishedSpans()
        .find((s) => s.name === "db.Order.count");
      expect(owned).toBeDefined();
      expect(owned?.attributes[FAMILY_KEY]).toBeUndefined();
    });

    it("propagates a synchronous query throw verbatim", async () => {
      grantAggregateScalars();
      const sentinel = new Error("sync sentinel");
      const { thrown } = await runOperation({
        allow: [],
        aggregateAllow: [countAllEntry("Order", "matchedAmount")],
        model: "Order",
        operation: "count",
        query: (() => {
          throw sentinel;
        }) as unknown as (args: unknown) => Promise<unknown>,
      });
      expect(thrown).toBe(sentinel);
    });

    it("a host attribute-count limit drops the marker before any scalar (fail-closed truncation)", async () => {
      // Rebuild the harness provider with a tight span attribute limit.
      // OTel silently drops attribute writes beyond the limit; because the
      // adapter attaches the family marker LAST, a truncated bundle loses
      // its marker — the receiver then strips the unmarked remainder
      // instead of retaining a shape-valid partial family as complete.
      await provider.shutdown();
      otelApi.trace.disable();
      exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
        spanLimits: { attributeCountLimit: 3 },
      });
      otelApi.trace.setGlobalTracerProvider(provider);
      tracer = otelApi.trace.getTracer("glasstrace-prisma-test");
      grantAggregateScalars();

      const aggregateAllow = Array.from({ length: 5 }, (_, i) =>
        countFieldEntry(`field${i}`, `field${i}Amount`),
      );
      const countResult = Object.freeze(
        Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`field${i}`, i + 1]),
        ),
      );
      const { result, thrown } = await runOperation({
        allow: [],
        aggregateAllow,
        model: "Order",
        operation: "count",
        query: async () => countResult,
      });
      expect(thrown).toBeUndefined();
      expect(result).toBe(countResult);
      const owned = ownedSpanAttrs();
      // The truncation genuinely happened: the earliest scalars survived
      // the limit (so the bundle write ran), later ones were dropped, and
      // the marker — written last — was dropped too. No receiver can
      // retain this as a complete family.
      expect(owned).toBeDefined();
      expect(owned?.[scalarKey("field0Amount")]).toBe(1);
      expect(owned?.[scalarKey("field4Amount")]).toBeUndefined();
      expect(owned?.[FAMILY_KEY]).toBeUndefined();
      expect(Object.keys(owned ?? {}).length).toBeLessThanOrEqual(3);
    });

    it("keeps the host unaffected when attribute emission itself fails", async () => {
      grantAggregateScalars();
      // Spy on the live span prototype (shared by every span this
      // provider creates, including the adapter's owned span) so the
      // bundle write throws inside the projection fence.
      const probe = tracer.startSpan("prototype-probe");
      const spanPrototype = Object.getPrototypeOf(probe) as {
        setAttributes: (attributes: Record<string, unknown>) => unknown;
      };
      probe.end();
      exporter.reset();
      const original = spanPrototype.setAttributes;
      // Throw only for the scalar-bundle write; span construction and any
      // other attribute write pass through, so only the adapter's bundle
      // call fails — and the marker write that follows it in the same
      // fence is skipped.
      const setAttributesSpy = vi
        .spyOn(spanPrototype, "setAttributes")
        .mockImplementation(function (
          this: unknown,
          attributes: Record<string, unknown>,
        ) {
          const isScalarBundle =
            attributes !== null &&
            typeof attributes === "object" &&
            Object.keys(attributes).some((key) =>
              key.startsWith(SIDE_EFFECT_SCALAR_PREFIX),
            );
          if (isScalarBundle) {
            throw new Error("attribute sink failure");
          }
          return original.call(this as never, attributes);
        });
      try {
        const query = vi.fn(async () => 42);
        const { result, thrown } = await runOperation({
          allow: [],
          aggregateAllow: [countAllEntry("Order", "matchedAmount")],
          model: "Order",
          operation: "count",
          query,
        });
        expect(thrown).toBeUndefined();
        expect(result).toBe(42);
        expect(query).toHaveBeenCalledTimes(1);
        // The bundle write failed inside the fence: the evidence is inert
        // and the owned span still ended.
        expect(ownedSpanAttrs()?.[FAMILY_KEY]).toBeUndefined();
      } finally {
        setAttributesSpy.mockRestore();
      }
    });
  });
});
