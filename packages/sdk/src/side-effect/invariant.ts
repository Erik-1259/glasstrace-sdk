/**
 * Producer-sugar for computing boolean relations to emit as `*Holds`
 * side-effect evidence.
 *
 * These helpers turn a comparison into the boolean a producer passes to
 * `recordSideEffect({ relations: { …Holds: invariant(a, "eq", b) } })`.
 * They are pure (no I/O, no Node built-ins) and edge-safe, so they live
 * on the root barrel. The operator set is intentionally minimal and
 * fixed — six binary comparisons plus a separate unary null check — and
 * is not a general expression DSL.
 */

/**
 * The six supported binary comparison operators. `isNull` is **not** an
 * operator here — use {@link isNullInvariant} for the unary case.
 */
export type InvariantOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

/**
 * Evaluate a binary comparison invariant and return the boolean result.
 *
 * Both operands are constrained to the same primitive type. `eq`/`neq`
 * use strict equality; the ordering operators (`lt`/`lte`/`gt`/`gte`)
 * use the language relational operators (numeric for numbers/bigints,
 * lexical for strings). Intended for producing a `*Holds` relation, e.g.
 * `invariant(emittedDurationMinutes, "eq", declaredDurationMinutes)`.
 *
 * Operands should be comparable primitives. `NaN` follows IEEE-754
 * (unequal to everything; all orderings `false`), so screen `NaN` before
 * asserting a relation. Passing a non-primitive (e.g. a `Symbol`, or an
 * object with a throwing `valueOf`) to an ordering operator throws per
 * JS semantics — the type signature prevents this for typed callers.
 *
 * @param left - The left operand.
 * @param op - One of the six {@link InvariantOp} comparisons.
 * @param right - The right operand (same primitive type as `left`).
 * @returns The boolean result of `left <op> right`.
 *
 * @example
 * recordSideEffect({
 *   kind: "calendar_link",
 *   operation: "invite.create",
 *   relations: {
 *     durationMatchesHolds: invariant(emittedMinutes, "eq", declaredMinutes),
 *   },
 * });
 */
export function invariant<T extends number | string | bigint | boolean>(
  left: T,
  op: InvariantOp,
  right: T,
): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
  }
  // For well-typed callers `op` is `never` here, so this `satisfies`
  // enforces switch exhaustiveness at compile time (adding an
  // `InvariantOp` member without a case is a type error). The `return`
  // is the runtime fallback for an untyped (JS) caller passing an
  // out-of-domain op — it yields a `boolean`, never `undefined`.
  op satisfies never;
  return false;
}

/**
 * Unary null/undefined invariant — `true` when `value` is `null` or
 * `undefined`. Kept separate from {@link invariant} because nullishness
 * is a unary predicate, not a binary comparison (there is no `isNull`
 * operator). Use for a `*Holds` relation asserting a value's absence,
 * e.g. `relations: { recipientMissingHolds: isNullInvariant(recipient) }`.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is `null` or `undefined`, else `false`
 *   (falsy-but-present values like `0`, `""`, `false`, `NaN` are `false`).
 */
export function isNullInvariant(value: unknown): boolean {
  return value === null || value === undefined;
}
