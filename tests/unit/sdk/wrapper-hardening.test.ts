/**
 * Unit tests for the internal wrapper-hardening helpers
 * (`packages/sdk/src/wrapper-hardening.ts`): the span-leak guard and
 * the control-character attribute strip. Wrapper-level integration
 * (never-settling thenables/promises ending their spans) is covered in
 * the middleware and async-context suites.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Span } from "@opentelemetry/api";
import {
  SPAN_WATCHDOG_INTERVAL_MS,
  sanitizeAttributeValue,
  sanitizeAttributes,
  startSpanLeakGuard,
  stripControlChars,
} from "../../../packages/sdk/src/wrapper-hardening.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const fakeSpan = {} as Span;

describe("stripControlChars", () => {
  it("returns the SAME string reference when nothing needs stripping", () => {
    const clean = "orders /api v1 — ünïcode 🙂";
    expect(stripControlChars(clean)).toBe(clean);
  });

  it.each([
    ["tab", "a\tb", "ab"],
    ["newline", "a\nb", "ab"],
    ["carriage return", "a\rb", "ab"],
    ["CRLF pair", "a\r\nb", "ab"],
    ["NUL", "a\u0000b", "ab"],
    ["escape", "a\u001bb", "ab"],
    ["unit separator (0x1f)", "a\u001fb", "ab"],
  ])("strips %s", (_label, input, expected) => {
    expect(stripControlChars(input)).toBe(expected);
  });

  it("strips every code point below 0x20 and keeps space (0x20) and above", () => {
    let all = "";
    for (let c = 0; c < 0x20; c++) all += String.fromCharCode(c);
    expect(stripControlChars(`x${all} y`)).toBe("x y");
  });

  it("preserves surrogate pairs while stripping neighbors", () => {
    expect(stripControlChars("\n🙂\t𝒳\r")).toBe("🙂𝒳");
  });

  it("handles the empty string", () => {
    expect(stripControlChars("")).toBe("");
  });
});

describe("sanitizeAttributeValue", () => {
  it("strips strings and passes non-strings through unchanged", () => {
    expect(sanitizeAttributeValue("a\nb")).toBe("ab");
    expect(sanitizeAttributeValue(7)).toBe(7);
    expect(sanitizeAttributeValue(false)).toBe(false);
  });

  it("strips string elements of array values, leaving other elements", () => {
    expect(sanitizeAttributeValue(["a\tb", "clean"])).toEqual(["ab", "clean"]);
    expect(sanitizeAttributeValue([1, 2])).toEqual([1, 2]);
  });

  it("returns the SAME array reference when no element needs stripping", () => {
    const clean = ["x", "y"];
    expect(sanitizeAttributeValue(clean)).toBe(clean);
  });
});

describe("sanitizeAttributes", () => {
  it("maps every value and returns a fresh record", () => {
    const input = { note: "a\r\nb", count: 3, tags: ["p\tq", "r"] };
    const out = sanitizeAttributes(input);
    expect(out).toEqual({ note: "ab", count: 3, tags: ["pq", "r"] });
    expect(out).not.toBe(input);
    expect(input.note).toBe("a\r\nb");
  });
});

describe("startSpanLeakGuard", () => {
  it("fires endSpan exactly at the default interval, not before", () => {
    vi.useFakeTimers();
    const endSpan = vi.fn();
    startSpanLeakGuard(fakeSpan, endSpan);
    vi.advanceTimersByTime(SPAN_WATCHDOG_INTERVAL_MS - 1);
    expect(endSpan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(endSpan).toHaveBeenCalledTimes(1);
    expect(endSpan).toHaveBeenCalledWith(fakeSpan);
  });

  it("does not fire again after the boundary", () => {
    vi.useFakeTimers();
    const endSpan = vi.fn();
    startSpanLeakGuard(fakeSpan, endSpan);
    vi.advanceTimersByTime(SPAN_WATCHDOG_INTERVAL_MS * 3);
    expect(endSpan).toHaveBeenCalledTimes(1);
  });

  it("settle() ends once, cancels the timer, and later firing is impossible", () => {
    vi.useFakeTimers();
    const endSpan = vi.fn();
    const guard = startSpanLeakGuard(fakeSpan, endSpan);
    guard.settle();
    expect(endSpan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SPAN_WATCHDOG_INTERVAL_MS * 2);
    expect(endSpan).toHaveBeenCalledTimes(1);
    guard.settle();
    expect(endSpan).toHaveBeenCalledTimes(1);
  });

  it("settle() after the watchdog fired is a safe no-op", () => {
    vi.useFakeTimers();
    const endSpan = vi.fn();
    const guard = startSpanLeakGuard(fakeSpan, endSpan);
    vi.advanceTimersByTime(SPAN_WATCHDOG_INTERVAL_MS);
    expect(endSpan).toHaveBeenCalledTimes(1);
    guard.settle();
    expect(endSpan).toHaveBeenCalledTimes(1);
  });

  it("honors a custom interval", () => {
    vi.useFakeTimers();
    const endSpan = vi.fn();
    startSpanLeakGuard(fakeSpan, endSpan, 1_000);
    vi.advanceTimersByTime(999);
    expect(endSpan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(endSpan).toHaveBeenCalledTimes(1);
  });

  it("calls unref when the timer handle provides it", () => {
    const unref = vi.fn();
    const timerHandle = { unref } as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(timerHandle);
    startSpanLeakGuard(fakeSpan, vi.fn());
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("tolerates a timer handle without unref (edge-runtime shape) and settle still clears it", () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(42 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    let guard!: ReturnType<typeof startSpanLeakGuard>;
    expect(() => {
      guard = startSpanLeakGuard(fakeSpan, vi.fn());
    }).not.toThrow();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    guard.settle();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(
      42 as unknown as ReturnType<typeof setTimeout>,
    );
  });

  it("keeps the timer clearable when unref itself throws", () => {
    const unrefThrows = {
      get unref(): () => void {
        throw new Error("hostile unref accessor");
      },
    } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, "setTimeout").mockReturnValue(unrefThrows);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => undefined);
    const endSpan = vi.fn();
    let guard!: ReturnType<typeof startSpanLeakGuard>;
    expect(() => {
      guard = startSpanLeakGuard(fakeSpan, endSpan);
    }).not.toThrow();
    guard.settle();
    expect(endSpan).toHaveBeenCalledTimes(1);
    // Reference assertion — a deep-equality matcher would traverse the
    // hostile getter and throw inside the expectation itself.
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy.mock.calls[0]![0]).toBe(unrefThrows);
  });

  it("reports ended() correctly across settle and watchdog fire", () => {
    vi.useFakeTimers();
    const guardA = startSpanLeakGuard(fakeSpan, vi.fn());
    expect(guardA.ended()).toBe(false);
    guardA.settle();
    expect(guardA.ended()).toBe(true);

    const guardB = startSpanLeakGuard(fakeSpan, vi.fn());
    vi.advanceTimersByTime(SPAN_WATCHDOG_INTERVAL_MS);
    expect(guardB.ended()).toBe(true);
  });

  it("degrades to settle-only when setTimeout throws", () => {
    vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
      throw new Error("no timers here");
    });
    const endSpan = vi.fn();
    let guard!: ReturnType<typeof startSpanLeakGuard>;
    expect(() => {
      guard = startSpanLeakGuard(fakeSpan, endSpan);
    }).not.toThrow();
    guard.settle();
    expect(endSpan).toHaveBeenCalledTimes(1);
  });
});
