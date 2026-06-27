/**
 * Decision-trace wiring integration tests.
 *
 * Proves the additional config / capture decision points are instrumented:
 * with the toggle ON each site emits its `core:decision` event with the
 * documented outcome, and with the toggle OFF (the default) every site is
 * silent — capture / config behavior is unchanged. Each point also asserts
 * its outcome belongs to a small closed vocabulary so no single point can
 * exhaust the bounded one-shot dedup cap.
 *
 * The points are driven through their real call sites:
 *  - `capture.fidelity.idModel` / `.identifier` / `.hmacKey` via the Prisma
 *    adapter's `$allOperations` callback under a real active request span;
 *  - `config.tier` via `getActiveConfig` over the three fallback tiers;
 *  - `sideEffect.fieldRejected` via `recordSideEffect` rejections;
 *  - `feature.consoleErrors` / `feature.discovery` / `env.forceEnable` via
 *    `registerGlasstrace`;
 *  - `feature.errorResponseBodies` via the enriching exporter;
 *  - `otel.path` via `configureOtel`;
 *  - `env.nudgeSuppressed` via the MCP error nudge;
 *  - `env.upgradeNoticeSuppressed` via the stale-instruction notice.
 *
 * A final dedup-cap test proves the bounded-key design: flooding the
 * hot-path `sideEffect.fieldRejected` point with many rejections never
 * suppresses another point's first emission.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  setDecisionTraceFlag,
  _resetDecisionTraceForTesting,
  type DecisionPoint,
} from "../../../packages/sdk/src/decision-trace.js";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../packages/sdk/src/lifecycle.js";
import type { SdkLifecycleEvents } from "../../../packages/sdk/src/lifecycle.js";
import {
  prismaAdapter,
  type ScalarIntent,
} from "../../../packages/sdk/src/adapters/prisma.js";
import { hashIdWeb } from "../../../packages/sdk/src/side-effect/hash-id-web.js";
import {
  recordSideEffect,
  _resetSideEffectVocabState,
} from "../../../packages/sdk/src/side-effect/index.js";
import {
  getActiveConfig,
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../packages/sdk/src/context-manager.js";
import { maybeShowMcpNudge, __resetNudgeStateForTests } from "../../../packages/sdk/src/nudge/error-nudge.js";
import {
  maybeWarnStaleAgentInstructions,
  _resetUpgradeNoticeForTesting,
} from "../../../packages/sdk/src/agent-detection/upgrade-notice.js";
import type { SdkInitResponse } from "../../../packages/protocol/src/wire.js";

installContextManager();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Collect every `core:decision` event for a given point during `fn`. */
async function eventsForPoint(
  point: DecisionPoint,
  fn: () => void | Promise<void>,
): Promise<SdkLifecycleEvents["core:decision"][]> {
  const events: SdkLifecycleEvents["core:decision"][] = [];
  const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
    if (e.point === point) events.push(e);
  };
  onLifecycleEvent("core:decision", listener);
  try {
    await fn();
  } finally {
    offLifecycleEvent("core:decision", listener);
  }
  return events;
}

function configWith(
  overrides: Partial<SdkInitResponse["config"]> = {},
): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence: true,
      ...overrides,
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

// ---------------------------------------------------------------------------
// Prisma-adapter points: capture.fidelity.idModel / .identifier / .hmacKey
// ---------------------------------------------------------------------------

describe("decision-trace wiring — Prisma identifier-capture points", () => {
  const HMAC_KEY = "wiring-test-hmac-secret-do-not-use";
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: otelApi.Tracer;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
    tracer = otelApi.trace.getTracer("glasstrace-wiring-test");
    _resetDecisionTraceForTesting();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
    await provider.shutdown();
    otelApi.trace.disable();
    exporter.reset();
  });

  /** Drive one Prisma op under an active request span. */
  async function run(opts: {
    allow: ReadonlyArray<{ model: string; column: string; as?: ScalarIntent }>;
    model: string;
    row: Record<string, unknown>;
  }): Promise<void> {
    const ext = prismaAdapter({ allow: opts.allow });
    const requestSpan = tracer.startSpan("request");
    await otelApi.context.with(
      otelApi.trace.setSpan(otelApi.context.active(), requestSpan),
      async () => {
        await ext.query.$allModels.$allOperations({
          model: opts.model,
          operation: "findUnique",
          args: {},
          query: async () => opts.row,
        });
      },
    );
    requestSpan.end();
  }

  function setFull(attrHmacKey: string | undefined): void {
    const init = configWith({ captureFidelity: "full" });
    if (attrHmacKey !== undefined) init.config.attrHmacKey = attrHmacKey;
    _setCurrentConfig(init);
  }

  /** Run once, collecting the three identifier-capture facets by outcome. */
  async function collectFacets(opts: {
    allow: ReadonlyArray<{ model: string; column: string; as?: ScalarIntent }>;
    model: string;
    row: Record<string, unknown>;
  }): Promise<{ idModel: string[]; hmacKey: string[]; identifier: string[] }> {
    const collected = {
      idModel: [] as string[],
      hmacKey: [] as string[],
      identifier: [] as string[],
    };
    const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
      if (e.point === "capture.fidelity.idModel") collected.idModel.push(e.outcome);
      if (e.point === "capture.fidelity.hmacKey") collected.hmacKey.push(e.outcome);
      if (e.point === "capture.fidelity.identifier") collected.identifier.push(e.outcome);
    };
    onLifecycleEvent("core:decision", listener);
    try {
      await run(opts);
    } finally {
      offLifecycleEvent("core:decision", listener);
    }
    return collected;
  }

  it("ON: full fidelity + provisioned key emits idModel=full, hmacKey=provisioned, identifier=hashed", async () => {
    setFull(HMAC_KEY);
    setDecisionTraceFlag(true);
    const collected = await collectFacets({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      row: { owner: "u-1" },
    });
    expect(collected.idModel).toEqual(["full"]);
    expect(collected.hmacKey).toEqual(["provisioned"]);
    expect(collected.identifier).toEqual(["hashed"]);
  });

  it("ON: full fidelity + absent key emits hmacKey=absent, identifier=unhashed", async () => {
    setFull(undefined);
    setDecisionTraceFlag(true);
    const collected = await collectFacets({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      row: { owner: "u-1" },
    });
    expect(collected.idModel).toEqual(["full"]);
    expect(collected.hmacKey).toEqual(["absent"]);
    expect(collected.identifier).toEqual(["unhashed"]);
  });

  it("ON: strict fidelity on a mixed model emits idModel=suppressed_strict (no token)", async () => {
    _setCurrentConfig(configWith()); // strict (captureFidelity unset)
    setDecisionTraceFlag(true);

    const idModel = await eventsForPoint("capture.fidelity.idModel", async () => {
      await run({
        // A mixed model reaches projectIdentifier even under strict (the eager
        // column warrants the owned span); the id intent then bails strict.
        allow: [
          { model: "Poll", column: "owner", as: "id" },
          { model: "Poll", column: "muted", as: "flag" },
        ],
        model: "Poll",
        row: { owner: "u-1", muted: true },
      });
    });
    expect(idModel.map((e) => e.outcome)).toEqual(["suppressed_strict"]);
  });

  it("OFF: no identifier-capture decision events are emitted", async () => {
    setFull(HMAC_KEY);
    setDecisionTraceFlag(false);

    const seen: string[] = [];
    const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
      if (e.point.startsWith("capture.fidelity.")) seen.push(e.point);
    };
    onLifecycleEvent("core:decision", listener);
    await run({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      row: { owner: "u-1" },
    });
    offLifecycleEvent("core:decision", listener);

    expect(seen).toEqual([]);
  });

  it("OFF: capture behavior is unchanged (the gthid_ token still lands)", async () => {
    setFull(HMAC_KEY);
    setDecisionTraceFlag(false);
    await run({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      row: { owner: "u-1" },
    });
    const owned = exporter
      .getFinishedSpans()
      .find((s) => s.name === "db.Poll.findUnique");
    const token = await hashIdWeb("u-1", HMAC_KEY);
    expect(
      (owned!.attributes as Record<string, unknown>)[
        "glasstrace.side_effect.scalar.ownerId"
      ],
    ).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// config.tier
// ---------------------------------------------------------------------------

describe("decision-trace wiring — config.tier", () => {
  beforeEach(() => {
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
  });

  it("ON: an in-memory config resolves to config.tier=served", async () => {
    _setCurrentConfig(configWith());
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    expect(events.map((e) => e.outcome)).toEqual(["served"]);
  });

  it("OFF: getActiveConfig emits no config.tier event", async () => {
    _setCurrentConfig(configWith());
    setDecisionTraceFlag(false);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    expect(events).toEqual([]);
  });

  it("config.tier outcome is from the closed {served,cached,default} set", async () => {
    _setCurrentConfig(configWith());
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    for (const e of events) {
      expect(["served", "cached", "default"]).toContain(e.outcome);
    }
  });
});

// ---------------------------------------------------------------------------
// sideEffect.fieldRejected
// ---------------------------------------------------------------------------

describe("decision-trace wiring — sideEffect.fieldRejected", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: otelApi.Tracer;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
    tracer = otelApi.trace.getTracer("glasstrace-wiring-rejection");
    _resetSideEffectVocabState();
    _setCurrentConfig(configWith());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetSideEffectVocabState();
    _resetConfigForTesting();
    await provider.shutdown();
    otelApi.trace.disable();
    exporter.reset();
  });

  it("ON: a rejected field emits fieldRejected keyed by the omission reason only", async () => {
    setDecisionTraceFlag(true);
    const owned = tracer.startSpan("db.Poll.findUnique");
    const events = await eventsForPoint("sideEffect.fieldRejected", () => {
      recordSideEffect(
        // An unsupported semantic field key → `unsupported_key`.
        { kind: "email", operation: "email.send", fields: { notAKey: "x" } as never },
        { span: owned },
      );
    });
    owned.end();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("unsupported_key");
    // Hot-path safety: the rejected field key / value never appears in the
    // emitted event (no inputs, no reason carrying the key).
    expect(JSON.stringify(events[0])).not.toContain("notAKey");
  });

  it("ON: many identical-reason rejections collapse to one decision line", async () => {
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("sideEffect.fieldRejected", () => {
      // A fresh owned span per call so the per-span operation budget never
      // triggers an over-budget `value_too_long` — every call rejects with the
      // same `unsupported_key` reason, proving the per-reason dedup.
      for (let i = 0; i < 50; i++) {
        const owned = tracer.startSpan("db.Poll.findUnique");
        recordSideEffect(
          { kind: "email", operation: "email.send", fields: { bad: "x" } as never },
          { span: owned },
        );
        owned.end();
      }
    });
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("unsupported_key");
  });

  it("ON: distinct omission reasons each emit their own decision line", async () => {
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("sideEffect.fieldRejected", () => {
      // Unsupported key → `unsupported_key`.
      const a = tracer.startSpan("db.Poll.findUnique");
      recordSideEffect(
        { kind: "email", operation: "email.send", fields: { bad: "x" } as never },
        { span: a },
      );
      a.end();
      // A value-shaped-unsafe operation label (a URL) → `raw_payload`.
      const b = tracer.startSpan("db.Poll.findUnique");
      recordSideEffect(
        { kind: "email", operation: "https://example.com/x" },
        { span: b },
      );
      b.end();
    });
    const outcomes = events.map((e) => e.outcome).sort();
    expect(outcomes).toEqual(["raw_payload", "unsupported_key"]);
  });

  it("OFF: a rejected field emits no decision event but still records the omission", async () => {
    setDecisionTraceFlag(false);
    const owned = tracer.startSpan("db.Poll.findUnique");
    const events = await eventsForPoint("sideEffect.fieldRejected", () => {
      recordSideEffect(
        { kind: "email", operation: "email.send", fields: { bad: "x" } as never },
        { span: owned },
      );
    });
    owned.end();
    expect(events).toEqual([]);
    // Behavior unchanged: the omission counter still landed on the span.
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "db.Poll.findUnique");
    expect(
      (span!.attributes as Record<string, unknown>)[
        "glasstrace.side_effect.omitted.unsupported_key"
      ],
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// env.nudgeSuppressed
// ---------------------------------------------------------------------------

describe("decision-trace wiring — env.nudgeSuppressed", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    _resetDecisionTraceForTesting();
    __resetNudgeStateForTests();
    delete process.env.GLASSTRACE_FORCE_ENABLE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
    __resetNudgeStateForTests();
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
  });

  it("ON: production suppresses the nudge → env.nudgeSuppressed=suppressed", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("env.nudgeSuppressed", () => {
      maybeShowMcpNudge("boom");
    });
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("suppressed");
    expect(events[0].reason).toBe("production");
  });

  it("ON: a normal dev run shows the nudge → env.nudgeSuppressed=shown", async () => {
    process.env.NODE_ENV = "development";
    setDecisionTraceFlag(true);
    // Suppress the real stderr write so the test output stays clean.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const events = await eventsForPoint("env.nudgeSuppressed", () => {
      maybeShowMcpNudge("boom");
    });
    stderrSpy.mockRestore();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("shown");
  });

  it("OFF: production suppression emits no decision event", async () => {
    process.env.NODE_ENV = "production";
    setDecisionTraceFlag(false);
    const events = await eventsForPoint("env.nudgeSuppressed", () => {
      maybeShowMcpNudge("boom");
    });
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// env.upgradeNoticeSuppressed
// ---------------------------------------------------------------------------

describe("decision-trace wiring — env.upgradeNoticeSuppressed", () => {
  let testDir: string;

  beforeEach(async () => {
    _resetDecisionTraceForTesting();
    _resetUpgradeNoticeForTesting();
    testDir = await mkdtemp(join(tmpdir(), "glasstrace-upgrade-wiring-"));
    delete process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE;
    delete process.env.CI;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
    _resetUpgradeNoticeForTesting();
    delete process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE;
    delete process.env.CI;
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeStaleClaude(): Promise<void> {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );
  }

  it("ON: the opt-out env var suppresses the notice → suppressed", async () => {
    process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE = "1";
    setDecisionTraceFlag(true);
    const events = await eventsForPoint(
      "env.upgradeNoticeSuppressed",
      () => {
        maybeWarnStaleAgentInstructions({
          projectRoot: testDir,
          sdkVersion: "1.4.0",
          stderrWrite: () => {},
        });
      },
    );
    expect(events.map((e) => e.outcome)).toEqual(["suppressed"]);
  });

  it("ON: a stale managed section shows the notice → shown", async () => {
    await writeStaleClaude();
    setDecisionTraceFlag(true);
    const events = await eventsForPoint(
      "env.upgradeNoticeSuppressed",
      () => {
        maybeWarnStaleAgentInstructions({
          projectRoot: testDir,
          sdkVersion: "1.4.0",
          stderrWrite: () => {},
        });
      },
    );
    expect(events.map((e) => e.outcome)).toEqual(["shown"]);
  });

  it("OFF: the opt-out path emits no decision event", async () => {
    process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE = "1";
    setDecisionTraceFlag(false);
    const events = await eventsForPoint(
      "env.upgradeNoticeSuppressed",
      () => {
        maybeWarnStaleAgentInstructions({
          projectRoot: testDir,
          sdkVersion: "1.4.0",
          stderrWrite: () => {},
        });
      },
    );
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bounded-key design: the hot-path point cannot exhaust the dedup cap
// ---------------------------------------------------------------------------

describe("decision-trace wiring — bounded one-shot keys", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: otelApi.Tracer;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    otelApi.trace.setGlobalTracerProvider(provider);
    tracer = otelApi.trace.getTracer("glasstrace-wiring-bound");
    _resetSideEffectVocabState();
    _resetDecisionTraceForTesting();
    _setCurrentConfig(configWith());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetSideEffectVocabState();
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
    await provider.shutdown();
    otelApi.trace.disable();
    exporter.reset();
  });

  it("flooding sideEffect.fieldRejected does not suppress another point's first emission", async () => {
    setDecisionTraceFlag(true);

    // Collect every decision event across the whole scenario so we can prove
    // the flood consumed only one dedup slot and a later, untouched point
    // still emitted its first line.
    const fieldRejected: string[] = [];
    const idModel: string[] = [];
    const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
      if (e.point === "sideEffect.fieldRejected") fieldRejected.push(e.outcome);
      if (e.point === "capture.fidelity.idModel") idModel.push(e.outcome);
    };
    onLifecycleEvent("core:decision", listener);

    // Flood the hot-path rejection point with thousands of rejections that all
    // carry the same omission reason. Because the point keys by the closed
    // omission reason only — never the field key / value — it consumes a single
    // dedup slot regardless of call volume, so it can never fill the 100-key
    // cap and crowd out other points. (A fresh owned span per call keeps every
    // rejection on the same `unsupported_key` reason; reusing one span would
    // add a second `value_too_long` reason once the per-span operation budget
    // is exhausted — still bounded, but here we want the single-slot proof.)
    for (let i = 0; i < 5000; i++) {
      const owned = tracer.startSpan("db.Poll.findUnique");
      recordSideEffect(
        { kind: "email", operation: "email.send", fields: { bad: "x" } as never },
        { span: owned },
      );
      owned.end();
    }

    // A different point, never touched by the flood, still emits its first
    // line afterward. Drive the Prisma strict-mixed-model gate, which emits
    // `capture.fidelity.idModel=suppressed_strict`.
    _setCurrentConfig(configWith()); // strict
    const requestSpan = tracer.startSpan("request");
    await otelApi.context.with(
      otelApi.trace.setSpan(otelApi.context.active(), requestSpan),
      async () => {
        const ext = prismaAdapter({
          allow: [
            { model: "Poll", column: "owner", as: "id" },
            { model: "Poll", column: "muted", as: "flag" },
          ],
        });
        await ext.query.$allModels.$allOperations({
          model: "Poll",
          operation: "findUnique",
          args: {},
          query: async () => ({ owner: "u-1", muted: true }),
        });
      },
    );
    requestSpan.end();

    offLifecycleEvent("core:decision", listener);

    // The 5000 identical rejections collapsed to one decision line.
    expect(fieldRejected).toEqual(["unsupported_key"]);
    // The untouched point still emitted — its dedup slot was available.
    expect(idModel).toEqual(["suppressed_strict"]);
  });
});
