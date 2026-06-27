/**
 * Passive Prisma value-capture adapter (L1 capture).
 *
 * `prismaAdapter({ allow })` returns a Prisma client extension that, for
 * each allowlisted `(model, column)`, projects a result field — a boolean
 * (default) or, with an `as` intent, a finite number — onto a Glasstrace
 * value-fidelity scalar so an agent can read it back from the trace. It is
 * **passive and observational**: it never executes a query
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
 *  - **OWN a span.** The ambient span at the capture point is not a reliable
 *    emit target — depending on the Prisma / instrumentation version it may be
 *    the (possibly already-ended) database operation span rather than a
 *    `db.<Model>.<op>` span — so the adapter opens its own recording
 *    `db.<Model>.<op>` span (a same-trace descendant of the request span) and
 *    emits onto it via {@link capture}.
 *  - **Default-deny.** Nothing is captured unless an explicit `allow` entry
 *    matches AND the server-pushed `sideEffectEvidence` capture flag is on.
 *    An empty / unset `allow` captures nothing.
 *  - **Allowlisted scalars.** Each column projects onto a value-fidelity
 *    scalar by its `as` intent — a boolean `*Flag` (default), a finite
 *    numeric `*Value`/`*Amount`/`*Ms`/`*Bytes`/`*Ratio`, or a pseudonymized
 *    identifier `*Id` (`id` intent). Numeric intents capture native
 *    JavaScript `number` values only; non-`number` shapes such as a Prisma
 *    `Decimal` (a Decimal.js object) or `BigInt` are safely omitted rather
 *    than lossily converted — project a pre-converted `number` if you need
 *    them. The `id` intent emits a `gthid_` token — the raw id hashed under a
 *    provisioned per-account key — only under `captureFidelity: "full"`, and
 *    never the raw value. A value whose type does not match its intent routes
 *    to a safe omission counter, never a captured value. Categorical scalars
 *    are out of scope.
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
import { capture, captureOmission } from "../side-effect/capture.js";
import {
  getActiveConfig,
  getAttrHmacKey,
  isCaptureEnabled,
} from "../init-client.js";
import { hashIdWeb } from "../side-effect/hash-id-web.js";
import { decisionTrace, decisionTraceEnabled } from "../decision-trace.js";

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

/**
 * How an allowlisted column is projected — selects the value-fidelity scalar
 * key suffix and the expected value type. `flag` is a boolean (`*Flag`); the
 * numeric intents are finite numbers (`*Value`/`*Amount`/`*Ms`/`*Bytes`/
 * `*Ratio`), where `ms` is a bounded delta, never a wall-clock epoch (a raw
 * epoch is rejected at emit). `id` projects an identifier column as a
 * pseudonymized `gthid_` token (`*Id`) — gated on full fidelity with a
 * provisioned per-account key (see {@link PrismaCaptureColumn.as}); the raw
 * value never reaches the wire. Categorical scalars remain unsupported.
 */
export type ScalarIntent =
  | "flag"
  | "value"
  | "amount"
  | "ms"
  | "bytes"
  | "ratio"
  | "id";

/** A single allowlisted column to project. */
export interface PrismaCaptureColumn {
  /** The Prisma model name, PascalCase, exactly as Prisma reports it (e.g. `Poll`). */
  model: string;
  /** The result column to project (e.g. `muted`, `total`). */
  column: string;
  /**
   * How to project the column's value (default `flag`). `flag` projects a
   * boolean onto a `*Flag` scalar; the numeric intents project a native
   * JavaScript `number` onto `*Value` / `*Amount` / `*Ms` / `*Bytes` /
   * `*Ratio` (the column with the intent's suffix). The value is
   * strict-validated by type at emit, so a value whose type does not match the
   * intent — including a Prisma `Decimal`/`BigInt`, which are not native
   * `number`s — is dropped, never captured.
   *
   * `id` projects a `string` or `number` identifier onto an `*Id` scalar as a
   * pseudonymized `gthid_` token. It is captured only when the account is on
   * `captureFidelity: "full"` AND a per-account hashing key has been
   * provisioned; otherwise (or for a non-string/number id) the column is
   * dropped, never captured. The raw identifier is never emitted.
   */
  as?: ScalarIntent;
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

/** The value-fidelity scalar-key suffix for each {@link ScalarIntent}. */
const INTENT_SUFFIX: Readonly<Record<ScalarIntent, string>> = {
  flag: "Flag",
  value: "Value",
  amount: "Amount",
  ms: "Ms",
  bytes: "Bytes",
  ratio: "Ratio",
  id: "Id",
};

/**
 * Every supported {@link ScalarIntent}, derived from {@link INTENT_SUFFIX} so
 * the two cannot drift — used to validate `as` input from untyped callers.
 */
const SCALAR_INTENTS = Object.keys(
  INTENT_SUFFIX,
) as ReadonlyArray<ScalarIntent>;

/**
 * Derive the scalar key for an allowlisted column and its intent — the column
 * with the intent's suffix appended (not doubled if the column already ends in
 * it). This derivation is deterministic and stable because the server-side
 * operator allowlist keys on the emitted scalar key (`<column><Suffix>`), not
 * the source column.
 */
function deriveScalarKey(column: string, intent: ScalarIntent): string {
  const suffix = INTENT_SUFFIX[intent];
  return column.endsWith(suffix) ? column : `${column}${suffix}`;
}

/**
 * Project an allowlisted identifier column as a pseudonymized `gthid_` token.
 * Identifier capture is an operator escalation, so it is silent unless the
 * account is on `captureFidelity: "full"`. Under `full`, a provisioned
 * per-account `attrHmacKey` plus a non-empty `string`/`number` raw id yields a
 * `gthid_` token — the raw id is hashed under the key and only the token is
 * emitted, so the raw value never reaches the wire. A genuinely missing key
 * (a `full` account the backend served with no key), a non-hashable id, or a
 * Web Crypto failure records a count-only `unhashed_id` omission — never
 * emitting the raw value, even one already shaped like a `gthid_` token — so a
 * misconfigured `full` account is observable.
 *
 * The provisioned `attrHmacKey` lives on the shared active-config record (see
 * `active-config-store.ts`), so it is reachable here even when the Prisma
 * projection runs in a different bundle copy from the one that applied the
 * config (the Turbopack-dev bundle split). There is therefore no
 * "provisioned-but-unreadable" state to special-case: a `full` account either
 * has a usable key (→ `gthid_`) or is genuinely key-less (→ `unhashed_id`).
 */
async function projectIdentifier(
  span: Span,
  key: string,
  rawValue: unknown,
): Promise<void> {
  // Decision trace: the model-level fidelity gate. Identifier capture is an
  // operator escalation that runs only under `full`; under any other posture
  // (the guard is `!== "full"`, not strictly "strict") it is silently
  // suppressed. Keyed by the closed outcome (two values) so it stays bounded.
  // Call-site guarded so no detail is built when OFF.
  if (getActiveConfig().captureFidelity !== "full") {
    if (decisionTraceEnabled()) {
      decisionTrace("capture.fidelity.idModel", "suppressed", {
        inputs: { surface: "prismaAdapter" },
        oneShotKey: "capture.fidelity.idModel:suppressed",
      });
    }
    return;
  }
  if (decisionTraceEnabled()) {
    decisionTrace("capture.fidelity.idModel", "full", {
      inputs: { surface: "prismaAdapter" },
      oneShotKey: "capture.fidelity.idModel:full",
    });
  }
  const hmacKey = getAttrHmacKey();
  // Decision trace: the per-account hashing-key state ALONE — provisioned vs
  // genuinely absent. A distinct facet from the value-result below: a
  // non-hashable id under a provisioned key still reports `provisioned` here
  // (and `unhashed` on the identifier facet), so this point answers "did the
  // backend serve a key?" without conflating it with the id's shape.
  const keyProvisioned = typeof hmacKey === "string" && hmacKey.length > 0;
  if (decisionTraceEnabled()) {
    const keyState = keyProvisioned ? "provisioned" : "absent";
    decisionTrace("capture.fidelity.hmacKey", keyState, {
      inputs: { surface: "prismaAdapter" },
      oneShotKey: `capture.fidelity.hmacKey:${keyState}`,
    });
  }
  const raw =
    typeof rawValue === "string" || typeof rawValue === "number"
      ? String(rawValue)
      : "";
  if (raw.length > 0 && keyProvisioned) {
    const token = await hashIdWeb(raw, hmacKey);
    if (token !== null) {
      // Decision trace: the value outcome — the raw id hashed to a token,
      // so a pseudonymized `gthid_` is emitted (never the raw value).
      if (decisionTraceEnabled()) {
        decisionTrace("capture.fidelity.identifier", "hashed", {
          inputs: { surface: "prismaAdapter" },
          oneShotKey: "capture.fidelity.identifier:hashed",
        });
      }
      capture(key, token, { span });
      return;
    }
  }
  // Decision trace: the value outcome — the column fell through to a
  // count-only omission (no token emitted), so the identifier stays unhashed.
  // This covers a genuinely absent key, a non-hashable id (under a provisioned
  // key), and a Web Crypto failure.
  if (decisionTraceEnabled()) {
    decisionTrace("capture.fidelity.identifier", "unhashed", {
      inputs: { surface: "prismaAdapter" },
      oneShotKey: "capture.fidelity.identifier:unhashed",
    });
  }
  // Fail-closed: genuinely missing key, no hashable id, or a hash failure.
  // Record the miss via `captureOmission` rather than routing the raw value
  // through `capture()` — a raw value that happens to be `gthid_`-shaped would
  // otherwise pass strict validation and emit an unkeyed token, bypassing the
  // operator gate. `captureOmission` re-checks the capture gate at emit, so a
  // mid-operation config rotation that disables capture writes nothing.
  captureOmission("unhashed_id", { span });
}

/**
 * Project every allowlisted column present in a single-row result onto the
 * owned span via {@link capture}. Guards non-object results (a `findUnique`
 * miss returns `null`; aggregates return non-objects; lists are arrays).
 * Never throws — {@link capture} swallows its own errors, and the call is
 * additionally fenced so a malformed result can never affect the query.
 *
 * Async because the `id` intent hashes its value via the Web Crypto API; the
 * caller ends the owned span only after this resolves.
 */
async function projectAllowlisted(
  span: Span,
  columns: ReadonlyMap<string, ScalarIntent>,
  result: unknown,
): Promise<void> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return;
  }
  const row = result as Record<string, unknown>;
  for (const [column, intent] of columns) {
    if (!(column in row)) continue;
    const key = deriveScalarKey(column, intent);
    if (intent === "id") {
      await projectIdentifier(span, key, row[column]);
    } else {
      capture(key, row[column], { span });
    }
  }
}

/**
 * Build a passive Prisma value-capture extension. See the module doc for
 * the full behavior contract.
 */
export function prismaAdapter(
  options: PrismaAdapterOptions = {},
): PrismaCaptureExtension {
  // Compile the allowlist into model -> map(column -> intent) once at
  // construction. An out-of-contract `as` (untyped callers) drops the entry
  // (default-deny).
  const policy = new Map<string, Map<string, ScalarIntent>>();
  // Models with at least one eager (non-`id`) column. Such a column captures
  // under strict fidelity, so the model always warrants an owned span; an
  // id-only model warrants one only once the operator enables full fidelity.
  const eagerModels = new Set<string>();
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
    // Only an absent `as` defaults to "flag"; an explicitly-provided
    // out-of-contract value (incl. `null` from untyped/JSON callers) drops
    // the entry (default-deny) rather than silently falling back to "flag".
    const intent = entry.as === undefined ? "flag" : entry.as;
    if (!SCALAR_INTENTS.includes(intent)) {
      continue;
    }
    let columns = policy.get(entry.model);
    if (!columns) {
      columns = new Map();
      policy.set(entry.model, columns);
    }
    columns.set(entry.column, intent);
    if (intent !== "id") {
      eagerModels.add(entry.model);
    }
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

          // An id-only model adds no span volume until the operator enables
          // full fidelity: under `strict` its sole `id` intent captures nothing
          // and records nothing, so opening a span would be pure overhead.
          // Under `full` the span is warranted — projection either captures the
          // `gthid_` token (usable key, reachable cross-copy via the shared
          // record) or records a visible `unhashed_id` omission (genuinely
          // key-less account).
          if (
            !eagerModels.has(model) &&
            getActiveConfig().captureFidelity !== "full"
          ) {
            return query(args);
          }

          // OWN a recording db.<Model>.<op> span — a same-trace descendant of
          // the request span (its immediate parent is the active span, which
          // on some Prisma/instrumentation versions is the still-recording
          // operation span). The span name is the attribution anchor. If the
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
              await projectAllowlisted(span, columns, result);
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
