/**
 * Resolve-once store for the span-diagnostics on/off flag, shared across bundle
 * instances via a `globalThis` `Symbol.for` slot.
 *
 * Node-only by design: the pre-resolution fallback reads `process.env`, so this
 * module must never be pulled into the edge bundle or an `/edge` subpath. It
 * touches only `globalThis`, a `Symbol.for` symbol, and `process.env`.
 *
 * Why a `globalThis` singleton rather than the module-local state used by
 * decision-trace.ts: the `@glasstrace/sdk/diagnostics` subpath is a separate
 * bundle entry, so its inlined copy of this module is a different instance than
 * the copy `register.ts` writes through. `register.ts` resolves the flag once in
 * the main bundle; a processor constructed via the subpath reads it through the
 * subpath's copy. Keying the state on `Symbol.for` makes both copies converge on
 * the value `register.ts` resolved rather than each seeing its own module-local
 * `null` — the same cross-bundle-copy hazard that active-config-store.ts guards.
 */

/**
 * Branded discriminator on the stored record, so a foreign value that happens to
 * collide on the well-known symbol is treated as "no store yet" and replaced
 * rather than trusted. A robustness guard, not a security boundary. Bumped when
 * the record shape changes.
 */
const GLASSTRACE_SPAN_DIAGNOSTICS_BRAND = 1 as const;

/** Process-wide (per-isolate) symbol under which the flag record is stored. */
const STORE = Symbol.for("glasstrace.span-diagnostics");

interface SpanDiagnosticsFlagRecord {
  readonly glasstraceSpanDiagnosticsBrand: typeof GLASSTRACE_SPAN_DIAGNOSTICS_BRAND;
  // `null` = not yet resolved by `register.ts`; the getter then falls back to
  // the raw env var so a pre-resolution read — or a subpath bundle copy in a
  // process where `register.ts` never ran — still reflects the operator intent.
  enabled: boolean | null;
}

function isFlagRecord(value: unknown): value is SpanDiagnosticsFlagRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SpanDiagnosticsFlagRecord>;
  if (candidate.glasstraceSpanDiagnosticsBrand !== GLASSTRACE_SPAN_DIAGNOSTICS_BRAND) {
    return false;
  }
  return candidate.enabled === null || typeof candidate.enabled === "boolean";
}

function getStore(): SpanDiagnosticsFlagRecord {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[STORE];
  if (isFlagRecord(existing)) return existing;
  const fresh: SpanDiagnosticsFlagRecord = {
    glasstraceSpanDiagnosticsBrand: GLASSTRACE_SPAN_DIAGNOSTICS_BRAND,
    enabled: null,
  };
  slot[STORE] = fresh;
  return fresh;
}

/**
 * Record the resolved span-diagnostics flag. Called once from
 * `registerGlasstrace()`. Not exported from the public package barrel — internal
 * coordination only.
 *
 * @internal
 */
export function setSpanDiagnosticsFlag(enabled: boolean): void {
  getStore().enabled = enabled;
}

/**
 * Whether span diagnostics are enabled. Returns the resolved flag once
 * `registerGlasstrace()` has set it; before then (or in a bundle copy where it
 * never ran) falls back to the `GLASSTRACE_SPAN_DIAGNOSTICS` env var. Read fresh
 * on every call. Not exported from the public package barrel.
 *
 * @internal
 */
export function spanDiagnosticsEnabled(): boolean {
  const resolved = getStore().enabled;
  if (resolved !== null) return resolved;
  return process.env.GLASSTRACE_SPAN_DIAGNOSTICS === "true";
}

/**
 * Test-only reset for the flag store, so same-process test cases do not leak the
 * toggle across each other. Not exported from the public package barrel.
 *
 * @internal
 */
export function _resetSpanDiagnosticsFlagForTesting(): void {
  delete (globalThis as Record<symbol, unknown>)[STORE];
}
