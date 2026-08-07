/**
 * Shared fixtures for Prisma Phase 1 aggregate-result capture tests:
 * aggregate-allowlist builders (valid, invalid, duplicated, conflicting,
 * oversized, and hostile) and result-shape builders (count maps, aggregate
 * buckets, accessor-backed and proxy-hostile results).
 *
 * Builders return plain data unless a name says otherwise; tests derive
 * defect cases by overriding single members so each case names exactly the
 * defect it exercises.
 */

import type { PrismaAggregateCaptureEntry } from "../../../packages/sdk/src/adapters/prisma.js";

/** A valid count `_all` selector for `model`, emitting `key`. */
export function countAllEntry(
  model = "Order",
  key = "matchedAmount",
): PrismaAggregateCaptureEntry {
  return { model, operation: "count", aggregate: "_count", field: "_all", key };
}

/** A valid count concrete-field selector. */
export function countFieldEntry(
  field: string,
  key: string,
  model = "Order",
): PrismaAggregateCaptureEntry {
  return { model, operation: "count", aggregate: "_count", field, key };
}

/** A valid aggregate selector. */
export function aggregateEntry(
  aggregate: PrismaAggregateCaptureEntry["aggregate"],
  field: string,
  key: string,
  model = "Order",
): PrismaAggregateCaptureEntry {
  return { model, operation: "aggregate", aggregate, field, key };
}

/**
 * An allowlist sized to overflow the private 256-raw-position inspection
 * budget: each entry consumes six raw positions (the slot plus five member
 * reads), so 43 entries overflow mid-list. Entries use distinct models so
 * no per-bucket limit interferes with the budget being the failing bound.
 */
export function overBudgetAllowlist(): PrismaAggregateCaptureEntry[] {
  return Array.from({ length: 43 }, (_, i) =>
    countAllEntry(`Model${i}`, "matchedAmount"),
  );
}

/**
 * The largest allowlist that stays inside the raw-position budget under
 * the same distinct-model construction (42 entries × 6 positions = 252).
 */
export function underBudgetAllowlist(): PrismaAggregateCaptureEntry[] {
  return Array.from({ length: 42 }, (_, i) =>
    countAllEntry(`Model${i}`, "matchedAmount"),
  );
}

/**
 * An allowlist landing on EXACTLY raw position 256: 42 object entries (six
 * positions each = 252) plus four non-object entries (one position each).
 * The last inspected position is 256, inside the budget, so the policy
 * compiles.
 */
export function exactBudgetAllowlist(): PrismaAggregateCaptureEntry[] {
  return [
    ...underBudgetAllowlist(),
    ...(["a", "b", "c", "d"] as unknown as PrismaAggregateCaptureEntry[]),
  ];
}

/**
 * The {@link exactBudgetAllowlist} construction plus one more position —
 * raw position 257 — which must fail the whole policy closed.
 */
export function justOverBudgetAllowlist(): PrismaAggregateCaptureEntry[] {
  return [
    ...exactBudgetAllowlist(),
    ...(["e"] as unknown as PrismaAggregateCaptureEntry[]),
  ];
}

/** An entry whose `key` member is accessor-backed (unsafe observation). */
export function accessorKeyEntry(): PrismaAggregateCaptureEntry {
  const entry = countAllEntry();
  const hostile = { ...entry } as Record<string, unknown>;
  Object.defineProperty(hostile, "key", {
    enumerable: true,
    get: () => "matchedAmount",
  });
  return hostile as unknown as PrismaAggregateCaptureEntry;
}

/**
 * An entry whose `key` member is an accessor with BOTH hooks undefined —
 * still an accessor descriptor per the spec (no `value` field), even
 * though reading it invokes nothing and yields `undefined`.
 */
export function undefinedHookAccessorKeyEntry(): PrismaAggregateCaptureEntry {
  const entry = countAllEntry();
  const hostile = { ...entry } as Record<string, unknown>;
  Object.defineProperty(hostile, "key", {
    enumerable: true,
    get: undefined,
  });
  return hostile as unknown as PrismaAggregateCaptureEntry;
}

/** An entry that inherits `key` from its prototype (missing as own data). */
export function inheritedKeyEntry(): PrismaAggregateCaptureEntry {
  const { key, ...rest } = countAllEntry();
  return Object.create({ key }, {
    model: { value: rest.model, enumerable: true },
    operation: { value: rest.operation, enumerable: true },
    aggregate: { value: rest.aggregate, enumerable: true },
    field: { value: rest.field, enumerable: true },
  }) as PrismaAggregateCaptureEntry;
}

/** An allowlist proxy that throws on any descriptor lookup. */
export function throwingAllowlistProxy(): ReadonlyArray<PrismaAggregateCaptureEntry> {
  return new Proxy([countAllEntry()], {
    getOwnPropertyDescriptor: () => {
      throw new Error("hostile allowlist");
    },
  });
}

/** An allowlist with an array hole between two valid entries. */
export function holedAllowlist(): ReadonlyArray<PrismaAggregateCaptureEntry> {
  const list = new Array<PrismaAggregateCaptureEntry>(3);
  list[0] = countAllEntry("Other", "otherAmount");
  list[2] = countAllEntry();
  return list;
}

/** A revoked proxy in place of the allowlist array. */
export function revokedAllowlistProxy(): ReadonlyArray<PrismaAggregateCaptureEntry> {
  const { proxy, revoke } = Proxy.revocable([countAllEntry()], {});
  revoke();
  return proxy as unknown as ReadonlyArray<PrismaAggregateCaptureEntry>;
}

/**
 * A proxy over a genuine array whose descriptor trap is hostile only for
 * `length`; every other observation answers honestly. Discriminates the
 * own-data `length` observation: a plain `.length` property get would
 * forward to the target and succeed.
 */
export function lengthHostileArrayProxy<T>(entries: ReadonlyArray<T>): ReadonlyArray<T> {
  return new Proxy(entries as T[], {
    getOwnPropertyDescriptor: (target, property) => {
      if (property === "length") throw new Error("hostile length");
      return Object.getOwnPropertyDescriptor(target, property);
    },
  });
}

/** A result object whose named field is accessor-backed; the getter records calls. */
export function accessorResult(field: string): {
  result: Record<string, unknown>;
  getterCalls: () => number;
} {
  let calls = 0;
  const result: Record<string, unknown> = {};
  Object.defineProperty(result, field, {
    enumerable: true,
    get: () => {
      calls += 1;
      return 7;
    },
  });
  return { result, getterCalls: () => calls };
}

/** A result proxy that throws on any descriptor lookup. */
export function throwingResultProxy(): unknown {
  return new Proxy(
    { _all: 7 },
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("hostile result");
      },
    },
  );
}

/** A `Decimal`-like object (what Prisma returns for Decimal columns). */
export function decimalLike(value: string): unknown {
  return { d: [1], e: 0, s: 1, toFixed: () => value, toString: () => value };
}
