/**
 * Per-request batch envelope for tRPC HTTP-batch dispatch (SDK-052 /
 * Wave 16B / advances DISC-1534 SDK-side slice).
 *
 * The envelope is set by `wrapBatchedHttpHandler` at the outer HTTP
 * boundary and read by `tracedMiddleware` inside each member's
 * dispatch — propagation is via Node `AsyncLocalStorage` so the
 * envelope flows through tRPC's `Promise.all` member dispatch
 * without coupling to tRPC's `createContext` API (which has subtle
 * shape differences between v10 and v11).
 *
 * **Per-procedure-name occurrence counter is mutable.** Batches can
 * include the same procedure name more than once; the middleware
 * tracks how many invocations it has seen per name and maps the
 * N-th invocation to the N-th positional occurrence in
 * `procedures` (positional dispatch index, NOT name-only matching).
 * The counter mutation is scoped to the single-request envelope and
 * therefore safe under tRPC's per-batch dispatch ordering — see
 * §6 of the SDK-052 brief for the full contract.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One member of a batched tRPC HTTP request, captured at URL-parse
 * time. `name` is the procedure name as it appears in the
 * comma-joined URL segment; `index` is its zero-based positional
 * order in that segment. Duplicate names across the array are
 * permitted — `index` is what disambiguates them.
 */
export interface BatchMember {
  readonly name: string;
  readonly index: number;
}

/**
 * Request-scoped envelope set by `wrapBatchedHttpHandler` for the
 * duration of one batched HTTP request. Read by `tracedMiddleware`
 * via `getBatchEnvelope()`.
 */
export interface BatchEnvelope {
  /** Ordered procedure list as parsed from the URL. */
  readonly procedures: ReadonlyArray<BatchMember>;
  /**
   * Per-name occurrence counter. Mutated by `tracedMiddleware` as
   * each invocation maps itself to the next positional member of
   * the same name. Initialized to an empty Map; entries default to
   * 0 the first time a name is queried.
   */
  readonly nameCounters: Map<string, number>;
}

const _als = new AsyncLocalStorage<BatchEnvelope>();

/**
 * Run `fn` with `envelope` set as the request-scoped batch envelope.
 * Used by `wrapBatchedHttpHandler`. Promises returned by `fn` (or
 * any async work it spawns) inherit the envelope via
 * `AsyncLocalStorage` propagation.
 */
export function withBatchEnvelope<T>(
  envelope: BatchEnvelope,
  fn: () => T,
): T {
  return _als.run(envelope, fn);
}

/**
 * Returns the current request's batch envelope, or `undefined` when
 * no envelope is in scope (the non-batched path or apps not using
 * `wrapBatchedHttpHandler`).
 */
export function getBatchEnvelope(): BatchEnvelope | undefined {
  return _als.getStore();
}

/**
 * Resolve the next positional member for a given procedure name and
 * advance the counter. Returns `undefined` when no envelope is in
 * scope, or when the name doesn't appear in the envelope, or when
 * the call's occurrence count exceeds the positional matches
 * available (the failure mode that triggers
 * `otel:trpc_batch_member_mismatch`).
 *
 * **Side effect:** advances `envelope.nameCounters` on success. The
 * mutation is scoped to the per-request envelope and therefore safe
 * under tRPC's batch-dispatch ordering — repeated invocations of
 * the same name within a single request consume positional matches
 * in order.
 */
export function resolveBatchMember(
  procedureName: string,
):
  | { envelope: BatchEnvelope; index: number; allNames: ReadonlyArray<string> }
  | undefined {
  const envelope = _als.getStore();
  if (envelope === undefined) {
    return undefined;
  }
  const occurrence = envelope.nameCounters.get(procedureName) ?? 0;
  let seen = 0;
  for (const member of envelope.procedures) {
    if (member.name === procedureName) {
      if (seen === occurrence) {
        envelope.nameCounters.set(procedureName, occurrence + 1);
        return {
          envelope,
          index: member.index,
          allNames: envelope.procedures.map((m) => m.name),
        };
      }
      seen += 1;
    }
  }
  return undefined;
}
