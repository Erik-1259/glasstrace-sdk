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
  decisionTrace,
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

  it("ON: non-full fidelity on a mixed model emits idModel=suppressed (no token)", async () => {
    _setCurrentConfig(configWith()); // captureFidelity unset (non-full)
    setDecisionTraceFlag(true);

    const idModel = await eventsForPoint("capture.fidelity.idModel", async () => {
      await run({
        // A mixed model reaches projectIdentifier even under non-full fidelity
        // (the eager column warrants the owned span); the id intent then bails.
        allow: [
          { model: "Poll", column: "owner", as: "id" },
          { model: "Poll", column: "muted", as: "flag" },
        ],
        model: "Poll",
        row: { owner: "u-1", muted: true },
      });
    });
    expect(idModel.map((e) => e.outcome)).toEqual(["suppressed"]);
  });

  it("ON: full fidelity + provisioned key + non-hashable id emits hmacKey=provisioned, identifier=unhashed", async () => {
    // The key IS provisioned, but the id value is non-hashable (an object), so
    // the hmacKey facet reports the key state alone (`provisioned`) and the
    // value facet carries the non-hashable case (`unhashed`).
    setFull(HMAC_KEY);
    setDecisionTraceFlag(true);
    const collected = await collectFacets({
      allow: [{ model: "Poll", column: "owner", as: "id" }],
      model: "Poll",
      row: { owner: { nested: "not-a-scalar" } },
    });
    expect(collected.idModel).toEqual(["full"]);
    expect(collected.hmacKey).toEqual(["provisioned"]);
    expect(collected.identifier).toEqual(["unhashed"]);
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
  // A fresh temp cwd per test so the on-disk `.glasstrace/config` cache is
  // controlled: present for the `cached` case, absent for `served`/`default`.
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-config-tier-"));
    process.chdir(tempDir);
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetDecisionTraceForTesting();
    _resetConfigForTesting();
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ON: an in-memory config resolves to config.tier=served", async () => {
    _setCurrentConfig(configWith());
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    expect(events.map((e) => e.outcome)).toEqual(["served"]);
  });

  it("ON: a disk-cached config (no in-memory) resolves to config.tier=cached", async () => {
    // Write a valid cache file in the temp cwd; with no in-memory config the
    // resolver falls through tier 1 to tier 2 (the file cache).
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    await writeFile(
      join(tempDir, ".glasstrace", "config"),
      JSON.stringify({ response: configWith(), cachedAt: Date.now() }),
    );
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    expect(events.map((e) => e.outcome)).toEqual(["cached"]);
  });

  it("ON: no in-memory and no cache file resolves to config.tier=default", async () => {
    // Fresh temp cwd with no `.glasstrace/config` and no in-memory config →
    // tier 3 defaults.
    setDecisionTraceFlag(true);
    const events = await eventsForPoint("config.tier", () => {
      getActiveConfig();
    });
    expect(events.map((e) => e.outcome)).toEqual(["default"]);
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

  it("ON: reusing one span past its operation budget emits both the field reason and value_too_long", async () => {
    setDecisionTraceFlag(true);
    // Reuse a single owned span. The first 5 calls each reach the fields loop
    // and reject the unsupported key (`unsupported_key`); from the 6th call on,
    // the per-span operation budget is exhausted, so `attachOperation` returns
    // over_budget and the call rejects with `value_too_long`. Both distinct
    // reason-keys must emit (one line each).
    const owned = tracer.startSpan("db.Poll.findUnique");
    const events = await eventsForPoint("sideEffect.fieldRejected", () => {
      for (let i = 0; i < 8; i++) {
        recordSideEffect(
          { kind: "email", operation: "email.send", fields: { bad: "x" } as never },
          { span: owned },
        );
      }
    });
    owned.end();
    const outcomes = events.map((e) => e.outcome).sort();
    expect(outcomes).toEqual(["unsupported_key", "value_too_long"]);
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

  it("ON: the opt-out env var suppresses the notice → suppressed (reason opted_out)", async () => {
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
    expect(events.map((e) => e.reason)).toEqual(["opted_out"]);
  });

  it("ON: a quiet CI context suppresses the notice → suppressed (reason quiet_ci)", async () => {
    // The vitest worker runs with a non-TTY stderr, so CI=true is sufficient to
    // make isQuietCiContext() resolve true. Skip if the runner attaches a TTY
    // (the heuristic intentionally does not suppress for an interactive run).
    if (process.stderr.isTTY === true) return;
    process.env.CI = "true";
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
    expect(events.map((e) => e.reason)).toEqual(["quiet_ci"]);
  });

  it("ON: an unparseable running version suppresses the notice → suppressed (reason unparseable_version)", async () => {
    setDecisionTraceFlag(true);
    const events = await eventsForPoint(
      "env.upgradeNoticeSuppressed",
      () => {
        maybeWarnStaleAgentInstructions({
          projectRoot: testDir,
          sdkVersion: "not-a-semver",
          stderrWrite: () => {},
        });
      },
    );
    expect(events.map((e) => e.outcome)).toEqual(["suppressed"]);
    expect(events.map((e) => e.reason)).toEqual(["unparseable_version"]);
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
    // line afterward. Drive the Prisma non-full mixed-model gate, which emits
    // `capture.fidelity.idModel=suppressed`.
    _setCurrentConfig(configWith()); // captureFidelity unset (non-full)
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
    expect(idModel).toEqual(["suppressed"]);
  });

  it("emits one first line for every instrumented point — all fit well under the 100-key cap", async () => {
    setDecisionTraceFlag(true);
    // The full instrumented-point inventory. One representative first emission
    // per point (each with a distinct one-shot key) must land — 13 points is
    // far below the 100-key dedup cap, so no point crowds out another.
    const ALL_POINTS: DecisionPoint[] = [
      "capture.sideEffectEvidence",
      "capture.fidelity.identifier",
      "capture.fidelity.idModel",
      "capture.fidelity.hmacKey",
      "config.tier",
      "sideEffect.fieldRejected",
      "feature.consoleErrors",
      "feature.errorResponseBodies",
      "feature.discovery",
      "otel.path",
      "env.forceEnable",
      "env.nudgeSuppressed",
      "env.upgradeNoticeSuppressed",
    ];

    const seenPoints: string[] = [];
    const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
      seenPoints.push(e.point);
    };
    onLifecycleEvent("core:decision", listener);
    for (const point of ALL_POINTS) {
      decisionTrace(point, "probe", { oneShotKey: `${point}:probe` });
    }
    offLifecycleEvent("core:decision", listener);

    // Every point's first line landed exactly once — none was suppressed by the
    // bounded cap.
    expect(seenPoints).toEqual(ALL_POINTS);
    expect(new Set(seenPoints).size).toBe(ALL_POINTS.length);
    expect(seenPoints.length).toBeLessThan(100);
  });
});
