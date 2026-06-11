/**
 * Passive Prisma value-capture adapter (L1 capture).
 *
 * `prismaAdapter({ allow })` returns a Prisma client extension that, for
 * each allowlisted `(model, column)`, projects a boolean result field onto
 * a Glasstrace value-fidelity scalar so an agent can read it back from the
 * trace. It is **passive and observational**: it never executes a query
 * itself, never reads or mutates the result, and never changes query
 * behavior or errors.
 *
 * Apply it like any Prisma extension:
 *
 * ```ts
 * import { prismaAdapter } from "@glasstrace/sdk";
 *
 * const prisma = new PrismaClient().$extends(
 *   prismaAdapter({ allow: [{ model: "Poll", column: "muted" }] }),
 * );
 * ```
 *
 * Design:
 *  - **OWN a span.** At the capture point the database client's own
 *    operation span has already ended, so the adapter opens its own
 *    recording `db.<Model>.<op>` span (parented under the active request
 *    span) and emits onto it via {@link capture}.
 *  - **Default-deny.** Nothing is captured unless an explicit `allow` entry
 *    matches AND the server-pushed `sideEffectEvidence` capture flag is on.
 *    An empty / unset `allow` captures nothing.
 *  - **Boolean only.** This adapter projects boolean columns (the strict,
 *    no-`captureFidelity:full` case). Non-boolean allowlisted columns route
 *    to a safe omission counter, never a captured value.
 *  - **Pure observer.** Capture work can never throw into the host query;
 *    the owned span is always ended; the original query error is re-thrown
 *    verbatim.
 *  - **Bounded.** `findMany` / list operations are disabled (no per-row
 *    capture). The adapter never widens the app's `select`.
 *
 * This module has **no dependency on `@prisma/client`** — it is typed
 * structurally against Prisma's client-extension shape (mirroring the
 * Drizzle adapter), so it adds no runtime dependency and ships on the edge-
 * safe root barrel. On a runtime with no active request span (e.g. an edge
 * runtime with no AsyncLocalStorage), it captures nothing.
 */

import { trace, SpanKind, type Span } from "@opentelemetry/api";
import { capture } from "../side-effect/capture.js";
import { isCaptureEnabled } from "../init-client.js";

/** The arguments Prisma passes to a `$allOperations` query-extension callback. */
interface PrismaAllOperationsArgs {
  /** The Prisma model name (PascalCase, e.g. `Poll`), or `undefined` for raw ops. */
  model?: string;
  /** The Prisma operation (e.g. `findUnique`, `findMany`, `update`). */
  operation: string;
  /** The operation arguments, forwarded unchanged to `query`. */
  args: unknown;
  /** Executes the underlying operation. Called exactly once. */
  query: (args: unknown) => Promise<unknown>;
}

/**
 * A Prisma client extension — the object passed to `prisma.$extends(...)`.
 * Structurally typed so the adapter needs no `@prisma/client` dependency.
 */
export interface PrismaCaptureExtension {
  name: string;
  query: {
    $allModels: {
      $allOperations(args: PrismaAllOperationsArgs): Promise<unknown>;
    };
  };
}

/** A single allowlisted column to project. */
export interface PrismaCaptureColumn {
  /** The Prisma model name, PascalCase, exactly as Prisma reports it (e.g. `Poll`). */
  model: string;
  /** The boolean result column to project (e.g. `muted`). */
  column: string;
}

/** Options for {@link prismaAdapter}. */
export interface PrismaAdapterOptions {
  /**
   * The default-deny allowlist. Only `(model, column)` pairs listed here are
   * eligible for capture; an empty or unset list captures nothing. The
   * server-side per-tenant allowlist re-enforces this independently at
   * ingestion.
   */
  allow?: ReadonlyArray<PrismaCaptureColumn>;
}

const TRACER_NAME = "glasstrace-prisma";

/**
 * Whether a **recording** request span is active, fail-closed. The adapter
 * parents its owned span under the request span and must capture nothing when
 * none is present (out-of-request / edge runtimes with no AsyncLocalStorage)
 * or when the active span is ended / a `NonRecordingSpan` (e.g. sampled out) —
 * mirroring `getRecordingActiveSpan` in `side-effect/emit.ts`. Wrapped so an
 * OTel API surface error can never propagate into the host query
 * (pure-observer).
 */
function hasRecordingActiveSpan(): boolean {
  try {
    const span = trace.getActiveSpan();
    if (span === undefined) return false;
    // `isRecording()` is false for both NonRecordingSpan and ended spans; a
    // missing impl (host shim) is treated as recording, as elsewhere.
    if (typeof span.isRecording === "function" && !span.isRecording()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the owned `db.<Model>.<op>` recording span, or `undefined` if the OTel
 * API throws. A `undefined` return makes the caller fall back to running the
 * query untouched — the capture machinery must never throw into the host
 * query (pure-observer).
 */
function openOwnedSpan(model: string, operation: string): Span | undefined {
  try {
    return trace
      .getTracer(TRACER_NAME)
      .startSpan(`db.${model}.${operation}`, { kind: SpanKind.CLIENT });
  } catch {
    return undefined;
  }
}

/**
 * Derive the scalar key for a boolean column. A boolean projects onto a
 * `*Flag` scalar; the key is the column with a `Flag` suffix (not doubled if
 * the column already ends in `Flag`). This derivation is deterministic and
 * stable because the server-side operator allowlist keys on the emitted
 * scalar key (`<column>Flag`), not the source column.
 */
function deriveFlagKey(column: string): string {
  return column.endsWith("Flag") ? column : `${column}Flag`;
}

/**
 * Project every allowlisted column present in a single-row result onto the
 * owned span via {@link capture}. Guards non-object results (a `findUnique`
 * miss returns `null`; aggregates return non-objects; lists are arrays).
 * Never throws — {@link capture} swallows its own errors, and the call is
 * additionally fenced so a malformed result can never affect the query.
 */
function projectAllowlisted(
  span: Span,
  columns: ReadonlySet<string>,
  result: unknown,
): void {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return;
  }
  const row = result as Record<string, unknown>;
  for (const column of columns) {
    if (!(column in row)) continue;
    capture(deriveFlagKey(column), row[column], { span });
  }
}

/**
 * Build a passive Prisma value-capture extension. See the module doc for
 * the full behavior contract.
 */
export function prismaAdapter(
  options: PrismaAdapterOptions = {},
): PrismaCaptureExtension {
  // Compile the allowlist into model -> set(columns) once at construction.
  const policy = new Map<string, Set<string>>();
  for (const entry of options?.allow ?? []) {
    if (
      !entry ||
      typeof entry.model !== "string" ||
      typeof entry.column !== "string" ||
      entry.model.length === 0 ||
      entry.column.length === 0
    ) {
      continue;
    }
    let columns = policy.get(entry.model);
    if (!columns) {
      columns = new Set();
      policy.set(entry.model, columns);
    }
    columns.add(entry.column);
  }

  return {
    name: "glasstrace-capture",
    query: {
      $allModels: {
        async $allOperations(
          params: PrismaAllOperationsArgs,
        ): Promise<unknown> {
          const { model, operation, args, query } = params;

          // Decide eligibility BEFORE opening a span so the default-deny /
          // disabled path adds zero span volume (hot-path) and never emits
          // on an orphan (edge / no request context). All four gates:
          //  - the model has an allow entry (default-deny);
          //  - the operation is not a multi-row list op (list/`findMany`
          //    capture is disabled until a per-row cap + selection rule is
          //    specified);
          //  - the capture master switch is on (fail-closed default off);
          //  - a recording request span is active (in-request, same-trace;
          //    edge has no ALS / no active span, and a sampled-out span is
          //    non-recording — capture nothing in both cases).
          const columns =
            model !== undefined ? policy.get(model) : undefined;
          if (
            model === undefined ||
            columns === undefined ||
            operation === "findMany" ||
            !isCaptureEnabled() ||
            !hasRecordingActiveSpan()
          ) {
            return query(args);
          }

          // OWN a recording db.<Model>.<op> span, parented under the active
          // request span. The span name is the attribution anchor. If the
          // OTel API fails to open the span, fall back to running the query
          // untouched — the capture path must never throw into it.
          const span = openOwnedSpan(model, operation);
          if (span === undefined) {
            return query(args);
          }
          try {
            const result = await query(args);
            // Fence projection so a malformed result can never alter the
            // query's own outcome (pure-observer invariant).
            try {
              projectAllowlisted(span, columns, result);
            } catch {
              // Never let capture work affect the host query result.
            }
            return result;
          } finally {
            // Always end the owned span, even when `query` throws; the
            // original error propagates verbatim (not swallowed). The end()
            // is itself guarded so it cannot mask that error.
            try {
              span.end();
            } catch {
              // OTel end() failure must not surface to the host query.
            }
          }
        },
      },
    },
  };
}
