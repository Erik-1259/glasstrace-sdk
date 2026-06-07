/**
 * Tests for `invariant` / `isNullInvariant` — the producer-sugar that
 * computes boolean `*Holds` relations.
 */

import { describe, it, expect } from "vitest";
import {
  invariant,
  isNullInvariant,
} from "../../../../packages/sdk/src/side-effect/invariant.js";

describe("invariant", () => {
  it("evaluates each of the six binary operators on numbers", () => {
    expect(invariant(2, "eq", 2)).toBe(true);
    expect(invariant(2, "eq", 3)).toBe(false);
    expect(invariant(2, "neq", 3)).toBe(true);
    expect(invariant(2, "neq", 2)).toBe(false);
    expect(invariant(2, "lt", 3)).toBe(true);
    expect(invariant(3, "lt", 3)).toBe(false);
    expect(invariant(3, "lte", 3)).toBe(true);
    expect(invariant(4, "lte", 3)).toBe(false);
    expect(invariant(4, "gt", 3)).toBe(true);
    expect(invariant(3, "gt", 3)).toBe(false);
    expect(invariant(3, "gte", 3)).toBe(true);
    expect(invariant(2, "gte", 3)).toBe(false);
  });

  it("uses strict equality for eq/neq (no coercion)", () => {
    expect(invariant("2", "eq", "2")).toBe(true);
    expect(invariant("a", "neq", "b")).toBe(true);
  });

  it("compares strings lexically, not numerically (regression guard)", () => {
    expect(invariant("a", "lt", "b")).toBe(true);
    expect(invariant("b", "gt", "a")).toBe(true);
    // Lexically "10" < "9" ('1' < '9'); a numeric-coercion revert would
    // make this false.
    expect(invariant("10", "lt", "9")).toBe(true);
  });

  it("compares bigints numerically (not lexically)", () => {
    expect(invariant(10n, "gt", 2n)).toBe(true); // numeric: 10 > 2
    expect(invariant(2n, "lt", 10n)).toBe(true);
    expect(invariant(5n, "eq", 5n)).toBe(true);
  });

  it("handles boolean operands", () => {
    expect(invariant(true, "eq", true)).toBe(true);
    expect(invariant(true, "neq", false)).toBe(true);
    expect(invariant(false, "lt", true)).toBe(true); // false(0) < true(1)
  });

  it("follows IEEE-754 for NaN operands", () => {
    expect(invariant(Number.NaN, "eq", Number.NaN)).toBe(false);
    expect(invariant(Number.NaN, "neq", 1)).toBe(true);
    expect(invariant(Number.NaN, "lt", 1)).toBe(false);
    expect(invariant(Number.NaN, "gt", 1)).toBe(false);
  });

  it("returns a boolean (false), not undefined, for an out-of-domain op (JS callers)", () => {
    const loose = invariant as (a: number, op: string, b: number) => boolean;
    expect(loose(1, "bogus", 2)).toBe(false);
    expect(typeof loose(1, "isNull", 2)).toBe("boolean");
  });
});

describe("isNullInvariant", () => {
  it("is true for null and undefined", () => {
    expect(isNullInvariant(null)).toBe(true);
    expect(isNullInvariant(undefined)).toBe(true);
  });

  it("is false for present values, including falsy ones", () => {
    for (const v of [0, "", false, NaN, [], {}]) {
      expect(isNullInvariant(v)).toBe(false);
    }
  });
});
