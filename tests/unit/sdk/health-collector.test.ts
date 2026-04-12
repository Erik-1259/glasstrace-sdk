import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSpansExported,
  recordSpansDropped,
  recordInitFailure,
  recordConfigSync,
  collectHealthReport,
  acknowledgeHealthReport,
  _resetHealthForTesting,
} from "../../../packages/sdk/src/health-collector.js";

describe("health-collector", () => {
  beforeEach(() => {
    _resetHealthForTesting();
  });

  describe("collectHealthReport", () => {
    it("returns zeros on initial collect", () => {
      const report = collectHealthReport("1.0.0");
      expect(report).toEqual({
        tracesExportedSinceLastInit: 0,
        tracesDropped: 0,
        initFailures: 0,
        configAge: 0,
        sdkVersion: "1.0.0",
      });
    });

    it("passes sdkVersion through to the report", () => {
      const report = collectHealthReport("0.9.0");
      expect(report?.sdkVersion).toBe("0.9.0");
    });

    it("does not reset counters — collectHealthReport is a snapshot", () => {
      recordSpansExported(10);
      recordSpansDropped(3);
      recordInitFailure();

      const first = collectHealthReport("1.0.0");
      expect(first?.tracesExportedSinceLastInit).toBe(10);
      expect(first?.tracesDropped).toBe(3);
      expect(first?.initFailures).toBe(1);

      // Second collect returns the same values (no reset)
      const second = collectHealthReport("1.0.0");
      expect(second?.tracesExportedSinceLastInit).toBe(10);
      expect(second?.tracesDropped).toBe(3);
      expect(second?.initFailures).toBe(1);
    });

    it("preserves lastConfigSyncAt across collects", () => {
      const syncTime = Date.now() - 5000;
      recordConfigSync(syncTime);

      const first = collectHealthReport("1.0.0");
      expect(first?.configAge).toBeGreaterThanOrEqual(4900);
      expect(first?.configAge).toBeLessThan(6000);

      // Second collect should have a larger configAge (time keeps advancing)
      const second = collectHealthReport("1.0.0");
      expect(second?.configAge).toBeGreaterThanOrEqual(first!.configAge);
    });

    it("returns configAge as a rounded integer", () => {
      recordConfigSync(Date.now() - 1);
      const report = collectHealthReport("1.0.0");
      expect(Number.isInteger(report?.configAge)).toBe(true);
    });
  });

  describe("recordSpansExported", () => {
    it("accumulates across multiple calls", () => {
      recordSpansExported(5);
      recordSpansExported(3);
      recordSpansExported(7);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(15);
    });
  });

  describe("recordSpansDropped", () => {
    it("accumulates across multiple calls", () => {
      recordSpansDropped(2);
      recordSpansDropped(4);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesDropped).toBe(6);
    });
  });

  describe("recordInitFailure", () => {
    it("accumulates across multiple calls", () => {
      recordInitFailure();
      recordInitFailure();
      recordInitFailure();

      const report = collectHealthReport("1.0.0");
      expect(report?.initFailures).toBe(3);
    });
  });

  describe("recordConfigSync", () => {
    it("sets configAge based on sync timestamp", () => {
      const fiveSecondsAgo = Date.now() - 5000;
      recordConfigSync(fiveSecondsAgo);

      const report = collectHealthReport("1.0.0");
      expect(report?.configAge).toBeGreaterThanOrEqual(4900);
      expect(report?.configAge).toBeLessThan(6000);
    });

    it("returns configAge of 0 when no sync recorded", () => {
      const report = collectHealthReport("1.0.0");
      expect(report?.configAge).toBe(0);
    });

    it("uses the most recent sync timestamp", () => {
      recordConfigSync(Date.now() - 10000);
      recordConfigSync(Date.now() - 1000);

      const report = collectHealthReport("1.0.0");
      expect(report?.configAge).toBeGreaterThanOrEqual(900);
      expect(report?.configAge).toBeLessThan(2000);
    });

    it("clamps configAge to 0 for future timestamps", () => {
      recordConfigSync(Date.now() + 10000);

      const report = collectHealthReport("1.0.0");
      expect(report?.configAge).toBe(0);
    });
  });

  describe("acknowledgeHealthReport", () => {
    it("subtracts reported values from running counters", () => {
      recordSpansExported(10);
      recordSpansDropped(3);
      recordInitFailure();

      const snapshot = collectHealthReport("1.0.0")!;
      acknowledgeHealthReport(snapshot);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(0);
      expect(report?.tracesDropped).toBe(0);
      expect(report?.initFailures).toBe(0);
    });

    it("preserves post-snapshot increments", () => {
      recordSpansExported(10);

      const snapshot = collectHealthReport("1.0.0")!;

      // Simulate spans exported during the init HTTP call
      recordSpansExported(3);

      acknowledgeHealthReport(snapshot);

      // The 3 post-snapshot spans should be preserved
      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(3);
    });

    it("clamps to zero on edge cases", () => {
      recordSpansExported(10);
      const snapshot = collectHealthReport("1.0.0")!;

      // Reset in between (simulating test cleanup)
      _resetHealthForTesting();

      // Acknowledge should clamp to 0, not go negative
      acknowledgeHealthReport(snapshot);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(0);
      expect(report?.tracesDropped).toBe(0);
      expect(report?.initFailures).toBe(0);
    });

    it("preserves lastConfigSyncAt", () => {
      const syncTime = Date.now() - 5000;
      recordConfigSync(syncTime);
      recordSpansExported(10);

      const snapshot = collectHealthReport("1.0.0")!;
      acknowledgeHealthReport(snapshot);

      const report = collectHealthReport("1.0.0");
      expect(report?.configAge).toBeGreaterThanOrEqual(4900);
      expect(report?.configAge).toBeLessThan(6000);
    });

    it("preserves counter when report field is NaN", () => {
      recordSpansExported(10);

      // Force a NaN into the report via Object.assign to bypass TypeScript
      const corruptReport = Object.assign(collectHealthReport("1.0.0")!, {
        tracesExportedSinceLastInit: NaN,
      });
      acknowledgeHealthReport(corruptReport);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(10);
    });

    it("clamps negative report fields to zero (does not increase counter)", () => {
      recordSpansExported(10);

      // Force a negative into the report via Object.assign to bypass TypeScript
      const badReport = Object.assign(collectHealthReport("1.0.0")!, {
        tracesExportedSinceLastInit: -5,
      });
      acknowledgeHealthReport(badReport);

      // Negative report values are clamped to 0 before subtraction,
      // so the counter stays at 10 (not inflated to 15)
      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(10);
    });

    it("preserves counters on failed init (no acknowledge)", () => {
      recordSpansExported(10);
      recordInitFailure();

      // Collect snapshot (simulating backgroundInit)
      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(10);
      expect(report?.initFailures).toBe(1);

      // Simulate init failure — acknowledgeHealthReport NOT called
      // Record more activity
      recordSpansExported(5);

      // Next collect should include both the old and new counts
      const nextReport = collectHealthReport("1.0.0");
      expect(nextReport?.tracesExportedSinceLastInit).toBe(15);
      expect(nextReport?.initFailures).toBe(1);
    });
  });

  describe("Input validation", () => {
    it("ignores NaN for recordSpansExported", () => {
      recordSpansExported(5);
      recordSpansExported(NaN);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(5);
    });

    it("ignores negative values for recordSpansExported", () => {
      recordSpansExported(5);
      recordSpansExported(-3);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(5);
    });

    it("ignores Infinity for recordSpansExported", () => {
      recordSpansExported(5);
      recordSpansExported(Infinity);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(5);
    });

    it("ignores NaN for recordSpansDropped", () => {
      recordSpansDropped(2);
      recordSpansDropped(NaN);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesDropped).toBe(2);
    });

    it("ignores negative values for recordSpansDropped", () => {
      recordSpansDropped(2);
      recordSpansDropped(-1);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesDropped).toBe(2);
    });

    it("ignores fractional values for recordSpansExported", () => {
      recordSpansExported(5);
      recordSpansExported(1.5);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesExportedSinceLastInit).toBe(5);
    });

    it("ignores fractional values for recordSpansDropped", () => {
      recordSpansDropped(3);
      recordSpansDropped(0.7);

      const report = collectHealthReport("1.0.0");
      expect(report?.tracesDropped).toBe(3);
    });
  });

  describe("_resetHealthForTesting", () => {
    it("clears all metrics including lastConfigSyncAt", () => {
      recordSpansExported(10);
      recordSpansDropped(5);
      recordInitFailure();
      recordConfigSync(Date.now() - 5000);

      _resetHealthForTesting();

      const report = collectHealthReport("1.0.0");
      expect(report).toEqual({
        tracesExportedSinceLastInit: 0,
        tracesDropped: 0,
        initFailures: 0,
        configAge: 0,
        sdkVersion: "1.0.0",
      });
    });
  });
});
