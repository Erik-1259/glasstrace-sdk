/**
 * Passive Prisma value-capture adapter (L1 capture).
 *
 * `prismaAdapter({ allow })` returns a Prisma client extension that, for
 * each allowlisted `(model, column)`, projects a result field — a boolean
 * (default), a finite number under a numeric `as` intent, or a pseudonymized
 * identifier under the `id` intent — onto a Glasstrace value-fidelity scalar
 * so an agent can read it back from the trace. A separate, equally explicit
 * `aggregateAllow` list opts named `count` / `aggregate` results into
 * provider-neutral result-evidence bundles (see
 * {@link PrismaAggregateCaptureEntry}). The adapter is **passive and
 * observational**: it invokes Prisma's supplied query callback exactly once
 * and never issues an additional query, inspects only own fields named by an
 * explicit allowlist entry, never mutates query arguments or results, and
 * never changes query behavior or errors.
 *
 * Apply it like any Prisma extension:
 *
 * ```ts
 * import { PrismaClient } from "@prisma/client";
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
 *  - **Default-deny.** Nothing is captured unless an explicit allowlist
 *    entry matches AND the server-pushed `sideEffectEvidence` capture flag
 *    is on — `allow` for single-record value capture, `aggregateAllow`
 *    (additionally gated on the server-granted aggregate-scalars
 *    result-evidence capability) for count/aggregate result capture. Empty
 *    or unset lists capture nothing.
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
 *  - **Bounded.** Single-record value capture is limited to `findUnique`,
 *    `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `create`, `update`,
 *    `upsert`, and `delete`; `count` and `aggregate` results are captured
 *    only through explicit `aggregateAllow` selectors; and `findMany`
 *    results are captured only as bounded row evidence (at most 8 rows,
 *    the shared 16-scalar ceiling) under the server-granted bounded-rows
 *    capability. Every other list, group, bulk, raw, or unknown operation
 *    is inert. The adapter never widens the app's `select` and never
 *    inspects arguments.
 *
 * This module has **no dependency on `@prisma/client`** — it is typed
 * structurally against Prisma's client-extension shape (mirroring the
 * Drizzle adapter), so it adds no runtime dependency and ships on the edge-
 * safe root barrel. On a runtime with no active request span (e.g. an edge
 * runtime with no AsyncLocalStorage), it captures nothing.
 */

import { trace, SpanKind, type Span } from "@opentelemetry/api";
import {
  MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION,
  MAX_SIDE_EFFECT_SCALARS_PER_OPERATION,
  RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY,
  RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY,
  SIDE_EFFECT_SCALAR_PREFIX,
  buildResultEvidenceProducerRowMetadataKey,
  buildResultEvidenceRowScalarKey,
  isResultEvidenceTimestampShapedNumeric,
  isSideEffectScalarKey,
  type SideEffectOmissionReason,
} from "@glasstrace/protocol";
import { capture, captureOmission } from "../side-effect/capture.js";
import { recordOmission } from "../side-effect/emit.js";
import {
  getActiveConfig,
  getAttrHmacKey,
  getOperationConfigView,
  isCaptureEnabled,
  type OperationConfigView,
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

/**
 * A single explicit Prisma aggregate-result selector for result-evidence
 * capture. Every member is required and closed:
 *
 *  - `model` — the Prisma model name, ASCII `[A-Za-z][A-Za-z0-9_]{0,63}`.
 *  - `operation` — `"count"` or `"aggregate"`, matched exactly against the
 *    Prisma operation name; no other operation is ever eligible.
 *  - `aggregate` — the closed aggregate bucket. The discriminated union
 *    encodes the operation constraint: `"count"` permits only `"_count"`.
 *  - `field` — the concrete result field to read, or the `"_all"` sentinel
 *    (the only sentinel, valid only on the `"_count"` bucket). Concrete
 *    names follow the same ASCII grammar as `model`.
 *  - `key` — the emitted numeric scalar key: the unchanged 80-character
 *    scalar-key grammar with a `Ms` / `Amount` / `Bytes` / `Ratio` /
 *    `Value` suffix. Aggregate-result capture never emits `Id`, `Flag`, or
 *    `Count` keys.
 *
 * Selection is never inferred from a result's shape — a value is read only
 * when an entry explicitly names it, and only when the server has granted
 * the aggregate-scalars result-evidence capability. The same constraints
 * are re-validated at runtime for untyped callers.
 */
export type PrismaAggregateCaptureEntry =
  | {
      readonly model: string;
      readonly operation: "count";
      readonly aggregate: "_count";
      readonly field: string;
      readonly key: string;
    }
  | {
      readonly model: string;
      readonly operation: "aggregate";
      readonly aggregate: "_count" | "_avg" | "_sum" | "_min" | "_max";
      readonly field: string;
      readonly key: string;
    };

/** Options for {@link prismaAdapter}. */
export interface PrismaAdapterOptions {
  /**
   * The default-deny allowlist. Only `(model, column)` pairs listed here are
   * eligible for capture; an empty or unset list captures nothing. The
   * server-side per-tenant allowlist re-enforces this independently at
   * ingestion.
   */
  allow?: ReadonlyArray<PrismaCaptureColumn>;
  /**
   * The default-deny aggregate-result allowlist (see
   * {@link PrismaAggregateCaptureEntry}). Absence is an empty allowlist:
   * `count` and `aggregate` results are captured only for selectors listed
   * here, only when the server-derived result-evidence capability grants
   * aggregate scalars, and only as complete provider-neutral evidence
   * bundles. `findMany` and every other operation remain unaffected by this
   * list.
   */
  aggregateAllow?: ReadonlyArray<PrismaAggregateCaptureEntry>;
}

const TRACER_NAME = "glasstrace-prisma";

/**
 * Prisma operations whose documented result contract is one model record (or
 * `null` for a non-throwing read miss). This positive set is intentionally
 * closed: new or non-record operations remain inert until explicitly
 * reviewed, rather than becoming eligible because their JavaScript result
 * happens to resemble a row.
 */
const SINGLE_RECORD_RESULT_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "create",
  "update",
  "upsert",
  "delete",
]);

/**
 * ASCII name grammar for aggregate-selector model and concrete field names.
 * `_all` is the only sentinel admitted outside this grammar.
 */
const AGGREGATE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The closed aggregate buckets an entry may name. */
const AGGREGATE_BUCKETS: ReadonlySet<string> = new Set([
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
]);

/**
 * Maximum raw positions inspected across one `aggregateAllow` container —
 * the total across the whole policy, not per model, operation, or entry. A
 * private producer inspection budget, deliberately distinct from (and never
 * imported as) the public per-row protocol bound that shares the number.
 * Position 257 fails the whole policy closed rather than truncating it.
 */
const MAX_AGGREGATE_POLICY_RAW_POSITIONS = 256;

/** Maximum distinct valid selectors per model + operation bucket. */
const MAX_AGGREGATE_SELECTORS_PER_BUCKET = 16;

/** A compiled, validated aggregate selector. */
interface AggregateSelector {
  readonly aggregate: PrismaAggregateCaptureEntry["aggregate"];
  readonly field: string;
  readonly key: string;
}

/**
 * Compiled Phase 1 policy: `model → operation → ordered selectors`. `null`
 * means the whole `aggregateAllow` policy failed closed (unsafe
 * observation or the raw-position budget); an absent bucket means no
 * admission for that model + operation.
 */
type AggregatePolicy = ReadonlyMap<
  string,
  ReadonlyMap<"count" | "aggregate", ReadonlyArray<AggregateSelector>>
>;

/**
 * Fully-discriminated own-property observation without invoking accessors
 * or touching the prototype chain: `data` (an own data property, value
 * attached), `absent` (no own property), `accessor` (an own
 * accessor-backed property — never invoked), or `unreadable` (the
 * descriptor lookup itself threw: a hostile or revoked proxy).
 */
type OwnPropertyObservation =
  | { readonly kind: "data"; readonly value: unknown }
  | { readonly kind: "absent" }
  | { readonly kind: "accessor" }
  | { readonly kind: "unreadable" };

function describeOwnProperty(
  container: object,
  property: string | number,
): OwnPropertyObservation {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, property);
  } catch {
    return { kind: "unreadable" };
  }
  if (descriptor === undefined) return { kind: "absent" };
  // Descriptor kind follows the spec's field shape: a descriptor carries
  // either value/writable or get/set, and an accessor whose hooks are both
  // undefined is still an accessor (it has no value to observe).
  if ("get" in descriptor || "set" in descriptor) {
    return { kind: "accessor" };
  }
  return { kind: "data", value: descriptor.value };
}

/**
 * Read one own **data** property without invoking accessors or touching the
 * prototype chain. Returns `{ present: false }` for a missing or inherited
 * property and `null` for an accessor-backed property or a container whose
 * descriptor lookup throws (a hostile or revoked proxy) — the caller treats
 * `null` as an unsafe-observation signal.
 */
function readOwnDataProperty(
  container: object,
  property: string | number,
): { present: boolean; value?: unknown } | null {
  const observed = describeOwnProperty(container, property);
  switch (observed.kind) {
    case "data":
      return { present: true, value: observed.value };
    case "absent":
      return { present: false };
    default:
      return null;
  }
}

/**
 * Observe an array container's `length` through the same own-data
 * descriptor path as every other read under the bounded observation
 * contract, so no observation of an externally supplied container goes
 * through a plain property get. Returns the length as a non-negative
 * safe integer, or `null` when the observation is unsafe (throwing,
 * accessor-shaped, or absent) or the value is out of contract.
 */
function readOwnArrayLength(container: object): number | null {
  const read = readOwnDataProperty(container, "length");
  if (read === null || !read.present) return null;
  const length = read.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return null;
  }
  return length;
}

/**
 * Record an omission counter under the operation's already-admitted config
 * view. A family producer holds one immutable view across the awaited
 * query, and every part of its emission — scalars, bundle metadata, and
 * omission counters — must ride that same snapshot: `captureOmission`
 * re-resolves the live config, which a mid-query refresh may have changed,
 * splitting one bundle across two configs. Guards mirror `captureOmission`
 * minus the live-config gate. Never throws.
 */
function recordViewOmission(
  span: Span,
  reason: SideEffectOmissionReason,
): void {
  try {
    if (typeof span.isRecording === "function" && !span.isRecording()) {
      return;
    }
    recordOmission(span, reason);
  } catch {
    // Capture work must never propagate to the host path.
  }
}

/**
 * Compile the `aggregateAllow` list into the Phase 1 policy under the
 * bounded, hostile-safe observation contract:
 *
 *  - every read is an own-data-property read — an accessor-backed or
 *    inherited entry (or entry member), a non-array container, a throwing
 *    or revoked proxy, or the raw-position budget overflowing fails the
 *    WHOLE policy closed (`null`), never silently widening or truncating;
 *  - a plain-data entry that is merely invalid (bad name grammar, unknown
 *    operation/aggregate, a non-`_count` bucket on `count`, a key outside
 *    the numeric scalar grammar) is dropped, default-deny;
 *  - byte-identical duplicate entries collapse to their first occurrence;
 *    a conflicting selector (same model/operation/aggregate/field with a
 *    different key) or a duplicate output key within one model + operation
 *    fails that bucket closed;
 *  - more than 16 distinct valid selectors in one model + operation bucket
 *    fails that bucket closed rather than truncating.
 */
function compileAggregatePolicy(
  aggregateAllow: ReadonlyArray<PrismaAggregateCaptureEntry> | undefined,
): AggregatePolicy | null {
  if (aggregateAllow === undefined) return new Map();
  if (!Array.isArray(aggregateAllow)) return null;

  let rawPositions = 0;
  interface BucketState {
    selectors: AggregateSelector[];
    selectorKeys: Map<string, string>;
    outputKeys: Set<string>;
    invalid: boolean;
  }
  const buckets = new Map<
    string,
    Map<"count" | "aggregate", BucketState>
  >();

  const length = readOwnArrayLength(aggregateAllow);
  if (length === null) return null;

  for (let index = 0; index < length; index += 1) {
    rawPositions += 1;
    if (rawPositions > MAX_AGGREGATE_POLICY_RAW_POSITIONS) return null;
    const slot = readOwnDataProperty(aggregateAllow, index);
    if (slot === null) return null;
    // A hole is a missing own position — not admissible as a selector, and
    // not distinguishable from tampering; fail the policy closed.
    if (!slot.present) return null;
    const entry = slot.value;
    if (entry === null || typeof entry !== "object") {
      // A plain non-object position is an invalid entry: default-deny drop.
      continue;
    }
    // Each of the five members is read as an own data property; an
    // accessor-backed or throwing member is unsafe observation, and so is a
    // member that is absent as own data but present on the prototype chain
    // (an inherited entry member) — a genuinely absent member merely makes
    // the entry invalid (default-deny drop). The inherited check is a
    // single guarded `in` probe: inheritance is not observable through
    // own-data reads, `in` invokes no accessors on genuine objects, and
    // only a `false` answer — worth exactly an honestly absent member —
    // avoids voiding. A descriptor-based prototype walk would be
    // unbounded under a hostile `getPrototypeOf` trap.
    const members: Record<string, unknown> = {};
    let unsafe = false;
    for (const member of ["model", "operation", "aggregate", "field", "key"]) {
      rawPositions += 1;
      if (rawPositions > MAX_AGGREGATE_POLICY_RAW_POSITIONS) return null;
      const read = readOwnDataProperty(entry, member);
      if (read === null) {
        unsafe = true;
        break;
      }
      if (!read.present) {
        let inherited: boolean;
        try {
          inherited = member in entry;
        } catch {
          inherited = true;
        }
        if (inherited) {
          unsafe = true;
          break;
        }
        members[member] = undefined;
        continue;
      }
      members[member] = read.value;
    }
    if (unsafe) return null;

    const { model, operation, aggregate, field, key } = members;
    if (
      typeof model !== "string" ||
      typeof operation !== "string" ||
      typeof aggregate !== "string" ||
      typeof field !== "string" ||
      typeof key !== "string"
    ) {
      continue;
    }
    if (!AGGREGATE_NAME_PATTERN.test(model)) continue;
    if (operation !== "count" && operation !== "aggregate") continue;
    if (!AGGREGATE_BUCKETS.has(aggregate)) continue;
    if (operation === "count" && aggregate !== "_count") continue;
    // `_all` is the only sentinel, and only the `_count` bucket has it; the
    // other buckets require a concrete field.
    if (field === "_all" && aggregate !== "_count") continue;
    if (field !== "_all" && !AGGREGATE_NAME_PATTERN.test(field)) continue;
    // The output key obeys the unchanged scalar grammar and its shared cap,
    // restricted to the Phase 1 numeric suffixes.
    if (!isSideEffectScalarKey(key)) continue;
    if (!/(Ms|Amount|Bytes|Ratio|Value)$/.test(key) || /Id$|Flag$/.test(key)) {
      continue;
    }

    let operations = buckets.get(model);
    if (!operations) {
      operations = new Map();
      buckets.set(model, operations);
    }
    let bucket = operations.get(operation);
    if (!bucket) {
      bucket = {
        selectors: [],
        selectorKeys: new Map(),
        outputKeys: new Set(),
        invalid: false,
      };
      operations.set(operation, bucket);
    }
    if (bucket.invalid) continue;

    // The dot separator is unambiguous: neither an aggregate bucket name
    // nor a field under the ASCII grammar can contain one.
    const selectorId = `${aggregate}.${field}`;
    const existingKey = bucket.selectorKeys.get(selectorId);
    if (existingKey !== undefined) {
      if (existingKey === key) continue; // byte-identical duplicate collapses
      bucket.invalid = true; // conflicting selector
      continue;
    }
    if (bucket.outputKeys.has(key)) {
      bucket.invalid = true; // duplicate output key
      continue;
    }
    if (bucket.selectors.length >= MAX_AGGREGATE_SELECTORS_PER_BUCKET) {
      bucket.invalid = true; // over-limit fails closed, never truncates
      continue;
    }
    bucket.selectorKeys.set(selectorId, key);
    bucket.outputKeys.add(key);
    bucket.selectors.push({
      aggregate: aggregate as AggregateSelector["aggregate"],
      field,
      key,
    });
  }

  const policy = new Map<
    string,
    Map<"count" | "aggregate", AggregateSelector[]>
  >();
  for (const [model, operations] of buckets) {
    for (const [operation, bucket] of operations) {
      if (bucket.invalid || bucket.selectors.length === 0) continue;
      let admitted = policy.get(model);
      if (!admitted) {
        admitted = new Map();
        policy.set(model, admitted);
      }
      admitted.set(operation, bucket.selectors);
    }
  }
  return policy;
}

/**
 * Maximum raw positions inspected when compiling the bounded-row policy
 * from the public `allow` list — a private producer inspection budget over
 * the whole policy container (slot plus three member reads per entry),
 * deliberately distinct from (and never imported as) the public per-row
 * protocol bound sharing the number. Overflow fails the whole bounded-row
 * policy closed rather than truncating it. The legacy single-record
 * compile of the same list is untouched.
 */
const MAX_ROW_POLICY_RAW_POSITIONS = 256;

/**
 * Maximum scalar-projection attempts across one bounded-row operation
 * (`A`). A private producer bound, not a wire export.
 */
const MAX_ROW_PROJECTION_ATTEMPTS = 32;

/** One compiled bounded-row column: configured order is preserved. */
interface RowColumn {
  readonly column: string;
  readonly intent: ScalarIntent;
  readonly baseKey: string;
}

/**
 * Compiled bounded-row policy: `model → configured columns`. `null` means
 * the whole policy failed closed (unsafe observation or the raw-position
 * budget); a model absent from the map — including one voided by an
 * invalid name, intent, or derived-key collision — admits nothing.
 */
type RowPolicy = ReadonlyMap<string, ReadonlyArray<RowColumn>>;

/**
 * Compile the bounded-row (`findMany`) policy from the existing public
 * `allow` list under the same hostile-safe bounded observation contract as
 * the aggregate policy — without changing legacy single-record
 * compilation, which reads the same list independently:
 *
 *  - every read is an own-data-property read under the private
 *    raw-position budget; an accessor-backed, inherited, or throwing
 *    member, a non-array container, an array hole, a revoked proxy, or
 *    budget overflow fails the WHOLE bounded-row policy closed;
 *  - a model or column name outside the ASCII `[A-Za-z][A-Za-z0-9_]{0,63}`
 *    grammar (a new bounded-row admission constraint — legacy admission
 *    still accepts any non-empty string), an out-of-contract intent, a
 *    derived key failing the unchanged 80-character scalar grammar, a
 *    derived-key collision, or conflicting duplicate columns voids that
 *    MODEL's bounded-row policy (fail-closed, never widened); an entry
 *    that is not an object is ignored, mirroring legacy behavior;
 *  - byte-identical duplicate columns collapse to their first occurrence,
 *    preserving configured-column order.
 */
function compileRowPolicy(
  allow: ReadonlyArray<PrismaCaptureColumn> | undefined,
): RowPolicy | null {
  if (allow === undefined) return new Map();
  if (!Array.isArray(allow)) return null;

  let rawPositions = 0;
  interface ModelState {
    columns: RowColumn[];
    intents: Map<string, ScalarIntent>;
    baseKeys: Set<string>;
    invalid: boolean;
  }
  const models = new Map<string, ModelState>();

  const length = readOwnArrayLength(allow);
  if (length === null) return null;

  for (let index = 0; index < length; index += 1) {
    rawPositions += 1;
    if (rawPositions > MAX_ROW_POLICY_RAW_POSITIONS) return null;
    const slot = readOwnDataProperty(allow, index);
    if (slot === null) return null;
    if (!slot.present) return null; // an array hole is indistinguishable from tampering
    const entry = slot.value;
    if (entry === null || typeof entry !== "object") continue;

    // Own-data member reads, then a single guarded `in` probe to
    // distinguish genuinely-absent from inherited — inheritance is not
    // observable through own-data reads. `in` invokes no accessors on
    // genuine objects, only a `false` answer — worth exactly an honestly
    // absent member — avoids voiding, and a descriptor-based prototype
    // walk would be unbounded under a hostile `getPrototypeOf` trap.
    const members: Record<string, unknown> = {};
    let unsafe = false;
    for (const member of ["model", "column", "as"]) {
      rawPositions += 1;
      if (rawPositions > MAX_ROW_POLICY_RAW_POSITIONS) return null;
      const read = readOwnDataProperty(entry, member);
      if (read === null) {
        unsafe = true;
        break;
      }
      if (!read.present) {
        let inherited: boolean;
        try {
          inherited = member in entry;
        } catch {
          inherited = true;
        }
        if (inherited) {
          unsafe = true;
          break;
        }
        members[member] = undefined;
        continue;
      }
      members[member] = read.value;
    }
    if (unsafe) return null;

    const { model, column } = members;
    if (typeof model !== "string" || typeof column !== "string") continue;

    let state = models.get(model);
    if (!state) {
      state = { columns: [], intents: new Map(), baseKeys: new Set(), invalid: false };
      models.set(model, state);
    }
    if (state.invalid) continue;

    // The bounded-row name guard is NEW admission for this path only.
    if (
      !AGGREGATE_NAME_PATTERN.test(model) ||
      !AGGREGATE_NAME_PATTERN.test(column)
    ) {
      state.invalid = true;
      continue;
    }
    const rawIntent = members.as;
    const intent = rawIntent === undefined ? "flag" : rawIntent;
    if (
      typeof intent !== "string" ||
      !SCALAR_INTENTS.includes(intent as ScalarIntent)
    ) {
      state.invalid = true;
      continue;
    }
    const baseKey = deriveScalarKey(column, intent as ScalarIntent);
    if (!isSideEffectScalarKey(baseKey)) {
      state.invalid = true;
      continue;
    }

    const existingIntent = state.intents.get(column);
    if (existingIntent !== undefined) {
      if (existingIntent === intent) continue; // byte-identical duplicate collapses
      state.invalid = true; // conflicting duplicate column
      continue;
    }
    if (state.baseKeys.has(baseKey)) {
      state.invalid = true; // derived-key collision
      continue;
    }
    state.intents.set(column, intent as ScalarIntent);
    state.baseKeys.add(baseKey);
    state.columns.push({ column, intent: intent as ScalarIntent, baseKey });
  }

  const policy = new Map<string, RowColumn[]>();
  for (const [model, state] of models) {
    if (state.invalid || state.columns.length === 0) continue;
    policy.set(model, state.columns);
  }
  return policy;
}

/** A candidate value snapshotted synchronously before any async work. */
interface RowCandidate {
  readonly rowIndex: number;
  readonly baseKey: string;
  readonly intent: ScalarIntent;
  readonly value: unknown;
}

/**
 * Project an admitted `findMany` result onto the owned span as one
 * complete family-3 bounded-row bundle — or nothing at all.
 *
 * Bounded, deterministic, and mutation-safe:
 *
 *  - only an array result is eligible; the returned length and the first
 *    `min(length, 8)` positions are snapshotted without mutating or
 *    replacing anything, and an empty array is observationally inert (no
 *    family, no `rows_total: 0` claim);
 *  - a selected row must be a non-null, non-array object; an unsupported
 *    container/row shape or an unreadable observation (a throwing or
 *    revoked proxy anywhere) makes the family inert;
 *  - only configured own data properties are considered — accessors are
 *    never invoked and prototypes never traversed; per-row `candidates`
 *    counts exactly those present own data properties, and every
 *    candidate value is snapshotted before the first asynchronous step so
 *    later result mutation cannot change emitted evidence;
 *  - projection attempts run in configured-column order with `rowIndex`
 *    ascending within each column, capped at 32 attempts per operation;
 *    at most the first 16 successfully prepared values commit, in that
 *    deterministic order; a failed value records a bounded omission and
 *    never consumes a scalar slot, and work stops once remaining outcomes
 *    cannot affect the bounded result;
 *  - values follow the established rules per intent: `flag` native
 *    booleans; numeric intents finite native numbers under the
 *    safe-integer rule and the magnitude-only timestamp screen; `id` the
 *    established `gthid_` hashing under this operation's coherent
 *    fidelity/key view (silent under any other posture, an `unhashed_id`
 *    omission when `full` has no usable key or the id is not hashable);
 *  - `rowIndex` is the original returned-array position only — never
 *    hashed, never reused for another row;
 *  - the bundle attaches best-effort in two ordered writes: cardinality
 *    metadata (`rows_total` = snapshotted length, `row_cap` = 8,
 *    `rows_selected`, `rows_emitted` = rows with at least one committed
 *    scalar), contiguous per-row `candidates`/`emitted` producer metadata
 *    for every selected row, and every committed row scalar first — then
 *    the family-3 marker as its own final call, so a truncated or
 *    interrupted bundle always loses its marker and fails closed at the
 *    receiver. Receiver-owned keys are never emitted. If no scalar
 *    commits, nothing is emitted at all.
 */
async function projectBoundedRows(
  span: Span,
  columns: ReadonlyArray<RowColumn>,
  result: unknown,
  view: OperationConfigView,
): Promise<void> {
  if (!Array.isArray(result)) return;
  const length = readOwnArrayLength(result);
  if (length === null || length <= 0 || length > 0xffff_ffff) {
    return;
  }
  const rowsSelected = Math.min(length, MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION);

  // Synchronous snapshot of the selected rows and every configured
  // candidate value — completed before any asynchronous preparation.
  const rows: Array<Record<string, unknown>> = [];
  for (let rowIndex = 0; rowIndex < rowsSelected; rowIndex += 1) {
    const slot = describeOwnProperty(result, rowIndex);
    if (slot.kind !== "data") return; // hole, accessor element, or unreadable
    const row = slot.value;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return;
    }
    rows.push(row as Record<string, unknown>);
  }

  // Identifier capture is decided by this operation's immutable view, so
  // under any posture other than `full` every id candidate is known-dead
  // before an attempt is made. Dead id candidates stay out of the attempt
  // stream so they cannot starve viable columns of the fixed attempt
  // budget; they still count toward per-row `candidates` metadata, which
  // reports configured fields present as own data properties.
  const idCaptureEnabled = view.captureFidelity === "full";

  const candidatesPerRow = new Array<number>(rowsSelected).fill(0);
  // Column-major deterministic order: configured-column order, rowIndex
  // ascending within each column.
  const candidates: RowCandidate[] = [];
  for (const rowColumn of columns) {
    for (let rowIndex = 0; rowIndex < rowsSelected; rowIndex += 1) {
      const observed = describeOwnProperty(rows[rowIndex], rowColumn.column);
      if (observed.kind === "unreadable") return; // hostile row
      if (observed.kind !== "data") continue; // absent or accessor: no candidate
      candidatesPerRow[rowIndex] += 1;
      if (rowColumn.intent === "id" && !idCaptureEnabled) continue;
      candidates.push({
        rowIndex,
        baseKey: rowColumn.baseKey,
        intent: rowColumn.intent,
        value: observed.value,
      });
    }
  }

  // Deterministic preparation under the attempt and scalar caps.
  const committedScalars: Record<string, number | boolean | string> = {};
  const emittedPerRow = new Array<number>(rowsSelected).fill(0);
  let committed = 0;
  let attempts = 0;
  for (const candidate of candidates) {
    if (committed >= MAX_SIDE_EFFECT_SCALARS_PER_OPERATION) break;
    if (attempts >= MAX_ROW_PROJECTION_ATTEMPTS) break;
    attempts += 1;

    let prepared: number | boolean | string | null = null;
    if (candidate.intent === "flag") {
      if (typeof candidate.value === "boolean") {
        prepared = candidate.value;
      } else {
        recordViewOmission(span, "raw_payload");
      }
    } else if (candidate.intent === "id") {
      // Identifier capture follows the operation's coherent view — only
      // `full`-fidelity candidates reach this point (dead id candidates
      // were excluded at collection) — and fails closed with a visible
      // omission when `full` has no usable key or the id is not hashable.
      const hmacKey = view.readAttrHmacKey();
      const raw =
        typeof candidate.value === "string" ||
        typeof candidate.value === "number"
          ? String(candidate.value)
          : "";
      if (raw.length > 0 && typeof hmacKey === "string" && hmacKey.length > 0) {
        const token = await hashIdWeb(raw, hmacKey);
        if (token !== null) {
          prepared = token;
        } else {
          recordViewOmission(span, "unhashed_id");
        }
      } else {
        recordViewOmission(span, "unhashed_id");
      }
    } else {
      const value = candidate.value;
      if (typeof value !== "number") {
        recordViewOmission(span, "raw_payload");
      } else if (!Number.isFinite(value)) {
        recordViewOmission(span, "non_finite");
      } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        recordViewOmission(span, "raw_payload");
      } else if (
        isResultEvidenceTimestampShapedNumeric(candidate.baseKey, value)
      ) {
        recordViewOmission(span, "raw_timestamp");
      } else {
        prepared = value;
      }
    }

    if (prepared === null) continue;
    const scalarKey = buildResultEvidenceRowScalarKey(
      candidate.rowIndex,
      candidate.baseKey,
    );
    if (scalarKey === null) continue; // defensive: inputs are pre-validated
    committedScalars[scalarKey] = prepared;
    emittedPerRow[candidate.rowIndex] += 1;
    committed += 1;
  }

  if (committed === 0) return;

  // Cardinality metadata never stands alone and the marker attaches LAST
  // as its own ordered write (see the aggregate bundle for the rationale):
  // any truncation or interruption that removes part of the bundle
  // necessarily removes the marker, so the surviving remainder is
  // marker-less and the receiver strips it.
  const bundle: Record<string, number | boolean | string> = {
    [RESULT_EVIDENCE_ROWS_TOTAL_ATTRIBUTE_KEY]: length,
    [RESULT_EVIDENCE_ROW_CAP_ATTRIBUTE_KEY]:
      MAX_RESULT_EVIDENCE_ROWS_PER_OPERATION,
    [RESULT_EVIDENCE_ROWS_SELECTED_ATTRIBUTE_KEY]: rowsSelected,
    [RESULT_EVIDENCE_ROWS_EMITTED_ATTRIBUTE_KEY]: emittedPerRow.filter(
      (count) => count > 0,
    ).length,
  };
  for (let rowIndex = 0; rowIndex < rowsSelected; rowIndex += 1) {
    const candidatesKey = buildResultEvidenceProducerRowMetadataKey(
      rowIndex,
      "candidates",
    );
    const emittedKey = buildResultEvidenceProducerRowMetadataKey(
      rowIndex,
      "emitted",
    );
    if (candidatesKey === null || emittedKey === null) return; // defensive
    bundle[candidatesKey] = candidatesPerRow[rowIndex];
    bundle[emittedKey] = emittedPerRow[rowIndex];
  }
  Object.assign(bundle, committedScalars);
  try {
    span.setAttributes(bundle);
    span.setAttribute(RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY, 3);
  } catch {
    // Attribute failure leaves the family inert; the receiver's
    // completeness validation drops any partial write.
  }
}

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
 * Admit one aggregate-result candidate value under the Phase 1 value rules:
 * `_count` values are nonnegative safe integers; other buckets accept
 * finite native numbers whose integer shapes stay within safe-integer
 * range; and every accepted candidate passes the provider-neutral
 * timestamp-shape screen for its key. Everything else — `null`, `BigInt`,
 * `Decimal`-like objects, strings, booleans, dates, arrays, objects,
 * non-finite or unsafe numbers — is rejected with a bounded omission
 * reason and never emitted.
 */
function admitAggregateValue(
  key: string,
  aggregate: AggregateSelector["aggregate"],
  value: unknown,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: "raw_payload" | "non_finite" | "raw_timestamp" } {
  if (typeof value !== "number") return { ok: false, reason: "raw_payload" };
  if (!Number.isFinite(value)) return { ok: false, reason: "non_finite" };
  if (aggregate === "_count") {
    if (!Number.isSafeInteger(value) || value < 0) {
      return { ok: false, reason: "raw_payload" };
    }
  } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return { ok: false, reason: "raw_payload" };
  }
  if (isResultEvidenceTimestampShapedNumeric(key, value)) {
    return { ok: false, reason: "raw_timestamp" };
  }
  return { ok: true, value };
}

/**
 * Project an admitted `count` / `aggregate` result onto the owned span as
 * one complete provider-neutral evidence bundle (family `1` for count, `2`
 * for aggregate) — or nothing at all.
 *
 * Observation is explicit and bounded: only the values the admitted
 * selectors name are read, every read is an own-data-property read (no
 * accessor invocation, no prototype traversal), and a missing, inherited,
 * or accessor-backed value is inert for that selector. Mapping rules:
 *
 *  - count `_all` — a bare numeric result, or the result's own `_all`
 *    count property;
 *  - count concrete field — only the result's own flat count property of
 *    that name;
 *  - aggregate `_count` — the named own field of an own non-array `_count`
 *    bucket; the `_count._all` exception also admits an own `_count`
 *    bucket that is itself a number;
 *  - aggregate `_avg` / `_sum` / `_min` / `_max` — the named concrete own
 *    field of an own non-array object bucket.
 *
 * The bundle attaches best-effort in two ordered writes — every prepared
 * scalar, then the family marker as a separate final call — and only when
 * at least one scalar prepared. Marker-last is a program-level ordering
 * guarantee: any truncation by a host span-attribute limit (or a throwing
 * sink) that removes part of the bundle necessarily removes the marker
 * too, so the surviving scalar remainder is marker-less and the receiver
 * strips it rather than retaining a marked partial family, with
 * receiver-side completeness validation as the transport backstop.
 */
function projectAggregateResult(
  span: Span,
  operation: "count" | "aggregate",
  selectors: ReadonlyArray<AggregateSelector>,
  result: unknown,
): void {
  const prepared: Record<string, number> = {};
  let preparedCount = 0;

  for (const selector of selectors) {
    let candidate: { present: boolean; value?: unknown } | null = null;

    if (operation === "count") {
      if (selector.field === "_all") {
        if (typeof result === "number") {
          candidate = { present: true, value: result };
        } else if (
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result)
        ) {
          candidate = readOwnDataProperty(result, "_all");
        }
      } else if (
        result !== null &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        candidate = readOwnDataProperty(result, selector.field);
      }
    } else {
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result)
      ) {
        candidate = { present: false };
      } else {
        const bucket = readOwnDataProperty(result, selector.aggregate);
        if (bucket === null || !bucket.present) {
          candidate = bucket;
        } else if (
          selector.aggregate === "_count" &&
          selector.field === "_all" &&
          typeof bucket.value === "number"
        ) {
          // The accepted `_count._all` exception: the own `_count` bucket
          // may itself be the number.
          candidate = { present: true, value: bucket.value };
        } else if (
          bucket.value !== null &&
          typeof bucket.value === "object" &&
          !Array.isArray(bucket.value)
        ) {
          candidate = readOwnDataProperty(bucket.value, selector.field);
        } else {
          candidate = { present: false };
        }
      }
    }

    // A missing, inherited, or unsafely observable value is inert for this
    // selector — no value, no counter (matching the single-record path's
    // missing-column behavior). Only a present-but-invalid value records a
    // bounded omission.
    if (candidate === null || !candidate.present) continue;
    const admitted = admitAggregateValue(
      selector.key,
      selector.aggregate,
      candidate.value,
    );
    if (!admitted.ok) {
      recordViewOmission(span, admitted.reason);
      continue;
    }
    prepared[`${SIDE_EFFECT_SCALAR_PREFIX}${selector.key}`] = admitted.value;
    preparedCount += 1;
  }

  if (preparedCount === 0) return;
  // One best-effort logical bundle in two ORDERED writes: every scalar
  // first, then the family marker as its own second call. Sequencing the
  // marker in a separate call makes marker-last a program guarantee rather
  // than a provider detail (the OTel API does not promise any particular
  // key-iteration order within one `setAttributes` call). Earlier scalars
  // may survive a mid-bundle truncation, but any truncation by a
  // host-configured span attribute-count limit — or a cut caused by a
  // throwing sink — that removes part of the bundle necessarily removes
  // the marker too; the receiver then strips the marker-less remainder
  // instead of retaining a shape-valid partial family as complete.
  try {
    span.setAttributes(prepared);
    span.setAttribute(
      RESULT_EVIDENCE_FAMILY_ATTRIBUTE_KEY,
      operation === "count" ? 1 : 2,
    );
  } catch {
    // Attribute failure leaves the family inert; the host query result is
    // unaffected and receiver completeness validation drops any partial.
  }
}

/**
 * Project every own allowlisted column present in an eligible single-record
 * result onto the owned span via {@link capture}. The operation boundary is
 * enforced by the caller; the non-object and array guards remain as defense
 * in depth for read misses and unexpected client/runtime shapes. Inherited
 * properties are ignored. The caller fences all projection work so a
 * malformed result (including a throwing proxy or accessor) can never affect
 * the query outcome.
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
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    const key = deriveScalarKey(column, intent);
    if (intent === "id") {
      await projectIdentifier(span, key, row[column]);
    } else {
      capture(key, row[column], { span });
    }
  }
}

/**
 * Build a passive Prisma value-capture extension: single-record value
 * capture (`allow`) for `findUnique`, `findUniqueOrThrow`, `findFirst`,
 * `findFirstOrThrow`, `create`, `update`, `upsert`, and `delete` results;
 * explicit aggregate-result capture (`aggregateAllow`) for `count` and
 * `aggregate` results; and bounded-row result capture for `findMany` on
 * models named by `allow`, under the server-granted bounded-rows
 * result-evidence capability (at most 8 rows, the shared 16-scalar
 * ceiling). Operations named by neither allowlist — and every group,
 * bulk, raw, or unknown operation — execute normally and open no owned
 * value-capture span.
 */
export function prismaAdapter(
  options: PrismaAdapterOptions = {},
): PrismaCaptureExtension {
  // Compile the Phase 1 aggregate policy once at construction under the
  // bounded hostile-safe observation contract. `null` means the whole
  // aggregateAllow policy failed closed and admits nothing.
  let aggregatePolicy: AggregatePolicy | null;
  try {
    aggregatePolicy = compileAggregatePolicy(options?.aggregateAllow);
  } catch {
    aggregatePolicy = null;
  }

  // Compile the bounded-row (`findMany`) policy from the same public
  // `allow` list, independently of the legacy compile below and under the
  // stricter bounded-row admission contract. `null` admits nothing.
  let rowPolicy: RowPolicy | null;
  try {
    rowPolicy = compileRowPolicy(options?.allow);
  } catch {
    rowPolicy = null;
  }

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

          // Bounded-row result path: an EXPLICIT `findMany` selection via
          // the model's compiled bounded-row policy, admitted under one
          // coherent per-operation config view — the master capture
          // switch, result-evidence wire version 1 with the bounded-rows
          // capability granted, and a recording request span. A later
          // config refresh or key rotation applies to the next operation.
          // The query callback runs exactly once with its original
          // arguments (never inspected), and the result and any error
          // pass through verbatim; no other list-returning operation is
          // ever eligible through this path.
          if (
            operation === "findMany" &&
            model !== undefined &&
            rowPolicy !== null
          ) {
            const rowColumns = rowPolicy.get(model);
            if (rowColumns !== undefined) {
              const view = getOperationConfigView();
              if (
                !view.sideEffectEvidence ||
                view.resultEvidence.wireVersion !== 1 ||
                !view.resultEvidence.boundedRows ||
                !hasRecordingActiveSpan()
              ) {
                return query(args);
              }
              // Span-volume gate mirroring the legacy id-only rule: a
              // model whose bounded-row policy is entirely id-intent
              // captures nothing under any posture other than `full`, so
              // opening a span would be pure overhead.
              if (
                view.captureFidelity !== "full" &&
                !rowColumns.some((rowColumn) => rowColumn.intent !== "id")
              ) {
                return query(args);
              }
              const span = openOwnedSpan(model, operation);
              if (span === undefined) {
                return query(args);
              }
              try {
                const result = await query(args);
                // Fence all projection work: a malformed or hostile
                // result can never alter the query's own outcome.
                try {
                  await projectBoundedRows(span, rowColumns, result, view);
                } catch {
                  // Capture failure leaves the evidence inert.
                }
                return result;
              } finally {
                try {
                  span.end();
                } catch {
                  // OTel end() failure must not surface to the host query.
                }
              }
            }
            return query(args);
          }

          // Phase 1 aggregate-result path: an EXPLICIT count/aggregate
          // selector bucket for this model, admitted under one coherent
          // per-operation config view. Admission requires the master
          // capture switch, result-evidence wire version 1 with the
          // aggregate-scalars capability granted, and a recording request
          // span; a later config refresh applies to the next operation.
          // Everything else about the operation is untouched: the query
          // callback runs exactly once with its original arguments (never
          // inspected), and the result and any error pass through verbatim.
          if (
            (operation === "count" || operation === "aggregate") &&
            model !== undefined &&
            aggregatePolicy !== null
          ) {
            const selectors = aggregatePolicy.get(model)?.get(operation);
            if (selectors !== undefined) {
              const view = getOperationConfigView();
              if (
                !view.sideEffectEvidence ||
                view.resultEvidence.wireVersion !== 1 ||
                !view.resultEvidence.aggregateScalars ||
                !hasRecordingActiveSpan()
              ) {
                return query(args);
              }
              const span = openOwnedSpan(model, operation);
              if (span === undefined) {
                return query(args);
              }
              try {
                const result = await query(args);
                // Fence all projection work: a malformed or hostile result
                // can never alter the query's own outcome.
                try {
                  projectAggregateResult(span, operation, selectors, result);
                } catch {
                  // Capture failure leaves the evidence inert.
                }
                return result;
              } finally {
                try {
                  span.end();
                } catch {
                  // OTel end() failure must not surface to the host query.
                }
              }
            }
            return query(args);
          }

          // Decide eligibility BEFORE opening a span so the default-deny /
          // disabled path adds zero span volume (hot-path) and never emits
          // on an orphan (edge / no request context). All four gates:
          //  - the model has an allow entry (default-deny);
          //  - the operation is one of the eight explicit single-record
          //    result operations. The literal `findMany` exclusion remains a
          //    visible defense for the established list boundary; all other
          //    count, aggregate, group, list, bulk, raw, and unknown
          //    operations fail closed through the positive-set check;
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
            !SINGLE_RECORD_RESULT_OPERATIONS.has(operation) ||
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
