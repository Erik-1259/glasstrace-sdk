/**
 * Decision-trace emitter unit tests.
 *
 * Covers the emitter module in isolation:
 *  - OFF (default, env unset, flag false) is silent on both channels.
 *  - The env-only early-bootstrap gate (no threaded flag yet) governs.
 *  - The threaded flag, once set, overrides the env var.
 *  - ON emits exactly one `[glasstrace] decision:` line and one
 *    `core:decision` event per call, in the documented format.
 *  - One-shot dedup by `oneShotKey`; the dedup Set is bounded.
 *  - `inputs` bounds: key cap, UTF-8 value truncation, null/undefined drop,
 *    insertion-order rendering.
 *  - A throwing host `console` never propagates.
 *  - The line always carries the literal `[glasstrace]` prefix so it routes
 *    past console-capture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  decisionTrace,
  decisionTraceEnabled,
  setDecisionTraceFlag,
  _resetDecisionTraceForTesting,
} from "../../../packages/sdk/src/decision-trace.js";
import {
  onLifecycleEvent,
  offLifecycleEvent,
} from "../../../packages/sdk/src/lifecycle.js";
import type { SdkLifecycleEvents } from "../../../packages/sdk/src/lifecycle.js";

/** Capture every `[glasstrace] decision:` line written via console.info. */
function spyDecisionLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[glasstrace] decision:")) {
      lines.push(args[0]);
    }
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Collect every `core:decision` event emitted during `fn`. */
function collectEvents(
  fn: () => void,
): SdkLifecycleEvents["core:decision"][] {
  const events: SdkLifecycleEvents["core:decision"][] = [];
  const listener = (e: SdkLifecycleEvents["core:decision"]): void => {
    events.push(e);
  };
  onLifecycleEvent("core:decision", listener);
  try {
    fn();
  } finally {
    offLifecycleEvent("core:decision", listener);
  }
  return events;
}

beforeEach(() => {
  _resetDecisionTraceForTesting();
  delete process.env.GLASSTRACE_DECISION_TRACE;
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetDecisionTraceForTesting();
  delete process.env.GLASSTRACE_DECISION_TRACE;
});

describe("decisionTraceEnabled — toggle resolution", () => {
  it("is OFF by default (no flag, no env)", () => {
    expect(decisionTraceEnabled()).toBe(false);
  });

  it("falls back to the raw env var before the flag is set", () => {
    process.env.GLASSTRACE_DECISION_TRACE = "true";
    expect(decisionTraceEnabled()).toBe(true);
  });

  it("treats any non-'true' env value as OFF", () => {
    process.env.GLASSTRACE_DECISION_TRACE = "1";
    expect(decisionTraceEnabled()).toBe(false);
    process.env.GLASSTRACE_DECISION_TRACE = "TRUE";
    expect(decisionTraceEnabled()).toBe(false);
  });

  it("the threaded flag, once set, overrides the env var", () => {
    process.env.GLASSTRACE_DECISION_TRACE = "true";
    setDecisionTraceFlag(false);
    expect(decisionTraceEnabled()).toBe(false);
    setDecisionTraceFlag(true);
    expect(decisionTraceEnabled()).toBe(true);
  });
});

describe("decisionTrace — OFF is silent", () => {
  it("emits nothing on either channel when OFF", () => {
    const { lines, restore } = spyDecisionLines();
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", { reason: "init_not_landed" });
    });
    restore();
    expect(lines).toEqual([]);
    expect(events).toEqual([]);
  });

  it("emits nothing when the flag is explicitly false even with a subscriber", () => {
    setDecisionTraceFlag(false);
    const { lines, restore } = spyDecisionLines();
    const events = collectEvents(() => {
      decisionTrace("capture.sideEffectEvidence", "disabled");
    });
    restore();
    expect(lines).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("decisionTrace — ON emits both channels", () => {
  beforeEach(() => {
    setDecisionTraceFlag(true);
  });

  it("emits one line and one event in the documented format", () => {
    const { lines, restore } = spyDecisionLines();
    const events = collectEvents(() => {
      decisionTrace("capture.sideEffectEvidence", "disabled", {
        reason: "config tier=defaults",
        inputs: { surface: "recordSideEffect" },
      });
    });
    restore();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "[glasstrace] decision: capture.sideEffectEvidence=disabled " +
        "(config tier=defaults; surface=recordSideEffect)",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      point: "capture.sideEffectEvidence",
      outcome: "disabled",
      reason: "config tier=defaults",
      inputs: { surface: "recordSideEffect" },
    });
  });

  it("omits the (reason; inputs) group when both are absent", () => {
    const { lines, restore } = spyDecisionLines();
    decisionTrace("feature.discovery", "enabled");
    restore();
    expect(lines).toEqual(["[glasstrace] decision: feature.discovery=enabled"]);
  });

  it("renders inputs only when no reason is given", () => {
    const { lines, restore } = spyDecisionLines();
    decisionTrace("capture.fidelity.idModel", "skipped", {
      inputs: { model: "User" },
    });
    restore();
    expect(lines).toEqual([
      "[glasstrace] decision: capture.fidelity.idModel=skipped (model=User)",
    ]);
  });

  it("omits reason/inputs from the event payload when absent", () => {
    const events = collectEvents(() => {
      decisionTrace("otel.path", "coexistence");
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ point: "otel.path", outcome: "coexistence" });
    expect(events[0]).not.toHaveProperty("reason");
    expect(events[0]).not.toHaveProperty("inputs");
  });

  it("every emitted line carries the [glasstrace] prefix (routes past console-capture)", () => {
    const { lines, restore } = spyDecisionLines();
    decisionTrace("config.tier", "in_memory");
    restore();
    expect(lines[0].startsWith("[glasstrace]")).toBe(true);
  });
});

describe("decisionTrace — one-shot dedup", () => {
  beforeEach(() => {
    setDecisionTraceFlag(true);
  });

  it("emits at most once per oneShotKey", () => {
    const { lines, restore } = spyDecisionLines();
    const events = collectEvents(() => {
      for (let i = 0; i < 1000; i++) {
        decisionTrace("capture.sideEffectEvidence", "disabled", {
          inputs: { surface: "recordSideEffect" },
          oneShotKey: "capture.sideEffectEvidence:recordSideEffect:disabled",
        });
      }
    });
    restore();
    expect(lines).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("distinct keys each emit once", () => {
    const { lines, restore } = spyDecisionLines();
    decisionTrace("capture.sideEffectEvidence", "enabled", {
      oneShotKey: "capture.sideEffectEvidence:capture:enabled",
    });
    decisionTrace("capture.sideEffectEvidence", "enabled", {
      oneShotKey: "capture.sideEffectEvidence:prismaAdapter:enabled",
    });
    restore();
    expect(lines).toHaveLength(2);
  });

  it("re-emits a key after a reset", () => {
    const first = spyDecisionLines();
    decisionTrace("config.tier", "defaults", { oneShotKey: "config.tier:defaults" });
    first.restore();
    expect(first.lines).toHaveLength(1);

    _resetDecisionTraceForTesting();
    setDecisionTraceFlag(true);

    const second = spyDecisionLines();
    decisionTrace("config.tier", "defaults", { oneShotKey: "config.tier:defaults" });
    second.restore();
    expect(second.lines).toHaveLength(1);
  });

  it("bounds the dedup Set at 100 distinct keys", () => {
    const { lines, restore } = spyDecisionLines();
    // 150 distinct keys: only the first 100 may emit; the rest are skipped.
    for (let i = 0; i < 150; i++) {
      decisionTrace("config.tier", "defaults", { oneShotKey: `k${String(i)}` });
    }
    restore();
    expect(lines).toHaveLength(100);
  });
});

describe("decisionTrace — inputs bounds", () => {
  beforeEach(() => {
    setDecisionTraceFlag(true);
  });

  it("drops keys beyond the 8-key cap in insertion order", () => {
    const inputs: Record<string, string | number | boolean> = {};
    for (let i = 0; i < 12; i++) inputs[`k${String(i)}`] = i;
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", { inputs });
    });
    expect(events).toHaveLength(1);
    const kept = events[0].inputs as Record<string, unknown>;
    expect(Object.keys(kept)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
  });

  it("omits null and undefined values", () => {
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", {
        inputs: {
          a: "x",
          b: undefined as unknown as string,
          c: null as unknown as string,
          d: 1,
        },
      });
    });
    expect(events[0].inputs).toEqual({ a: "x", d: 1 });
  });

  it("truncates a string value over 100 UTF-8 bytes with a trailing ellipsis", () => {
    const long = "a".repeat(250);
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", { inputs: { v: long } });
    });
    const v = (events[0].inputs as Record<string, string>).v;
    expect(v.endsWith("…")).toBe(true);
    // 100 ASCII bytes + the ellipsis character.
    expect(v).toBe("a".repeat(100) + "…");
  });

  it("does not split a multi-byte code point at the truncation boundary", () => {
    // Each emoji is 4 UTF-8 bytes; 30 of them = 120 bytes, over the cap.
    const emoji = "😀".repeat(30);
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", { inputs: { v: emoji } });
    });
    const v = (events[0].inputs as Record<string, string>).v;
    // 100 bytes / 4 bytes-per-emoji = 25 whole emoji, then the ellipsis.
    expect(v).toBe("😀".repeat(25) + "…");
  });

  it("preserves number and boolean values without coercion in the event", () => {
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", { inputs: { n: 42, b: true } });
    });
    expect(events[0].inputs).toEqual({ n: 42, b: true });
  });

  it("omits the inputs field entirely when nothing survives bounding", () => {
    const events = collectEvents(() => {
      decisionTrace("config.tier", "defaults", {
        inputs: { only: undefined as unknown as string },
      });
    });
    expect(events[0]).not.toHaveProperty("inputs");
  });
});

describe("decisionTrace — correlation stamp", () => {
  const ORIGINAL_BUILD_HASH = process.env.GLASSTRACE_BUILD_HASH;

  afterEach(() => {
    vi.resetModules();
    if (ORIGINAL_BUILD_HASH === undefined) {
      delete process.env.GLASSTRACE_BUILD_HASH;
    } else {
      process.env.GLASSTRACE_BUILD_HASH = ORIGINAL_BUILD_HASH;
    }
  });

  it("appends a [build=…] suffix (short prefix) when GLASSTRACE_BUILD_HASH is set", async () => {
    vi.resetModules();
    process.env.GLASSTRACE_BUILD_HASH = "abcdef0123456789deadbeef";
    const mod = await import("../../../packages/sdk/src/decision-trace.js");
    mod.setDecisionTraceFlag(true);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("[glasstrace] decision:")) {
        lines.push(args[0]);
      }
    });
    mod.decisionTrace("config.tier", "in_memory");
    spy.mockRestore();

    expect(lines).toEqual([
      "[glasstrace] decision: config.tier=in_memory [build=abcdef012345]",
    ]);
    mod._resetDecisionTraceForTesting();
  });

  it("omits the bracket group entirely when no build hash is present", async () => {
    vi.resetModules();
    delete process.env.GLASSTRACE_BUILD_HASH;
    const mod = await import("../../../packages/sdk/src/decision-trace.js");
    mod.setDecisionTraceFlag(true);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("[glasstrace] decision:")) {
        lines.push(args[0]);
      }
    });
    mod.decisionTrace("config.tier", "in_memory");
    spy.mockRestore();

    expect(lines).toEqual(["[glasstrace] decision: config.tier=in_memory"]);
    mod._resetDecisionTraceForTesting();
  });

  it("omits the bracket group when GLASSTRACE_BUILD_HASH is not SHA-shaped (never echoes a misconfigured secret)", async () => {
    vi.resetModules();
    // A non-hex value the user may have accidentally set to a secret. It
    // must never be echoed — not even a truncated prefix — into the line.
    const secretLike = "super-secret-token-value-not-a-sha";
    process.env.GLASSTRACE_BUILD_HASH = secretLike;
    const mod = await import("../../../packages/sdk/src/decision-trace.js");
    mod.setDecisionTraceFlag(true);

    const lines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("[glasstrace] decision:")) {
        lines.push(args[0]);
      }
    });
    mod.decisionTrace("config.tier", "in_memory");
    spy.mockRestore();

    expect(lines).toEqual(["[glasstrace] decision: config.tier=in_memory"]);
    expect(lines[0]).not.toContain("build=");
    expect(lines[0]).not.toContain(secretLike.slice(0, 12));
    mod._resetDecisionTraceForTesting();
  });
});

describe("decisionTrace — failure safety", () => {
  it("swallows a throwing host console.info and never propagates", () => {
    setDecisionTraceFlag(true);
    const spy = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("host console exploded");
    });
    expect(() => {
      decisionTrace("config.tier", "defaults");
    }).not.toThrow();
    spy.mockRestore();
  });

  it("swallows a throwing lifecycle subscriber and still writes the log line", () => {
    setDecisionTraceFlag(true);
    const listener = (): void => {
      throw new Error("subscriber exploded");
    };
    onLifecycleEvent("core:decision", listener);
    const { lines, restore } = spyDecisionLines();
    expect(() => {
      decisionTrace("config.tier", "defaults");
    }).not.toThrow();
    restore();
    offLifecycleEvent("core:decision", listener);
    expect(lines).toHaveLength(1);
  });
});
